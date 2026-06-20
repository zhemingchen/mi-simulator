/**
 * MRP 计划：成品生产排产 + 原料 BOM 参考储备量（仅 KPI 展示，不参与采购）
 */

import { getFinished } from './inventory.js';
import { addDays, formatDate, parseDate, ensureDailyOrdersForMonth } from './scheduler.js';
import { applyProductionLotRules, getProductProductionPolicy } from './production-policy.js';

function enumerateDays(fromStr, toStr) {
  const out = [];
  let d = parseDate(fromStr);
  const end = parseDate(toStr);
  while (d <= end) {
    out.push(formatDate(d));
    d = addDays(d, 1);
  }
  return out;
}

/** @typedef {{ deliveryDate: string, qty: number }} ForecastOpenOrder */

/** 整单出库投影（与仿真一致：交期先后，库存不足则不交） */
function fulfillForecastWholeOrders(stock, openOrders, dateStr) {
  let remaining = stock;
  const kept = [];
  const due = openOrders
    .filter((o) => o.deliveryDate <= dateStr)
    .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));

  for (const o of due) {
    if (remaining + 1e-9 >= o.qty) {
      remaining -= o.qty;
    } else {
      kept.push(o);
    }
  }

  for (const o of openOrders) {
    if (o.deliveryDate > dateStr) kept.push(o);
  }

  return { stock: remaining, openOrders: kept };
}

/**
 * 某日生产前缺口：交清当日及之前待交整单 + 日末成品库存 ≥ SS
 * 与仿真顺序一致：先生产 → 登记当日订单 → 整单出库
 */
function calcDayProductionGap(stock, openOrders, dayStr, orderToday, ss) {
  const dueBeforeReg = openOrders
    .filter((o) => o.deliveryDate <= dayStr)
    .reduce((sum, o) => sum + o.qty, 0);
  const dueTotal = dueBeforeReg + orderToday;
  return Math.max(0, dueTotal + ss - stock);
}

/**
 * 首批 SS 组装日：仿真起点 + BOM 最长 LT（原料初始为 0，从起点日起倒推 PO）
 * @param {string} simStartDate YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
export function getSsEffectiveFromDate(productId, bomIndex, materialIndex, simStartDate) {
  const lead = getSkuBomMaxLeadDays(productId, bomIndex, materialIndex);
  return formatDate(addDays(parseDate(simStartDate), lead));
}

/**
 * 前瞻库存：第一轮用理想 lot；第二轮用 feasible 快照，但若快照为 0 而缺口法仍要产 lot，
 * 说明是前序日未完成的 SS/欠产，应计入 lot，避免 SS 被重复排成「每天都要产」。
 */
function projectStockAfterPlannedProduction(stock, lot, assumedProductionByDate, dayStr, pid) {
  if (!assumedProductionByDate) {
    return stock + lot;
  }
  const assumed = assumedProductionByDate.get(dayStr)?.get(pid);
  if (assumed !== undefined && assumed > 0) {
    return stock + assumed;
  }
  if (lot > 0) {
    return stock + lot;
  }
  if (assumed !== undefined) {
    return stock + assumed;
  }
  return stock;
}

/** @typedef {{ productionDate: string, qty: number, triggerDate: string, ssEffectiveFrom?: string }} SsBatchTarget */

export function createSsBatchTargets() {
  return new Map();
}

export function cloneSsBatchTargets(targets) {
  const m = new Map();
  for (const [pid, t] of targets ?? []) {
    m.set(pid, { ...t });
  }
  return m;
}

/**
 * 由成品安全库存 × BOM 用量，汇总各原料安全库存（多 SKU 共用同一原料时求和）
 */
export function deriveRawSafetyStockFromFinishedGoods(finishedGoodsSS, bomIndex, productIds, materialIds) {
  const derived = Object.fromEntries(materialIds.map((id) => [String(id), 0]));
  for (const pid of productIds) {
    const fgSs = finishedGoodsSS[String(pid)] ?? 0;
    if (fgSs <= 1e-9) continue;
    for (const { materialId, qty } of bomIndex.get(pid) ?? []) {
      const key = String(materialId);
      derived[key] = (derived[key] ?? 0) + fgSs * qty;
    }
  }
  return derived;
}

/** 将 sim.safetyStock.rawMaterials 同步为 BOM 参考储备量（不参与 PO） */
export function syncDerivedRawSafetyStock(sim) {
  sim.safetyStock.rawMaterials = deriveRawSafetyStockFromFinishedGoods(
    sim.safetyStock.finishedGoods,
    sim.bomIndex,
    sim.productIds,
    sim.materialIds
  );
}

/** 需求预测：各日随机日订单（需求通报 → 日订单） */
export function buildDemandForecastByDate(taskState, productIds, asOfDate, horizonDays = 60) {
  const forecast = new Map();
  const days = [];
  for (let i = 0; i < horizonDays; i++) {
    const d = addDays(asOfDate, i);
    const ds = formatDate(d);
    days.push({ date: d, dateStr: ds, monthKey: `${d.getFullYear()}-${d.getMonth() + 1}`, dayOfMonth: d.getDate() });
  }

  const monthKeys = [...new Set(days.map((day) => day.monthKey))];
  for (const mk of monthKeys) {
    ensureDailyOrdersForMonth(taskState, productIds, mk, asOfDate);
  }

  for (const day of days) {
    const plan = new Map();
    for (const pid of productIds) {
      const arr = taskState.dailyOrders.get(pid)?.get(day.monthKey);
      plan.set(pid, arr?.[day.dayOfMonth - 1] ?? 0);
    }
    forecast.set(day.dateStr, plan);
  }
  return forecast;
}

/**
 * 成品 MRP 日生产计划（目标日缺口法）
 * 自 horizonStart 起逐日前瞻，与仿真同序：先生产 → 登记当日整单 → 整单出库。
 * 每日缺口 = 当日及之前待交整单 + 当日订单 + 补齐 SS − 期初库存；再按 MOQ/Batch 排产量。
 * 理想计划供 PO 倒推；2/2、2/3… 每日 rebuild 时整段未来重算。
 */
export function computeMrpFinishedGoodsPlans(ctx) {
  const {
    inventory,
    demandByDate,
    productIds,
    safetyStock,
    productionPolicy,
    horizonStart,
    horizonEnd,
    ssBatchTargets,
    openDeliveryOrders,
    bomIndex,
    materialIndex,
    simStartDate,
    /** @type {Map<string, Map<number, number>>|undefined} 前瞻库存用可行产量，避免理想满产掩盖后续缺口 */
    assumedProductionByDate,
  } = ctx;

  const startStr = formatDate(horizonStart);
  const endStr = formatDate(horizonEnd);
  const days = enumerateDays(startStr, endStr);

  const plans = new Map();
  for (const ds of days) {
    plans.set(ds, new Map(productIds.map((id) => [id, 0])));
  }

  for (const pid of productIds) {
    const ss = safetyStock.finishedGoods[String(pid)] ?? 0;
    const { minProductionQty, batchSize } = getProductProductionPolicy(productionPolicy, pid);
    const fgStock = getFinished(inventory, pid);
    const startStrHorizon = formatDate(horizonStart);
    const ssEffectiveFrom =
      ss > 0 && fgStock + 1e-9 < ss && simStartDate && bomIndex && materialIndex
        ? getSsEffectiveFromDate(pid, bomIndex, materialIndex, simStartDate)
        : startStrHorizon;
    let stock = fgStock;

    /** @type {ForecastOpenOrder[]} */
    let openOrders = (openDeliveryOrders ?? [])
      .filter((o) => o.pid === pid && o.status === 'pending')
      .map((o) => ({ deliveryDate: o.deliveryDate, qty: o.qty }));

    let nextBatch = ssBatchTargets?.get(pid);
    if (nextBatch && nextBatch.productionDate < startStr) {
      ssBatchTargets?.delete(pid);
      nextBatch = undefined;
    }

    for (const dayStr of days) {
      const orderToday = demandByDate.get(dayStr)?.get(pid) ?? 0;
      const ssForGap = dayStr >= ssEffectiveFrom ? ss : 0;
      const rawNeed = calcDayProductionGap(stock, openOrders, dayStr, orderToday, ssForGap);
      const lot = applyProductionLotRules(rawNeed, minProductionQty, batchSize);

      if (lot > 0) {
        plans.get(dayStr).set(pid, lot);
        stock = projectStockAfterPlannedProduction(stock, lot, assumedProductionByDate, dayStr, pid);
        if (!nextBatch || dayStr < nextBatch.productionDate) {
          nextBatch = { productionDate: dayStr, qty: lot, triggerDate: startStr, ssEffectiveFrom };
          ssBatchTargets?.set(pid, nextBatch);
        } else if (dayStr === nextBatch.productionDate) {
          nextBatch.qty = lot;
        }
      }

      if (orderToday > 0) {
        openOrders.push({ deliveryDate: dayStr, qty: orderToday });
      }

      const fulfilled = fulfillForecastWholeOrders(stock, openOrders, dayStr);
      stock = fulfilled.stock;
      openOrders = fulfilled.openOrders;
    }
  }

  return plans;
}

/** SKU BOM 中原料最长采购周期（SS 批次组装日 = 触发日 + maxLead，原料自触发日起倒推下单） */
export function getSkuBomMaxLeadDays(productId, bomIndex, materialIndex) {
  let maxLead = 0;
  for (const { materialId } of bomIndex.get(productId) ?? []) {
    maxLead = Math.max(maxLead, materialIndex.get(materialId)?.leadTimeDays ?? 0);
  }
  return maxLead;
}
