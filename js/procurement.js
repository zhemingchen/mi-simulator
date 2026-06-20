/**
 * 采购：按日独立 PO，不合并；考虑原料安全库存
 */

import { getRaw } from './inventory.js';
import { addDays, formatDate, parseDate } from './scheduler.js';
import { applySupplierDelayToPo } from './supplier-policy.js';

let poSeq = 0;

export function createProcurementState() {
  return {
    /** @type {Array<{id:string,materialId:number,qty:number,orderDate:string,arriveDate:string,demandDate:string,cancelled:boolean}>} */
    orders: [],
  };
}

export function resetPoSeq() {
  poSeq = 0;
}

export function getPoSeq() {
  return poSeq;
}

export function setPoSeq(n) {
  poSeq = n;
}

/** 在途数量（已下单未到货） */
export function inTransitQty(state, materialId, asOfDate) {
  const d = formatDate(asOfDate);
  return state.orders
    .filter(
      (o) =>
        !o.cancelled &&
        !o.received &&
        o.materialId === materialId &&
        o.orderDate <= d &&
        o.arriveDate > d
    )
    .reduce((s, o) => s + o.qty, 0);
}

/**
 * 计算某日某原料下单量（按生产日领料前预计库存，仅补缺口；不含原料 SS）
 * @param projectedBefore 该日领料前的预计库存（含此前计划到货）
 */
export function calcOrderQty(consumption, projectedBefore, safetyStock = 0) {
  if (consumption <= 0) return 0;
  const ss = safetyStock ?? 0;
  const shortfall = ss + consumption - projectedBefore;
  return Math.max(0, shortfall);
}

/**
 * 是否仍可通知供应商改量：未收货且下单日尚未到达（含当日）
 * 已过下单日的 PO 受采购提前期约束，不可改量
 */
export function isPoModifiable(order, asOfDateStr) {
  return !order.cancelled && !order.received && order.orderDate >= asOfDateStr;
}

/** 查找需求日 PO（含已收货） */
function poKey(materialId, demandDate) {
  return `${materialId}@${demandDate}`;
}

function buildPoByDemandIndex(orders) {
  const index = new Map();
  for (const o of orders) {
    if (o.cancelled) continue;
    index.set(poKey(o.materialId, o.demandDate), o);
  }
  return index;
}

function findPoByDemand(poByDemand, materialId, demandDate) {
  const po = poByDemand.get(poKey(materialId, demandDate));
  return po && !po.cancelled ? po : null;
}

/** 将已发生日的「计划-实际」产量差折算为原料欠料，并入结转 */
function seedCarryFromProductionShortfall(scheduleHistory, beforeDateStr, productIds, bomIndex, carry) {
  for (const [dateStr, hist] of Object.entries(scheduleHistory ?? {})) {
    if (dateStr >= beforeDateStr) continue;
    for (const pid of productIds) {
      const gap = (hist.planned[pid] ?? 0) - (hist.actual[pid] ?? 0);
      if (gap <= 0) continue;
      for (const { materialId, qty } of bomIndex.get(pid) ?? []) {
        carry.set(materialId, (carry.get(materialId) ?? 0) + qty * gap);
      }
    }
  }
}

/** 更新结转欠料：供应不足则累加至下一需求日 */
function updateCarry(carry, materialId, required, supplied) {
  if (supplied + 1e-9 < required) {
    carry.set(materialId, required - supplied);
  } else {
    carry.set(materialId, 0);
  }
}

/** 仅当 PO 在生产日前或当日到货时，其数量可计入当日供应 */
function poQtyAvailableOnDemandDate(po, demandDateStr) {
  if (!po || po.qty <= 1e-9) return 0;
  if (po.received) return 0;
  return po.arriveDate <= demandDateStr ? po.qty : 0;
}

/**
 * 需求日 dateStr 之前已处理过的 demandDate 行，其 PO 影响已滚入 projected；
 * 尚未处理的需求日 PO 若将提前到货，计入领料前供应（避免重复下单）。
 */
function lowerBoundDate(dates, target) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildPipelineArrivalLookup(orders, demandDates) {
  const dateIndex = new Map(demandDates.map((dateStr, idx) => [dateStr, idx]));
  const diffByMaterial = new Map();

  for (const o of orders) {
    if (o.cancelled || o.received) continue;
    const demandIdx = dateIndex.get(o.demandDate);
    if (demandIdx == null || demandIdx <= 0) continue;

    const startIdx = lowerBoundDate(demandDates, o.arriveDate);
    if (startIdx >= demandIdx || startIdx >= demandDates.length) continue;

    let diff = diffByMaterial.get(o.materialId);
    if (!diff) {
      diff = new Float64Array(demandDates.length + 1);
      diffByMaterial.set(o.materialId, diff);
    }
    diff[startIdx] += o.qty;
    diff[demandIdx] -= o.qty;
  }

  const activeByMaterial = new Map();
  for (const [materialId, diff] of diffByMaterial) {
    const active = new Float64Array(demandDates.length);
    let running = 0;
    for (let i = 0; i < demandDates.length; i++) {
      running += diff[i];
      active[i] = running;
    }
    activeByMaterial.set(materialId, active);
  }

  return {
    get(materialId, demandDateStr) {
      const idx = dateIndex.get(demandDateStr);
      if (idx == null) return 0;
      return activeByMaterial.get(materialId)?.[idx] ?? 0;
    },
  };
}

/**
 * 领料前供应 = 滚动账面 + 未来需求日 PO 的提前到货 + 当日已锁定 PO（改量中的可改 PO 不计入）
 */
function supplyBeforeDemand(projected, pipelineLookup, materialId, demandDateStr, lockedPo) {
  let supply =
    (projected.get(materialId) ?? 0) + pipelineLookup.get(materialId, demandDateStr);
  if (lockedPo) {
    supply += poQtyAvailableOnDemandDate(lockedPo, demandDateStr);
  }
  return supply;
}

/**
 * 根据日排产计划生成/刷新采购订单
 * 按 (materialId, demandDate) 独立下单，不合并
 * 需求变更后：未过下单日的 PO 同步改量；已过下单日的 PO 保持原量
 */
/**
 * 原料采购：严格按可行日产量 × BOM 的生产日倒推
 * - 每种原料按各自 leadTimeDays 独立下单，避免早到堆料（如 Y 等到 X）
 * - 不使用原料侧安全库存；成品 SS 仅通过成品 MRP 排产间接产生用料需求
 */
export function syncPurchaseOrders(ctx) {
  syncProductionBacktrackPurchaseOrders(ctx);
}

/** 按 (materialId, 生产需求日) 倒推 PO：orderDate = demandDate − leadTimeDays */
function syncProductionBacktrackPurchaseOrders(ctx) {
  const {
    procurement,
    inventory,
    bomIndex,
    materialIndex,
    productIds,
    dailyPlansByDate,
    scheduleHistory,
    horizonStart,
    horizonEnd,
    leadTimeCarryUp,
    supplierPolicy,
    log,
  } = ctx;

  const startStr = formatDate(horizonStart);
  // 保留：已收货、已到货、已过下单日未收货（锁定）、以及标记取消的历史单
  procurement.orders = procurement.orders.filter(
    (o) =>
      o.cancelled ||
      o.received ||
      o.orderDate < startStr ||
      (o.arriveDate <= startStr && !o.received)
  );

  const endStr = formatDate(horizonEnd);
  const demandDates = [...dailyPlansByDate.keys()]
    .filter((d) => d >= startStr && d <= endStr)
    .sort();
  const poByDemand = buildPoByDemandIndex(procurement.orders);
  const pipelineLookup = buildPipelineArrivalLookup(procurement.orders, demandDates);

  /** 滚动投影 + 欠料结转（锁定 PO 不足部分累加至后续可改 PO） */
  const projected = new Map();
  for (const [materialId, qty] of inventory.raw) projected.set(materialId, qty);
  const carry = new Map();
  const carryUpApplied = new Set();
  seedCarryFromProductionShortfall(scheduleHistory, startStr, productIds, bomIndex, carry);

  /** 提前期缺口补单：在到货日 PO 上一次性加量（下单日 = 当前日） */
  function leadTimeCatchUpExtra(materialId, demandDateStr) {
    const extra = leadTimeCarryUp?.get(materialId) ?? 0;
    if (extra <= 1e-9 || carryUpApplied.has(materialId)) return 0;
    const mat = materialIndex.get(materialId);
    if (!mat) return 0;
    const arriveStr = formatDate(addDays(horizonStart, mat.leadTimeDays));
    if (demandDateStr !== arriveStr) return 0;
    carryUpApplied.add(materialId);
    return extra;
  }

  for (const dateStr of demandDates) {
    const plan = dailyPlansByDate.get(dateStr);
    if (!plan) continue;

    const consumption = new Map();
    for (const [productId, qty] of plan) {
      if (qty <= 0) continue;
      const lines = bomIndex.get(productId) ?? [];
      for (const { materialId, qty: perUnit } of lines) {
        consumption.set(materialId, (consumption.get(materialId) ?? 0) + perUnit * qty);
      }
    }

    for (const [materialId, baseNeed] of consumption) {
      const mat = materialIndex.get(materialId);
      if (!mat) continue;

      const before = projected.get(materialId) ?? 0;
      const backlog = carry.get(materialId) ?? 0;
      const required = baseNeed + backlog;
      const po = findPoByDemand(poByDemand, materialId, dateStr);

      let orderQty = 0;
      let supplied = before;

      if (po?.received) {
        // 当日 PO 已入库，库存已在 before 中
        supplied = before;
        updateCarry(carry, materialId, required, supplied);
        projected.set(materialId, supplied - baseNeed);
        continue;
      }

      if (po && isPoModifiable(po, startStr)) {
        const supplyForOrder = supplyBeforeDemand(projected, pipelineLookup, materialId, dateStr, null);
        const catchUp =
          supplyForOrder + 1e-9 < required ? leadTimeCatchUpExtra(materialId, dateStr) : 0;
        const targetQty = calcOrderQty(required, supplyForOrder, 0) + catchUp;
        if (targetQty <= 1e-9) {
          if (po.qty > 1e-9) {
            log?.({
              type: 'po',
              message: `取消可改 PO：原料 ${materialId}（生产日 ${dateStr}，原 ${po.qty.toFixed(2)}，库存+在途已够）`,
            });
          }
          po.cancelled = true;
          orderQty = 0;
          supplied = supplyForOrder;
        } else {
          const baseOnly = calcOrderQty(baseNeed, supplyForOrder, 0);
          if (Math.abs(po.qty - targetQty) > 1e-9) {
            const extra = targetQty - baseOnly;
            const suffix =
              extra > 1e-9
                ? catchUp > 1e-9
                  ? `，含提前期缺口补单 ${catchUp.toFixed(2)}`
                  : `，含欠料补单 ${extra.toFixed(2)}`
                : '';
            log?.({
              type: 'po',
              message: `改量 PO：原料 ${materialId} ${po.qty.toFixed(2)} → ${targetQty.toFixed(2)}（生产日 ${dateStr}，下单 ${po.orderDate}${suffix}）`,
            });
            po.qty = targetQty;
          }
          orderQty = targetQty;
          supplied = supplyForOrder + poQtyAvailableOnDemandDate(po, dateStr);
        }
      } else if (po) {
        orderQty = po.qty;
        supplied = supplyBeforeDemand(projected, pipelineLookup, materialId, dateStr, po);
      } else {
        const supplyForOrder = supplyBeforeDemand(projected, pipelineLookup, materialId, dateStr, null);
        const catchUp =
          supplyForOrder + 1e-9 < required ? leadTimeCatchUpExtra(materialId, dateStr) : 0;
        const targetQty = calcOrderQty(required, supplyForOrder, 0) + catchUp;
        if (targetQty > 1e-9) {
          orderQty = targetQty;
          const lead = mat.leadTimeDays ?? 0;
          let orderDate = formatDate(addDays(parseDate(dateStr), -lead));
          if (orderDate < startStr) orderDate = startStr;
          const actualArrive = formatDate(addDays(parseDate(orderDate), lead));
          const baseOnly = calcOrderQty(baseNeed, supplyForOrder, 0);
          const extra = targetQty - baseOnly;

          poSeq += 1;
          const newPo = {
            id: `PO-${poSeq}`,
            materialId,
            qty: orderQty,
            orderDate,
            arriveDate: actualArrive,
            demandDate: dateStr,
            cancelled: false,
            received: false,
          };
          const delayDays = applySupplierDelayToPo(newPo, lead, supplierPolicy);
          procurement.orders.push(newPo);
          poByDemand.set(poKey(materialId, dateStr), newPo);

          const delayNote =
            delayDays > 0 ? `，供应商延期 +${delayDays} 天→${newPo.arriveDate}` : '';

          if (orderDate === startStr) {
            log?.({
              type: 'po',
              message: `采购下单：原料 ${materialId} × ${orderQty.toFixed(2)}（生产日 ${dateStr}，${lead} 天周期，下单 ${orderDate}→到货 ${newPo.arriveDate}${delayNote}${catchUp > 1e-9 ? `，含缺口补单 ${catchUp.toFixed(2)}` : extra > 1e-9 ? `，含欠料补单 ${extra.toFixed(2)}` : ''}）`,
            });
          } else if (orderDate < startStr) {
            log?.({
              type: 'po',
              message: `补单（已过理想下单日 ${orderDate}）：原料 ${materialId} × ${orderQty.toFixed(2)}（生产日 ${dateStr}）`,
            });
          } else if (catchUp > 1e-9) {
            log?.({
              type: 'po',
              message: `提前期缺口补单：原料 ${materialId} × ${catchUp.toFixed(2)}（生产日 ${dateStr}，下单 ${orderDate}）`,
            });
          } else if (extra > 1e-9) {
            log?.({
              type: 'po',
              message: `欠料补单：原料 ${materialId} × ${orderQty.toFixed(2)}（生产日 ${dateStr}，结转 ${backlog.toFixed(2)}）`,
            });
          }
        }
        const activePo = findPoByDemand(poByDemand, materialId, dateStr);
        if (activePo && !activePo.cancelled) {
          supplied = supplyForOrder + poQtyAvailableOnDemandDate(activePo, dateStr);
        } else {
          supplied = supplyForOrder;
        }
      }

      updateCarry(carry, materialId, required, supplied);
      projected.set(materialId, supplied - baseNeed);
    }
  }
}

/** 处理当日及之前遗漏的到货（标记 received 防止重复入库） */
export function processArrivals(procurement, inventory, onDate, log) {
  const d = formatDate(onDate);
  let count = 0;
  for (const o of procurement.orders) {
    if (o.cancelled || o.received) continue;
    if (o.arriveDate > d) continue;
    inventory.raw.set(o.materialId, (inventory.raw.get(o.materialId) ?? 0) + o.qty);
    o.received = true;
    count += 1;
    const tag = o.arriveDate < d ? '补到货' : '到货';
    const planned = o.plannedArriveDate ?? o.arriveDate;
    const delayNote =
      (o.supplierDelayDays ?? 0) > 0 ? `，计划 ${planned} 延期 +${o.supplierDelayDays} 天` : '';
    log?.({
      type: 'arrival',
      message: `${tag}：原料 ${o.materialId} +${o.qty.toFixed(2)}（到货 ${o.arriveDate}${delayNote}）`,
    });
  }
  return count;
}

/**
 * 齐套判断用虚拟库存：现有库存 + 当日计划到货（尚未入库的 PO）
 */
export function inventoryForKitCheck(inventory, procurement, dateStr) {
  const raw = new Map(inventory.raw);
  for (const o of procurement.orders) {
    if (o.cancelled || o.received) continue;
    if (o.arriveDate !== dateStr) continue;
    raw.set(o.materialId, (raw.get(o.materialId) ?? 0) + o.qty);
  }
  return { raw, finished: inventory.finished };
}

/** 当日应下单的 PO */
export function ordersToPlaceToday(procurement, onDate) {
  const d = formatDate(onDate);
  return procurement.orders.filter((o) => !o.cancelled && o.orderDate === d);
}

/** 打开 PO 数量 */
export function openPoCount(procurement, onDate) {
  const d = formatDate(onDate);
  return procurement.orders.filter(
    (o) => !o.cancelled && !o.received && o.orderDate <= d && o.arriveDate > d
  ).length;
}

/**
 * 计划变更时取消未来未到货、且 demandDate 在变更月内的订单（简化堆料控制）
 */
export function cancelFutureOrders(procurement, fromDateStr, log) {
  let n = 0;
  for (const o of procurement.orders) {
    if (!o.cancelled && o.orderDate >= fromDateStr && o.arriveDate > fromDateStr) {
      o.cancelled = true;
      n += 1;
    }
  }
  if (n) log?.({ type: 'po', message: `取消 ${n} 张未来采购单（计划变更）` });
}
