/**
 * 原料约束排产：结合库存、在途 PO 与采购提前期，计算可行日计划及提前期缺口补单
 */

import { consumeBom } from './inventory.js';
import {
  buildDailyProductionFromPlan,
  getProductionLineOrder,
} from './production-line.js';
import {
  buildDemandForecastByDate,
  computeMrpFinishedGoodsPlans,
  syncDerivedRawSafetyStock,
  createSsBatchTargets,
} from './mrp-planner.js';
import {
  addDays,
  formatDate,
  integerizeDailyPlan,
} from './scheduler.js';
import { getPlanningDailyCapacity, applyCapacityLimit } from './capacity.js';

function cloneRawMap(raw) {
  return new Map(raw);
}

/** 某日 PO 到货（含虚拟补单） */
function applyArrivals(projected, orders, dateStr) {
  for (const o of orders) {
    if (o.cancelled || o.received) continue;
    if (o.arriveDate !== dateStr) continue;
    projected.set(o.materialId, (projected.get(o.materialId) ?? 0) + o.qty);
  }
}

/** 理想日计划（浮点）：成品 MRP，需求来自日订单 */
export function buildIdealDailyPlans(sim, horizonDays = 60, assumedProductionByDate = undefined) {
  syncDerivedRawSafetyStock(sim);
  const demandByDate = buildDemandForecastByDate(
    sim.taskState,
    sim.productIds,
    sim.currentDate,
    horizonDays
  );
  sim._demandForecast = demandByDate;
  const horizonEnd = addDays(sim.currentDate, horizonDays - 1);
  return computeMrpFinishedGoodsPlans({
    inventory: sim.inventory,
    demandByDate,
    productIds: sim.productIds,
    safetyStock: sim.safetyStock,
    productionPolicy: sim.productionPolicy,
    horizonStart: sim.currentDate,
    horizonEnd,
    bomIndex: sim.bomIndex,
    materialIndex: sim.materialIndex,
    ssBatchTargets: sim.ssBatchTargets,
    openDeliveryOrders: sim.openDeliveryOrders,
    simStartDate: sim._simStartDate,
    assumedProductionByDate,
  });
}

/** 单日可行计划（共线顺序 + MOQ/Batch，不超过理想计划） */
function feasiblePlanForDay(ideal, projected, ctx, productIds, bomIndex, dateStr, dailyCapacity) {
  const kitInv = { raw: cloneRawMap(projected), finished: new Map() };
  const dayPlan = buildDailyProductionFromPlan(ctx, ideal, kitInv, productIds, dateStr);
  return applyCapacityLimit(dayPlan, dailyCapacity, productIds);
}

/** 将日产量从投影库存中扣减 */
function consumePlanFromProjected(projected, dayPlan, productIds, bomIndex) {
  for (const pid of productIds) {
    const qty = dayPlan.get(pid) ?? 0;
    if (qty <= 0) continue;
    consumeBom({ raw: projected, finished: new Map() }, bomIndex.get(pid) ?? [], qty);
  }
}

/**
 * 按日投影原料并计算可行产量（不超过理想计划）
 * @returns {Map<string, Map<number, number>>} dateStr -> productId -> qty
 */
export function simulateFeasibleDailyPlans(ctx) {
  const {
    asOfDate,
    horizonDays = 60,
    idealPlansByDate,
    inventory,
    procurement,
    productIds,
    bomIndex,
    extraOrders = [],
    dailyCapacityCache,
    getDailyCapacity = null,
    productionPolicy,
  } = ctx;

  const resolveCapacity =
    typeof getDailyCapacity === 'function'
      ? getDailyCapacity
      : (dateStr) => getPlanningDailyCapacity({ dailyCapacityCache, ...ctx }, dateStr);

  const lineCtx = { bomIndex, productionPolicy };

  const asOfStr = formatDate(asOfDate);
  const allOrders = [...procurement.orders, ...extraOrders];
  const dates = [...idealPlansByDate.keys()].filter((d) => d >= asOfStr).sort().slice(0, horizonDays);

  const projected = cloneRawMap(inventory.raw);
  const feasible = new Map();

  for (const dateStr of dates) {
    applyArrivals(projected, allOrders, dateStr);

    const ideal = idealPlansByDate.get(dateStr) ?? new Map();
    const dailyCapacity = resolveCapacity(dateStr);
    const dayPlan = feasiblePlanForDay(ideal, projected, lineCtx, productIds, bomIndex, dateStr, dailyCapacity);
    feasible.set(dateStr, dayPlan);
    consumePlanFromProjected(projected, dayPlan, productIds, bomIndex);
  }

  return feasible;
}

/**
 * 提前期窗口内「理想耗料 − 可供应」累计缺口（原料单位）
 * 例：理想 10 台/天、仅可产 5 台/天、提前期 10 天 → 缺口 = (10−5)×10 台折算原料
 */
export function computeLeadTimeCatchUp(ctx) {
  const {
    asOfDate,
    idealPlansByDate,
    inventory,
    procurement,
    productIds,
    bomIndex,
    materialIndex,
    dailyCapacityCache,
    getDailyCapacity = null,
    productionPolicy,
  } = ctx;

  const resolveCapacity =
    typeof getDailyCapacity === 'function'
      ? getDailyCapacity
      : (dateStr) => getPlanningDailyCapacity({ dailyCapacityCache, ...ctx }, dateStr);

  const lineCtx = { bomIndex, productionPolicy };

  const asOfStr = formatDate(asOfDate);
  const dates = [...idealPlansByDate.keys()].filter((d) => d >= asOfStr).sort();
  const carryUp = new Map();
  const leadWindowEndByMaterial = new Map();

  for (const [materialId, mat] of materialIndex) {
    const lead = mat.leadTimeDays ?? 0;
    if (lead <= 0) continue;
    leadWindowEndByMaterial.set(materialId, formatDate(addDays(asOfDate, lead)));
  }

  const projected = cloneRawMap(inventory.raw);
  for (const dateStr of dates) {
    applyArrivals(projected, procurement.orders, dateStr);

    const ideal = idealPlansByDate.get(dateStr) ?? new Map();
    const dailyCapacity = resolveCapacity(dateStr);
    const dayPlan = feasiblePlanForDay(
      ideal,
      projected,
      lineCtx,
      productIds,
      bomIndex,
      dateStr,
      dailyCapacity
    );

    for (const pid of productIds) {
      const idealQty = ideal.get(pid) ?? 0;
      const feasibleQty = dayPlan.get(pid) ?? 0;
      const shortQty = idealQty - feasibleQty;
      if (shortQty <= 1e-9) continue;

      for (const { materialId, qty } of bomIndex.get(pid) ?? []) {
        const windowEndStr = leadWindowEndByMaterial.get(materialId);
        if (!windowEndStr || dateStr >= windowEndStr) continue;
        carryUp.set(materialId, (carryUp.get(materialId) ?? 0) + shortQty * qty);
      }
    }

    consumePlanFromProjected(projected, dayPlan, productIds, bomIndex);
  }

  return carryUp;
}

/** 将提前期补单量转为虚拟 PO（用于可行计划投影） */
export function buildVirtualCatchUpOrders(asOfDate, carryUp, materialIndex) {
  const asOfStr = formatDate(asOfDate);
  const orders = [];
  for (const [materialId, qty] of carryUp) {
    if (qty <= 1e-9) continue;
    const lead = materialIndex.get(materialId)?.leadTimeDays ?? 0;
    if (lead <= 0) continue;
    const arriveDate = formatDate(addDays(asOfDate, lead));
    orders.push({
      id: `VPO-${materialId}`,
      materialId,
      qty,
      orderDate: asOfStr,
      arriveDate,
      demandDate: arriveDate,
      cancelled: false,
      received: false,
      virtual: true,
    });
  }
  return orders;
}

/** 将 ssBatchTargets 数量与理想计划对齐（MRP 缺口法已含 backlog + SS） */
function refreshSsBatchQtyFromInventory(sim, idealPlans) {
  if (!idealPlans) return;
  for (const pid of sim.productIds) {
    const target = sim.ssBatchTargets?.get(pid);
    if (!target) continue;
    const planQty = idealPlans.get(target.productionDate)?.get(pid) ?? 0;
    if (planQty > 0) target.qty = planQty;
  }
}

/**
 * SS 批次仅允许前移：理想+可行均满足 SS 专属量时提前；禁止因缺料顺延
 */
function alignSsBatchTargetsToFeasible(sim, feasiblePlans, idealPlans, horizonEndStr) {
  if (!sim.ssBatchTargets?.size) return;

  for (const pid of sim.productIds) {
    const target = sim.ssBatchTargets.get(pid);
    if (!target) continue;

    const locked = target.productionDate;
    const searchFrom = target.triggerDate ?? locked;
    const dates = [...idealPlans.keys()]
      .filter((d) => d >= searchFrom && d <= locked && d <= horizonEndStr)
      .sort();

    for (const d of dates) {
      const idealQty = idealPlans.get(d)?.get(pid) ?? 0;
      const feasQty = feasiblePlans.get(d)?.get(pid) ?? 0;
      if (idealQty + 1e-9 >= target.qty && feasQty + 1e-9 >= target.qty) {
        target.productionDate = d;
        break;
      }
    }
  }
}

/** 把已对齐的 SS 批次写回理想计划（供 PO 倒推） */
function applySsBatchTargetsToIdealPlans(sim, idealPlans) {
  for (const pid of sim.productIds) {
    const target = sim.ssBatchTargets.get(pid);
    if (!target) continue;
    if (!idealPlans.has(target.productionDate)) {
      idealPlans.set(target.productionDate, new Map(sim.productIds.map((id) => [id, 0])));
    }
    const plan = idealPlans.get(target.productionDate);
    plan.set(pid, Math.max(plan.get(pid) ?? 0, target.qty));
  }
}

function buildFeasibleAndCatchUp(sim, idealPlans, horizonDays) {
  const capFn = (dateStr) => getPlanningDailyCapacity(sim, dateStr);
  const carryUp = computeLeadTimeCatchUp({
    asOfDate: sim.currentDate,
    idealPlansByDate: idealPlans,
    inventory: sim.inventory,
    procurement: sim.procurement,
    productIds: sim.productIds,
    bomIndex: sim.bomIndex,
    materialIndex: sim.materialIndex,
    dailyCapacityCache: sim.dailyCapacityCache,
    getDailyCapacity: capFn,
    productionPolicy: sim.productionPolicy,
  });

  const virtualOrders = buildVirtualCatchUpOrders(sim.currentDate, carryUp, sim.materialIndex);

  const feasibleFloat = simulateFeasibleDailyPlans({
    asOfDate: sim.currentDate,
    horizonDays,
    idealPlansByDate: idealPlans,
    inventory: sim.inventory,
    procurement: sim.procurement,
    productIds: sim.productIds,
    bomIndex: sim.bomIndex,
    extraOrders: virtualOrders,
    dailyCapacityCache: sim.dailyCapacityCache,
    getDailyCapacity: capFn,
    productionPolicy: sim.productionPolicy,
  });

  return { carryUp, virtualOrders, feasibleFloat };
}

/**
 * 重建原料约束日计划缓存
 * @returns {{ idealPlans: Map, carryUp: Map, virtualOrders: object[] }}
 */
export function rebuildMaterialAwareDailyPlans(sim, horizonDays = 60) {
  const idealPass1 = buildIdealDailyPlans(sim, horizonDays);
  refreshSsBatchQtyFromInventory(sim, idealPass1);
  applySsBatchTargetsToIdealPlans(sim, idealPass1);

  const { feasibleFloat: feasiblePass1 } = buildFeasibleAndCatchUp(sim, idealPass1, horizonDays);

  const idealPlans = buildIdealDailyPlans(sim, horizonDays, feasiblePass1);
  refreshSsBatchQtyFromInventory(sim, idealPlans);
  applySsBatchTargetsToIdealPlans(sim, idealPlans);
  const horizonEndStr = formatDate(addDays(sim.currentDate, horizonDays - 1));

  const { carryUp, virtualOrders, feasibleFloat } = buildFeasibleAndCatchUp(sim, idealPlans, horizonDays);

  alignSsBatchTargetsToFeasible(sim, feasibleFloat, idealPlans, horizonEndStr);
  applySsBatchTargetsToIdealPlans(sim, idealPlans);

  sim.dailyPlansCache.clear();
  for (const [ds, plan] of feasibleFloat) {
    sim.dailyPlansCache.set(ds, integerizeDailyPlan(plan));
  }

  sim._idealDailyPlans = idealPlans;
  sim._leadTimeCarryUp = carryUp;

  return { idealPlans, carryUp, virtualOrders };
}

/** 重建日计划：理想计划 → 按理想倒推 PO → 再投影可行计划 */
export function rebuildDailyPlansWithProcurement(sim, refreshProcurementFn, horizonDays = 60) {
  rebuildMaterialAwareDailyPlans(sim, horizonDays);
  refreshProcurementFn(sim);
  rebuildMaterialAwareDailyPlans(sim, horizonDays);
}
