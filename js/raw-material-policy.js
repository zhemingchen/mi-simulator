/**
 * 原材料库存 / 补货策略
 */

import { getRaw } from './inventory.js';
import { addDays, formatDate, parseDate } from './scheduler.js';

/** 策略类型 */
export const RAW_MATERIAL_POLICY_TYPES = {
  mrp: 'MRP（库存预测 + 安全库存）',
};

export const DEFAULT_RAW_POLICY = {
  type: 'mrp',
  mrpMin: 0,
  mrpMax: 0,
  mrpMult: 1,
  mrpAggDays: 7,
  /** 是否将各原料采购周期（leadTimeDays）纳入聚合窗口 */
  mrpAggByLeadTime: true,
  /** MRP 安全库存覆盖天数（0=仅用右侧逐料 SS；>0 时与逐料 SS 取大，并参考 horizon 内日均毛需求） */
  mrpSafetyDays: 0,
};

/** 将全局策略参数按原料 BOM 单位用量权重换算 */
export function scalePolicyThreshold(globalQty, materialId, usageWeights) {
  const w = usageWeights?.get(materialId) ?? 1;
  return Math.max(0, globalQty * w);
}

export function createRawMaterialPolicy(overrides = {}) {
  return { ...DEFAULT_RAW_POLICY, ...overrides };
}

export function getRawPolicyLabel(type) {
  return RAW_MATERIAL_POLICY_TYPES[type] ?? type;
}

/**
 * 原料 BOM 单位用量权重：各 SKU 中该原料用量的算术均值
 * 全局 s/S/R/Q 乘以该权重，得到该原料的实际阈值
 */
export function buildMaterialUsageWeights(bomIndex, productIds) {
  const sumByMaterial = new Map();
  const countByMaterial = new Map();
  for (const pid of productIds) {
    for (const { materialId, qty } of bomIndex.get(pid) ?? []) {
      sumByMaterial.set(materialId, (sumByMaterial.get(materialId) ?? 0) + qty);
      countByMaterial.set(materialId, (countByMaterial.get(materialId) ?? 0) + 1);
    }
  }
  const weights = new Map();
  for (const [mid, sum] of sumByMaterial) {
    weights.set(mid, sum / countByMaterial.get(mid));
  }
  return weights;
}

/** 库存位置 = 账面 + 在途 */
export function inventoryPosition(inventory, procurement, materialId, asOfDate) {
  const d = formatDate(asOfDate);
  const onHand = getRaw(inventory, materialId);
  const transit = procurement.orders
    .filter(
      (o) =>
        !o.cancelled &&
        !o.received &&
        o.materialId === materialId &&
        o.orderDate <= d &&
        o.arriveDate > d
    )
    .reduce((s, o) => s + o.qty, 0);
  return onHand + transit;
}

/**
 * 未来 horizon 日内 BOM 原料总消耗（来自日计划）
 */
export function forecastMaterialConsumption(materialId, dailyPlansByDate, bomIndex, productIds, fromStr, toStr) {
  let total = 0;
  for (const [dateStr, plan] of dailyPlansByDate) {
    if (dateStr < fromStr || dateStr > toStr) continue;
    for (const pid of productIds) {
      const q = plan.get(pid) ?? 0;
      if (q <= 0) continue;
      for (const line of bomIndex.get(pid) ?? []) {
        if (line.materialId === materialId) total += line.qty * q;
      }
    }
  }
  return total;
}

/**
 * 计算单原料补货量（审查型策略：min-max / rq）
 */
export function calcReviewOrderQty(policy, materialId, ctx) {
  const {
    inventory,
    procurement,
    horizonStart,
    horizonEnd,
    dailyPlansByDate,
    bomIndex,
    productIds,
    safetyStock,
    materialUsageWeights,
  } = ctx;
  const ss = safetyStock.rawMaterials[String(materialId)] ?? 0;
  const ip = inventoryPosition(inventory, procurement, materialId, horizonStart);
  const startStr = formatDate(horizonStart);
  const endStr = formatDate(horizonEnd);

  const horizonConsumption = forecastMaterialConsumption(
    materialId,
    dailyPlansByDate,
    bomIndex,
    productIds,
    startStr,
    endStr
  );

  if (policy.type === 'min-max') {
    const s = Math.max(
      0,
      scalePolicyThreshold(policy.min ?? 0, materialId, materialUsageWeights),
      ss
    );
    const S = Math.max(
      s,
      scalePolicyThreshold(policy.max ?? 0, materialId, materialUsageWeights)
    );
    if (ip > s && ip >= horizonConsumption + ss) return 0;
    if (ip <= s || ip < horizonConsumption + ss) {
      const target = Math.max(S, horizonConsumption + ss);
      return Math.max(0, target - ip);
    }
    return 0;
  }

  if (policy.type === 'rq') {
    const R = Math.max(
      0,
      scalePolicyThreshold(policy.R ?? 0, materialId, materialUsageWeights),
      ss
    );
    const Q = Math.max(0, scalePolicyThreshold(policy.Q ?? 0, materialId, materialUsageWeights));
    if (ip <= R || ip < horizonConsumption + ss) {
      return Math.max(Q, horizonConsumption + ss - ip);
    }
    return 0;
  }

  return 0;
}

/** MRP 批量规则：最小/最大/倍数（max=0 不限上限） */
export function applyMrpLotSizing(qty, min, max, mult) {
  if (qty <= 1e-9) return 0;
  let q = qty;
  const m = Math.max(1, mult ?? 1);
  if (m > 1) q = Math.ceil(q / m) * m;
  if (min > 0) q = Math.max(q, min);
  if (max > 0) q = Math.min(q, max);
  return Math.max(0, q);
}

/** 按日计划展开单原料毛需求（分时点，不按采购周期合并） */
export function buildDailyMaterialRequirements(
  materialId,
  dailyPlansByDate,
  bomIndex,
  productIds,
  fromStr,
  toStr
) {
  const req = new Map();
  for (const [dateStr, plan] of dailyPlansByDate) {
    if (dateStr < fromStr || dateStr > toStr) continue;
    let dayNeed = 0;
    for (const pid of productIds) {
      const q = plan.get(pid) ?? 0;
      if (q <= 0) continue;
      for (const line of bomIndex.get(pid) ?? []) {
        if (line.materialId === materialId) dayNeed += line.qty * q;
      }
    }
    if (dayNeed > 1e-9) req.set(dateStr, dayNeed);
  }
  return req;
}

function buildDailyMaterialRequirementsIndex(dailyPlansByDate, bomIndex, fromStr, toStr) {
  const byMaterial = new Map();
  for (const [dateStr, plan] of dailyPlansByDate) {
    if (dateStr < fromStr || dateStr > toStr) continue;
    for (const [pid, q] of plan) {
      if (q <= 0) continue;
      for (const line of bomIndex.get(pid) ?? []) {
        let reqByDate = byMaterial.get(line.materialId);
        if (!reqByDate) {
          reqByDate = new Map();
          byMaterial.set(line.materialId, reqByDate);
        }
        reqByDate.set(dateStr, (reqByDate.get(dateStr) ?? 0) + line.qty * q);
      }
    }
  }
  return byMaterial;
}

/** 枚举日期（含起止） */
function enumerateDays(fromDate, toDate) {
  const days = [];
  let d = parseDate(fromDate);
  const end = parseDate(toDate);
  while (d <= end) {
    days.push(formatDate(d));
    d = addDays(d, 1);
  }
  return days;
}

/** 已有 PO 按到货日汇总（未取消、未收货） */
function scheduledReceiptsByDate(procurement, materialId, fromStr, toStr) {
  const map = new Map();
  for (const o of procurement.orders) {
    if (o.cancelled || o.received || o.materialId !== materialId) continue;
    if (o.arriveDate < fromStr || o.arriveDate > toStr) continue;
    map.set(o.arriveDate, (map.get(o.arriveDate) ?? 0) + o.qty);
  }
  return map;
}


/**
 * MRP 补货聚合窗口（天）：max(全局下限, 该原料采购周期)
 * 毛需求仍按日展开；聚合窗口决定一次计划单覆盖未来多少天的毛需求
 */
export function getMrpAggregationDays(policy, leadTimeDays) {
  const floor = Math.max(1, Math.floor(policy?.mrpAggDays ?? 7));
  const lead = Math.max(0, leadTimeDays ?? 0);
  if (policy?.mrpAggByLeadTime === false) return floor;
  return Math.max(floor, lead, 1);
}

/**
 * MRP 有效安全库存：由成品 SS × BOM 推导（见 mrp-planner.syncDerivedRawSafetyStock）
 */
export function getMrpEffectiveSafetyStock(materialId, manualSs) {
  return Math.max(0, manualSs ?? 0);
}

/**
 * MRP（对齐 anyLogistix 3.6）：逐日库存预测 + 安全库存
 * - 库存预测：期初库存 + 在途 PO − 未来可行产量 BOM 消耗
 * - 安全库存：成品 SS 经 BOM 推导至各原料
 * - ELT / 聚合：原料主数据 leadTimeDays（采购周期）
 */
export function syncMrpPurchaseOrders(ctx) {
  const {
    procurement,
    inventory,
    materialIndex,
    bomIndex,
    productIds,
    safetyStock,
    dailyPlansByDate,
    scheduleHistory,
    horizonStart,
    horizonEnd,
    rawMaterialPolicy,
    materialUsageWeights,
    log,
  } = ctx;

  const policy = rawMaterialPolicy ?? DEFAULT_RAW_POLICY;
  const startStr = formatDate(horizonStart);
  const endStr = formatDate(horizonEnd);
  const label = getRawPolicyLabel('mrp');

  procurement.orders = procurement.orders.filter(
    (o) =>
      o.cancelled ||
      o.received ||
      o.orderDate < startStr ||
      (o.arriveDate <= startStr && !o.received)
  );

  let poSeq = ctx.getPoSeq?.() ?? 0;
  const setPoSeq = ctx.setPoSeq ?? (() => {});

  /** 欠料结转：并入 horizon 首日的毛需求 */
  const carry = new Map();
  for (const [dateStr, hist] of Object.entries(scheduleHistory ?? {})) {
    if (dateStr >= startStr) continue;
    for (const pid of productIds) {
      const gap = (hist.planned[pid] ?? 0) - (hist.actual[pid] ?? 0);
      if (gap <= 0) continue;
      for (const { materialId, qty } of bomIndex.get(pid) ?? []) {
        carry.set(materialId, (carry.get(materialId) ?? 0) + qty * gap);
      }
    }
  }

  const days = enumerateDays(startStr, endStr);

  for (const [materialId, mat] of materialIndex) {
    const manualSs = safetyStock.rawMaterials[String(materialId)] ?? 0;
    const lead = mat.leadTimeDays ?? 0;
    const aggDays = getMrpAggregationDays(policy, lead);
    const minLot = scalePolicyThreshold(policy.mrpMin ?? 0, materialId, materialUsageWeights);
    const maxLot = scalePolicyThreshold(policy.mrpMax ?? 0, materialId, materialUsageWeights);
    const mult = Math.max(1, policy.mrpMult ?? 1);

    const grossReq = buildDailyMaterialRequirements(
      materialId,
      dailyPlansByDate,
      bomIndex,
      productIds,
      startStr,
      endStr
    );
    const backlog = carry.get(materialId) ?? 0;
    if (backlog > 1e-9) {
      grossReq.set(startStr, (grossReq.get(startStr) ?? 0) + backlog);
    }

    const ss = getMrpEffectiveSafetyStock(materialId, manualSs);

    const lockedReceipts = scheduledReceiptsByDate(procurement, materialId, startStr, endStr);
    const plannedReceipts = new Map();

    let projected = getRaw(inventory, materialId);

    for (let i = 0; i < days.length; i++) {
      const dayStr = days[i];
      projected += lockedReceipts.get(dayStr) ?? 0;
      projected += plannedReceipts.get(dayStr) ?? 0;

      const consumption = grossReq.get(dayStr) ?? 0;
      projected -= consumption;

      if (projected + 1e-9 >= ss) continue;

      let target = ss - projected;
      for (let j = 1; j < aggDays && i + j < days.length; j++) {
        target += grossReq.get(days[i + j]) ?? 0;
      }

      const orderQty = applyMrpLotSizing(target, minLot, maxLot, mult);
      if (orderQty <= 1e-9) continue;

      plannedReceipts.set(dayStr, (plannedReceipts.get(dayStr) ?? 0) + orderQty);
      projected += orderQty;
    }

    /** 同步 MRP 计划单为 PO（demandDate = 到货日） */
    for (const [receiptDate, qty] of plannedReceipts) {
      if (qty <= 1e-9) continue;

      let orderDate = formatDate(addDays(parseDate(receiptDate), -lead));
      let arriveDate = receiptDate;
      if (orderDate < startStr) {
        orderDate = startStr;
        arriveDate = formatDate(addDays(parseDate(orderDate), lead));
      }

      const po = procurement.orders.find(
        (o) =>
          !o.cancelled &&
          !o.received &&
          o.materialId === materialId &&
          o.demandDate === receiptDate &&
          o.orderDate >= startStr
      );

      if (po) {
        if (Math.abs(po.qty - qty) > 1e-9) {
          po.qty = qty;
          po.orderDate = orderDate;
          po.arriveDate = arriveDate;
          log?.({
            type: 'po',
            message: `[${label}] 改量 PO：原料 ${materialId} → ${qty.toFixed(2)}（到货 ${arriveDate}）`,
          });
        }
      } else {
        poSeq += 1;
        procurement.orders.push({
          id: `PO-${poSeq}`,
          materialId,
          qty,
          orderDate,
          arriveDate,
          demandDate: receiptDate,
          cancelled: false,
          received: false,
        });
        log?.({
          type: 'po',
          message: `[${label}] 计划单：原料 ${materialId} × ${qty.toFixed(2)}（${orderDate} 下单，${lead} 天到货）`,
        });
      }
    }

    /** 取消 MRP 可改范围内不再需要的 open PO */
    for (const po of procurement.orders) {
      if (po.cancelled || po.received || po.materialId !== materialId) continue;
      if (po.orderDate < startStr) continue;
      if ((plannedReceipts.get(po.demandDate) ?? 0) <= 1e-9) {
        po.cancelled = true;
        log?.({
          type: 'po',
          message: `[${label}] 取消原料 ${materialId} PO（需求日 ${po.demandDate}）`,
        });
      }
    }
  }

  setPoSeq(poSeq);
}

/**
 * 审查型策略：生成/刷新 PO（每种原料至多一张可改 open PO，demandDate = 审查日）
 */
export function syncReviewBasedPurchaseOrders(ctx) {
  const {
    procurement,
    inventory,
    materialIndex,
    horizonStart,
    rawMaterialPolicy,
    log,
  } = ctx;

  const policy = rawMaterialPolicy ?? DEFAULT_RAW_POLICY;
  const startStr = formatDate(horizonStart);

  procurement.orders = procurement.orders.filter(
    (o) =>
      o.cancelled ||
      o.received ||
      o.orderDate < startStr ||
      (o.arriveDate <= startStr && !o.received)
  );

  let poSeq = ctx.getPoSeq?.() ?? 0;
  const setPoSeq = ctx.setPoSeq ?? (() => {});

  for (const [materialId, mat] of materialIndex) {
    const orderQty = calcReviewOrderQty(policy, materialId, ctx);
    const lead = mat.leadTimeDays ?? 0;
    const orderDate = startStr;
    const arriveDate = formatDate(addDays(parseDate(orderDate), lead));

    let po = procurement.orders.find(
      (o) =>
        !o.cancelled &&
        !o.received &&
        o.materialId === materialId &&
        o.demandDate === startStr &&
        o.orderDate >= startStr
    );

    if (orderQty <= 1e-9) {
      if (po && po.orderDate >= startStr) {
        po.cancelled = true;
        log?.({ type: 'po', message: `[${getRawPolicyLabel(policy.type)}] 取消原料 ${materialId} 补货 PO` });
      }
      continue;
    }

    if (po) {
      if (Math.abs(po.qty - orderQty) > 1e-9) {
        po.qty = orderQty;
        po.arriveDate = arriveDate;
        log?.({
          type: 'po',
          message: `[${getRawPolicyLabel(policy.type)}] 改量 PO：原料 ${materialId} → ${orderQty.toFixed(2)}（${orderDate} 下单）`,
        });
      }
    } else {
      poSeq += 1;
      procurement.orders.push({
        id: `PO-${poSeq}`,
        materialId,
        qty: orderQty,
        orderDate,
        arriveDate,
        demandDate: startStr,
        cancelled: false,
        received: false,
      });
      log?.({
        type: 'po',
        message: `[${getRawPolicyLabel(policy.type)}] 采购下单：原料 ${materialId} × ${orderQty.toFixed(2)}（${lead} 天到货）`,
      });
    }
  }

  setPoSeq(poSeq);
}
