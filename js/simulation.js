/**
 * 仿真引擎核心
 */

import {
  createTaskState,
  applyDemandNotices,
  applyDemandNoticesUpTo,
  formatDate,
  parseDate,
  addDays,
  monthKey,
  getMonthRemaining,
  recordProduction,
  cloneDailyOrders,
  computeDailyPlan,
} from './scheduler.js';
import {
  createInventory,
  consumeBom,
  countBelowSafety,
  findShortages,
  getRaw,
  getFinished,
} from './inventory.js';
import {
  createOpenDeliveryOrders,
  cloneOpenDeliveryOrders,
  registerDailyOrdersForDay,
  calcDueDeliveryBacklog,
  fulfillOpenDeliveryOrders,
  summarizeDeliveryOrders,
  getOrderLostWaitDays,
  DEFAULT_ORDER_LOST_WAIT_DAYS,
} from './order-delivery.js';
import {
  createProcurementState,
  syncPurchaseOrders,
  processArrivals,
  inventoryForKitCheck,
  inTransitQty,
  openPoCount,
  resetPoSeq,
  getPoSeq,
  setPoSeq,
} from './procurement.js';
import {
  createScheduleHistory,
  recordDaySchedule,
  cloneScheduleHistory,
} from './schedule-history.js';
import { rebuildDailyPlansWithProcurement, rebuildMaterialAwareDailyPlans } from './material-planner.js';
import {
  beginDailyCapacityDraw,
  commitDailyCapacity,
  clearPendingDailyCapacity,
  getActiveDayCapacity,
  getRevealedDailyCapacity,
  getPlanningDailyCapacity,
  applyCapacityLimit,
  cloneDailyCapacityCache,
  buildCapacityDistributionHint,
  getCapacityPolicyForDate,
  ensureCapacityForecastSchedule,
} from './capacity.js';
import {
  createCapacityPolicy,
  cloneCapacityPolicy,
  createDefaultCapacityForecastSchedule,
  cloneCapacityForecastSchedule,
  buildCapacityForecastScheduleHint,
} from './capacity-policy.js';
import { createRawMaterialPolicy } from './raw-material-policy.js';
import { recordInventorySnapshot } from './inventory-history.js';
import { createProductionPolicy, cloneProductionPolicy, normalizeProductionQty } from './production-policy.js';
import {
  applySequentialProductionCap,
  buildDailyProductionFromPlan,
  getProductionLineOrder,
} from './production-line.js';
import { createSupplierPolicy, cloneSupplierPolicy } from './supplier-policy.js';
import { createSsBatchTargets, cloneSsBatchTargets } from './mrp-planner.js';

export const SimState = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  WAITING_USER: 'waiting',
};

export const PLANNING_HORIZON_DAYS = 60;

export function createSimulation(master) {
  const productIds = master.products.map((p) => p.id);
  const materialIds = master.materials.map((m) => m.id);
  const maxMaterialLeadDays = master.materials.reduce(
    (max, m) => Math.max(max, m.leadTimeDays ?? 0),
    0
  );

  return {
    master,
    productIds,
    materialIds,
    bomIndex: master.bomIndex,
    materialIndex: master.materialIndex,
    materialUsageWeights: master.materialUsageWeights,
    maxMaterialLeadDays,
    taskState: createTaskState(productIds),
    inventory: createInventory(productIds, materialIds),
    procurement: createProcurementState(),
    safetyStock: master.safetyStock,
    currentDate: parseDate('2026-01-01'),
    runState: SimState.IDLE,
    events: [],
    stats: { manualDecisions: 0, lastDayProduced: 0, lastDayPlanned: 0 },
    /** 缓存：dateStr -> Map productId -> qty */
    dailyPlansCache: new Map(),
    /** 当日实际产量（决策后） */
    todayActual: new Map(productIds.map((id) => [id, 0])),
    /** 待用户决策 */
    pendingDecision: null,
    timer: null,
    /** @type {object[]} 已完成日期的状态快照（用于后退） */
    historyStack: [],
    /** 当日步进前的快照（等待人工决策时用于撤销） */
    dayUndoCheckpoint: null,
    scheduleHistory: createScheduleHistory(),
    _simStartDate: '2026-01-01',
    chartMode: 'planned',
    /** @type {Set<number>} 排产趋势 SKU 筛选 */
    scheduleSkuFilter: new Set(productIds),
    /** 每日随机产能上限缓存 dateStr -> qty */
    dailyCapacityCache: new Map(),
    /** 当日已抽样、尚未日终揭晓的产能 */
    _pendingDayCapacity: null,
    _pendingDayCapacityDate: null,
    /** 原料补货策略 */
    rawMaterialPolicy: createRawMaterialPolicy(),
    /** 各 SKU 起做量与 Batch */
    productionPolicy: createProductionPolicy(productIds, master.productionPolicy),
    /** 供应商延期概率等 */
    supplierPolicy: createSupplierPolicy(master.supplierPolicy),
    /** 共线日产能（正态分布 + 硬上限，兼容旧字段） */
    capacityPolicy: createCapacityPolicy(),
    /** 分时段产能预测：from/to + mean/p90/max */
    capacityForecastSchedule: createDefaultCapacityForecastSchedule('2026-01-01'),
    /** 已锁定的 SS 批次生产日（避免重算时批次不断后移） */
    ssBatchTargets: createSsBatchTargets(),
    /** 日终库存/生产历史 */
    inventoryHistory: [],
    openDeliveryOrders: createOpenDeliveryOrders(),
    /** 整单交货：交期后等待天数，超时丢失 */
    orderLostWaitDays: DEFAULT_ORDER_LOST_WAIT_DAYS,
    /** 策略对比结果缓存 */
    policyComparisonResults: null,
  };
}

function cloneNestedMap(outer) {
  const m = new Map();
  for (const [k, inner] of outer) m.set(k, new Map(inner));
  return m;
}

function clonePendingDecision(pending) {
  if (!pending) return null;
  return {
    plan: new Map(pending.plan),
    kitStatus: new Map(
      [...pending.kitStatus.entries()].map(([id, st]) => [id, { ...st }])
    ),
    blocked: [...pending.blocked],
    alternatives: [...pending.alternatives],
  };
}

/** 深拷贝当前仿真状态 */
export function captureSimCheckpoint(sim) {
  return {
    currentDate: formatDate(sim.currentDate),
    taskState: {
      effectiveTasks: cloneNestedMap(sim.taskState.effectiveTasks),
      producedThisMonth: cloneNestedMap(sim.taskState.producedThisMonth),
      dailyOrders: cloneDailyOrders(sim.taskState.dailyOrders),
    },
    inventory: {
      raw: new Map(sim.inventory.raw),
      finished: new Map(sim.inventory.finished),
    },
    procurement: {
      orders: sim.procurement.orders.map((o) => ({ ...o, received: !!o.received })),
    },
    poSeq: getPoSeq(),
    safetyStock: {
      finishedGoods: { ...sim.safetyStock.finishedGoods },
      rawMaterials: { ...sim.safetyStock.rawMaterials },
    },
    productionPolicy: cloneProductionPolicy(sim.productionPolicy),
    supplierPolicy: cloneSupplierPolicy(sim.supplierPolicy),
    capacityPolicy: cloneCapacityPolicy(sim.capacityPolicy),
    capacityForecastSchedule: cloneCapacityForecastSchedule(
      ensureCapacityForecastSchedule(sim)
    ),
    ssBatchTargets: cloneSsBatchTargets(sim.ssBatchTargets),
    events: sim.events.map((e) => ({ ...e })),
    stats: { ...sim.stats },
    todayActual: new Map(sim.todayActual),
    pendingDecision: clonePendingDecision(sim.pendingDecision),
    runState: sim.runState,
    scheduleHistory: cloneScheduleHistory(sim.scheduleHistory),
    dailyCapacityCache: cloneDailyCapacityCache(sim.dailyCapacityCache),
    pendingDayCapacity: sim._pendingDayCapacity,
    pendingDayCapacityDate: sim._pendingDayCapacityDate,
    inventoryHistory: (sim.inventoryHistory ?? []).map((h) => ({
      ...h,
      finishedByProduct: { ...(h.finishedByProduct ?? {}) },
    })),
    openDeliveryOrders: cloneOpenDeliveryOrders(sim.openDeliveryOrders),
    orderLostWaitDays: sim.orderLostWaitDays ?? DEFAULT_ORDER_LOST_WAIT_DAYS,
  };
}

function clonePlanMapsByDate(source) {
  if (!source) return new Map();
  const m = new Map();
  for (const [dateStr, plan] of source) {
    m.set(dateStr, new Map(plan));
  }
  return m;
}

function diffDays(fromDate, toDate) {
  const ms = parseDate(formatDate(toDate)) - parseDate(formatDate(fromDate));
  return Math.round(ms / 86400000);
}

function normalizeRebuildStartDate(sim, fromDate) {
  if (!fromDate) return formatDate(sim.currentDate);
  if (typeof fromDate === 'string') return fromDate;
  return formatDate(fromDate);
}

function mergePlanSuffix(target, replacement, fromDateStr) {
  for (const key of [...target.keys()]) {
    if (key >= fromDateStr) target.delete(key);
  }
  for (const [dateStr, plan] of replacement) {
    if (dateStr < fromDateStr) continue;
    target.set(dateStr, new Map(plan));
  }
}

function mergeProcurementSuffix(sim, nextOrders, fromDateStr) {
  const kept = sim.procurement.orders.filter((o) => o.demandDate < fromDateStr);
  const suffix = nextOrders
    .filter((o) => o.demandDate >= fromDateStr)
    .map((o) => ({ ...o, received: false }));
  sim.procurement.orders = [...kept, ...suffix];
}

function mergeSsBatchTargetSuffix(sim, nextTargets, fromDateStr) {
  const merged = new Map();
  for (const [pid, target] of sim.ssBatchTargets ?? []) {
    if ((target?.productionDate ?? '') < fromDateStr) {
      merged.set(pid, { ...target });
    }
  }
  for (const [pid, target] of nextTargets ?? []) {
    if ((target?.productionDate ?? '') >= fromDateStr) {
      merged.set(pid, { ...target });
    }
  }
  sim.ssBatchTargets = merged;
}

function fastForwardShadowToDate(sim, fromDateStr) {
  const shadow = cloneSimulationForProjection(sim);
  while (formatDate(shadow.currentDate) < fromDateStr) {
    projectSimulationDay(shadow);
    shadow.currentDate = addDays(shadow.currentDate, 1);
  }
  return shadow;
}

export function getPlanningRebuildStartDate(sim, effectiveDateStr) {
  const effective = parseDate(effectiveDateStr);
  const start = addDays(effective, -(sim.maxMaterialLeadDays ?? 0));
  return formatDate(start < sim.currentDate ? sim.currentDate : start);
}

/** 克隆仿真状态供 Dashboard 前瞻（不触发 rebuild，计划缓存与主仿真一致） */
export function cloneSimulationForProjection(sim) {
  return {
    master: sim.master,
    productIds: sim.productIds,
    materialIds: sim.materialIds,
    bomIndex: sim.bomIndex,
    materialIndex: sim.materialIndex,
    materialUsageWeights: sim.materialUsageWeights,
    rawMaterialPolicy: sim.rawMaterialPolicy,
    _simStartDate: sim._simStartDate,
    maxMaterialLeadDays: sim.maxMaterialLeadDays,
    taskState: {
      effectiveTasks: cloneNestedMap(sim.taskState.effectiveTasks),
      producedThisMonth: cloneNestedMap(sim.taskState.producedThisMonth),
      dailyOrders: cloneDailyOrders(sim.taskState.dailyOrders),
    },
    inventory: {
      raw: new Map(sim.inventory.raw),
      finished: new Map(sim.inventory.finished),
    },
    procurement: {
      orders: sim.procurement.orders.map((o) => ({ ...o, received: !!o.received })),
    },
    safetyStock: {
      finishedGoods: { ...sim.safetyStock.finishedGoods },
      rawMaterials: { ...sim.safetyStock.rawMaterials },
    },
    productionPolicy: cloneProductionPolicy(sim.productionPolicy),
    supplierPolicy: cloneSupplierPolicy(sim.supplierPolicy),
    capacityPolicy: cloneCapacityPolicy(sim.capacityPolicy),
    capacityForecastSchedule: cloneCapacityForecastSchedule(
      ensureCapacityForecastSchedule(sim)
    ),
    ssBatchTargets: cloneSsBatchTargets(sim.ssBatchTargets),
    stats: { ...sim.stats },
    todayActual: new Map(sim.todayActual),
    scheduleHistory: cloneScheduleHistory(sim.scheduleHistory),
    dailyCapacityCache: cloneDailyCapacityCache(sim.dailyCapacityCache),
    _pendingDayCapacity: sim._pendingDayCapacity ?? null,
    _pendingDayCapacityDate: sim._pendingDayCapacityDate ?? null,
    openDeliveryOrders: cloneOpenDeliveryOrders(sim.openDeliveryOrders),
    orderLostWaitDays: sim.orderLostWaitDays ?? DEFAULT_ORDER_LOST_WAIT_DAYS,
    currentDate: parseDate(formatDate(sim.currentDate)),
    dailyPlansCache: clonePlanMapsByDate(sim.dailyPlansCache),
    _idealDailyPlans: clonePlanMapsByDate(sim._idealDailyPlans),
    _leadTimeCarryUp: new Map(sim._leadTimeCarryUp ?? []),
    historyStack: [],
    events: [],
    inventoryHistory: [],
    timer: null,
    pendingDecision: null,
    dayUndoCheckpoint: null,
    runState: SimState.PAUSED,
    chartMode: sim.chartMode,
    scheduleSkuFilter: sim.scheduleSkuFilter,
    policyComparisonResults: null,
  };
}

/** 前瞻专用：新 PO 不抽样供应商延期（与计划到货日一致） */
function refreshProcurementForProjection(sim, horizonDays = 60) {
  const horizonEnd = addDays(sim.currentDate, Math.max(0, horizonDays - 1));
  const plansForPo = sim._idealDailyPlans ?? sim.dailyPlansCache;
  syncPurchaseOrders({
    procurement: sim.procurement,
    inventory: sim.inventory,
    bomIndex: sim.bomIndex,
    materialIndex: sim.materialIndex,
    safetyStock: sim.safetyStock,
    productIds: sim.productIds,
    dailyPlansByDate: plansForPo,
    scheduleHistory: sim.scheduleHistory,
    horizonStart: sim.currentDate,
    horizonEnd,
    leadTimeCarryUp: sim._leadTimeCarryUp ?? new Map(),
    supplierPolicy: { delayProbability: 0 },
    rawMaterialPolicy: sim.rawMaterialPolicy,
    materialUsageWeights: sim.materialUsageWeights,
    log: null,
  });
}

/** 前瞻专用：逐日重算可行计划 + PO（单轮 MRP + 同步 PO，较双轮快约 2×） */
export function rebuildDailyPlansForProjection(sim, horizonDays = 60) {
  if (horizonDays <= 0) return;
  rebuildMaterialAwareDailyPlans(sim, horizonDays);
  refreshProcurementForProjection(sim, horizonDays);
}

/**
 * Dashboard 前瞻单日：对齐 stepSimulation，但不引入三类随机差异
 * - 不应用未来需求通报
 * - 新 PO 不抽样供应商延期
 * - 产能用计划均值（非当日揭晓抽样）
 */
export function projectSimulationDay(shadow) {
  const ds = formatDate(shadow.currentDate);

  processArrivals(shadow.procurement, shadow.inventory, shadow.currentDate, null);

  const { plan } = analyzeProductionDay(shadow);
  shadow.stats.lastDayPlanned = [...plan.values()].reduce((a, b) => a + b, 0);

  const kitInv = inventoryForKitCheck(shadow.inventory, shadow.procurement, ds);
  const planningCap = getPlanningDailyCapacity(shadow, ds);
  let actual = buildDailyProductionFromPlan(
    productionLineCtx(shadow),
    plan,
    kitInv,
    shadow.productIds,
    ds
  );
  actual = normalizeActualMap(shadow, applyCapacityLimit(actual, planningCap, shadow.productIds));
  shadow.todayActual = new Map(actual);

  recordDaySchedule(shadow, ds, plan, shadow.todayActual);
  executeProduction(shadow, shadow.todayActual);

  if (!shadow.openDeliveryOrders) shadow.openDeliveryOrders = createOpenDeliveryOrders();
  const demandPlan = registerDailyOrdersForDay(
    shadow.openDeliveryOrders,
    shadow.taskState,
    shadow.productIds,
    shadow.currentDate
  );
  const dueDeliveryQty = calcDueDeliveryBacklog(shadow.openDeliveryOrders, ds);
  const lostWait = getOrderLostWaitDays(shadow);
  const { shippedTotal, lostCount, lostQty } = fulfillOpenDeliveryOrders(
    shadow.inventory,
    shadow.openDeliveryOrders,
    ds,
    null,
    lostWait
  );
  const deliveryStats = summarizeDeliveryOrders(shadow.openDeliveryOrders, ds, {
    shippedTotal,
    lostCount,
    lostQty,
    demandPlan,
    dueDeliveryQty,
  });

  finalizeSsBatchTargets(shadow);
  shadow.stats.lastDayProduced = [...shadow.todayActual.values()].reduce((a, b) => a + b, 0);

  return deliveryStats;
}

/** 从快照恢复仿真状态 */
export function restoreSimCheckpoint(sim, cp, { rebuildPlans = true } = {}) {
  sim.currentDate = parseDate(cp.currentDate);
  sim.taskState = {
    effectiveTasks: cloneNestedMap(cp.taskState.effectiveTasks),
    producedThisMonth: cloneNestedMap(cp.taskState.producedThisMonth),
    dailyOrders: cloneDailyOrders(cp.taskState.dailyOrders),
  };
  sim.inventory = {
    raw: new Map(cp.inventory.raw),
    finished: new Map(cp.inventory.finished),
  };
  sim.procurement = {
    orders: cp.procurement.orders.map((o) => ({ ...o, received: !!o.received })),
  };
  setPoSeq(cp.poSeq);
  sim.safetyStock = {
    finishedGoods: { ...cp.safetyStock.finishedGoods },
    rawMaterials: { ...cp.safetyStock.rawMaterials },
  };
  sim.productionPolicy = cloneProductionPolicy(
    cp.productionPolicy ?? createProductionPolicy(sim.productIds)
  );
  sim.supplierPolicy = cloneSupplierPolicy(cp.supplierPolicy ?? createSupplierPolicy());
  sim.capacityPolicy = cloneCapacityPolicy(cp.capacityPolicy ?? createCapacityPolicy());
  sim.capacityForecastSchedule = cloneCapacityForecastSchedule(
    cp.capacityForecastSchedule ??
      createDefaultCapacityForecastSchedule(
        sim._simStartDate ?? cp.currentDate,
        cp.capacityPolicy
      )
  );
  ensureCapacityForecastSchedule(sim);
  sim.ssBatchTargets = cloneSsBatchTargets(cp.ssBatchTargets ?? createSsBatchTargets());
  sim.events = cp.events.map((e) => ({ ...e }));
  sim.stats = { ...cp.stats };
  sim.todayActual = new Map(cp.todayActual);
  sim.pendingDecision = clonePendingDecision(cp.pendingDecision);
  sim.runState = cp.runState;
  sim.scheduleHistory = cloneScheduleHistory(cp.scheduleHistory);
  sim.dailyCapacityCache = cloneDailyCapacityCache(cp.dailyCapacityCache);
  sim._pendingDayCapacity = cp.pendingDayCapacity ?? null;
  sim._pendingDayCapacityDate = cp.pendingDayCapacityDate ?? null;
  sim.inventoryHistory = (cp.inventoryHistory ?? []).map((h) => ({
    ...h,
    finishedByProduct: { ...(h.finishedByProduct ?? {}) },
  }));
  sim.openDeliveryOrders = cloneOpenDeliveryOrders(cp.openDeliveryOrders);
  sim.orderLostWaitDays = cp.orderLostWaitDays ?? DEFAULT_ORDER_LOST_WAIT_DAYS;
  sim.dayUndoCheckpoint = null;
  if (rebuildPlans) rebuildDailyPlans(sim, sim.currentDate);
}

function pushHistory(sim) {
  sim.historyStack.push(captureSimCheckpoint(sim));
  if (sim.historyStack.length > 120) sim.historyStack.shift();
}

/** 是否可后退一天 */
export function canStepBack(sim) {
  if (sim.pendingDecision && sim.dayUndoCheckpoint) return true;
  return sim.historyStack.length > 1;
}

/** 后退一天（撤销上一日或取消当日未完成的步进） */
export function stepBackSimulation(sim) {
  if (sim.pendingDecision && sim.dayUndoCheckpoint) {
    restoreSimCheckpoint(sim, sim.dayUndoCheckpoint);
    sim.runState = SimState.PAUSED;
    log(sim, { type: 'sys', message: `后退：取消 ${formatDate(sim.currentDate)} 当日待决策步进` });
    return { ok: true };
  }
  if (sim.historyStack.length <= 1) {
    return { ok: false, reason: 'at-start' };
  }
  sim.historyStack.pop();
  const prev = sim.historyStack[sim.historyStack.length - 1];
  restoreSimCheckpoint(sim, prev);
  sim.runState = SimState.PAUSED;
  log(sim, { type: 'sys', message: `后退至 ${formatDate(sim.currentDate)}` });
  return { ok: true };
}

function log(sim, entry) {
  sim.events.unshift({ time: formatDate(sim.currentDate), ...entry });
  if (sim.events.length > 500) sim.events.length = 500;
}

/** 重建未来 60 天日排产缓存（原料约束 + 提前期补单投影） */
export function rebuildDailyPlans(sim, fromDate) {
  const currentStr = formatDate(sim.currentDate);
  const fromDateStr = normalizeRebuildStartDate(sim, fromDate);
  if (fromDateStr <= currentStr) {
    rebuildDailyPlansWithProcurement(sim, refreshProcurement, PLANNING_HORIZON_DAYS);
    return;
  }

  const offset = diffDays(sim.currentDate, parseDate(fromDateStr));
  const remainingDays = PLANNING_HORIZON_DAYS - offset;
  if (remainingDays <= 0) return;

  const shadow = fastForwardShadowToDate(sim, fromDateStr);
  rebuildDailyPlansWithProcurement(shadow, refreshProcurement, remainingDays);

  mergePlanSuffix(sim.dailyPlansCache, shadow.dailyPlansCache, fromDateStr);
  sim._idealDailyPlans = sim._idealDailyPlans ?? new Map();
  mergePlanSuffix(sim._idealDailyPlans, shadow._idealDailyPlans ?? new Map(), fromDateStr);
  mergeProcurementSuffix(sim, shadow.procurement.orders, fromDateStr);
  mergeSsBatchTargetSuffix(sim, shadow.ssBatchTargets, fromDateStr);
}

/** 初始化 / 重置仿真 */
export function resetSimulation(sim, startDateStr) {
  if (sim.timer) clearInterval(sim.timer);
  sim.timer = null;
  sim.currentDate = parseDate(startDateStr);
  sim.taskState = createTaskState(sim.productIds);
  sim.inventory = createInventory(sim.productIds, sim.materialIds);
  sim.procurement = createProcurementState();
  resetPoSeq();
  sim.events = [];
  sim.stats = { manualDecisions: 0, lastDayProduced: 0, lastDayPlanned: 0 };
  sim.dailyPlansCache = new Map();
  sim.todayActual = new Map(sim.productIds.map((id) => [id, 0]));
  sim.pendingDecision = null;
  sim.runState = SimState.IDLE;
  sim.historyStack = [];
  sim.dayUndoCheckpoint = null;
  sim.scheduleHistory = createScheduleHistory();
  sim._simStartDate = startDateStr;
  sim.dailyCapacityCache = new Map();
  clearPendingDailyCapacity(sim);
  sim.policyComparisonResults = null;
  sim.ssBatchTargets = createSsBatchTargets();
  sim.openDeliveryOrders = createOpenDeliveryOrders();
  // 保留 Policy 中配置的订单丢失等待天数

  log(sim, { type: 'sys', message: `仿真重置，起始 ${startDateStr}（原料/成品库存均为 0，自当日起按 SS 触发采购与补产）` });

  const bootstrapped = applyDemandNoticesUpTo(
    sim.taskState,
    sim.master.demandNotices,
    startDateStr,
    (e) => log(sim, { ...e, message: `[初始化] ${e.message}` })
  );
  if (bootstrapped) {
    log(sim, {
      type: 'sys',
      message: `已提前应用 ${startDateStr} 及之前的全部需求通报（含 2025-12-30 首版）`,
    });
  }

  rebuildDailyPlans(sim, sim.currentDate);
  sim.inventoryHistory = [];
  recordInventorySnapshot(
    sim,
    startDateStr,
    summarizeDeliveryOrders(sim.openDeliveryOrders ?? [], startDateStr)
  );
  sim.historyStack = [captureSimCheckpoint(sim)];
}

function refreshProcurement(sim) {
  const horizonEnd = addDays(sim.currentDate, 59);
  // 倒推 PO 必须按理想产量（含 SS 批次），不能用可行计划（否则无 PO→无料→可行恒为 0）
  const plansForPo = sim._idealDailyPlans ?? sim.dailyPlansCache;
  syncPurchaseOrders({
    procurement: sim.procurement,
    inventory: sim.inventory,
    bomIndex: sim.bomIndex,
    materialIndex: sim.materialIndex,
    safetyStock: sim.safetyStock,
    productIds: sim.productIds,
    dailyPlansByDate: plansForPo,
    scheduleHistory: sim.scheduleHistory,
    horizonStart: sim.currentDate,
    horizonEnd,
    leadTimeCarryUp: sim._leadTimeCarryUp ?? new Map(),
    supplierPolicy: sim.supplierPolicy,
    rawMaterialPolicy: sim.rawMaterialPolicy,
    materialUsageWeights: sim.materialUsageWeights,
    log: (e) => log(sim, e),
  });
}

function productionLineCtx(sim) {
  return { bomIndex: sim.bomIndex, productionPolicy: sim.productionPolicy };
}

/** 分析当日生产：返回 { plan, kitStatus, needManual } */
export function analyzeProductionDay(sim) {
  const ds = formatDate(sim.currentDate);
  const planRaw = sim.dailyPlansCache.get(ds) ?? new Map();
  const planningCap = getPlanningDailyCapacity(sim, ds);
  const plan = applyCapacityLimit(planRaw, planningCap, sim.productIds);
  const kitInv = inventoryForKitCheck(sim.inventory, sim.procurement, ds);
  const ctx = productionLineCtx(sim);
  const achievableMap = buildDailyProductionFromPlan(ctx, plan, kitInv, sim.productIds, ds);
  const kitStatus = new Map();
  const blocked = [];
  const ready = [];

  for (const pid of sim.productIds) {
    const qty = plan.get(pid) ?? 0;
    const achievable = achievableMap.get(pid) ?? 0;
    const fullKit = qty <= 0 || achievable + 1e-9 >= qty;
    kitStatus.set(pid, {
      planned: qty,
      kitReady: fullKit,
      partialKit: qty > 0 && achievable > 0 && !fullKit,
      maxQty: qty > 0 ? achievable : 0,
      includesTodayArrival: true,
    });
    if (qty > 0 && achievable <= 0) blocked.push(pid);
    if (achievable > 0) ready.push(pid);
  }

  const alternatives = ready.filter((pid) => {
    const p = plan.get(pid) ?? 0;
    return p > 0 || blocked.length > 0;
  });

  const needManual = blocked.length > 0 && alternatives.length > 1;

  return { plan, kitStatus, blocked, alternatives, needManual };
}

/** 分析当日缺料：SKU 概览 + 原料明细（齐套判断含当日计划到货） */
export function analyzeMaterialShortages(sim) {
  const ds = formatDate(sim.currentDate);
  const plan = sim.dailyPlansCache.get(ds) ?? new Map();
  const kitInv = inventoryForKitCheck(sim.inventory, sim.procurement, ds);

  const skuRows = [];
  const materialAgg = new Map();
  const ctx = productionLineCtx(sim);
  const achievableMap = buildDailyProductionFromPlan(ctx, plan, kitInv, sim.productIds, ds);

  for (const pid of sim.productIds) {
    const planned = plan.get(pid) ?? 0;
    if (planned <= 0) continue;

    const bom = sim.bomIndex.get(pid) ?? [];
    const achievable = achievableMap.get(pid) ?? 0;
    const kitReady = achievable + 1e-9 >= planned;
    const shortages = findShortages(kitInv, bom, planned);

    skuRows.push({
      productId: pid,
      planned,
      kitReady,
      maxQty: achievable,
      shortageCount: shortages.length,
    });

    if (achievable + 1e-9 < planned) {
      for (const s of shortages) {
        const cur = materialAgg.get(s.materialId) ?? {
          materialId: s.materialId,
          need: 0,
          have: getRaw(kitInv, s.materialId),
          productIds: new Set(),
        };
        cur.need += s.need;
        cur.have = getRaw(kitInv, s.materialId);
        cur.productIds.add(pid);
        materialAgg.set(s.materialId, cur);
      }
    }
  }

  const materialRows = [...materialAgg.values()]
    .map((row) => {
      const mat = sim.materialIndex.get(row.materialId);
      const rawStock = getRaw(sim.inventory, row.materialId);
      const todayArrival = sim.procurement.orders
        .filter(
          (o) =>
            !o.cancelled &&
            !o.received &&
            o.materialId === row.materialId &&
            o.arriveDate === ds
        )
        .reduce((sum, o) => sum + o.qty, 0);
      const transit = inTransitQty(sim.procurement, row.materialId, sim.currentDate);
      const gap = Math.max(0, row.need - row.have);

      return {
        materialId: row.materialId,
        name: mat?.name ?? '',
        productIds: [...row.productIds],
        need: row.need,
        have: row.have,
        rawStock,
        todayArrival,
        inTransit: transit,
        gap,
      };
    })
    .sort((a, b) => b.gap - a.gap || b.need - a.need);

  const shortageSkuCount = skuRows.filter((r) => !r.kitReady).length;

  return {
    skuRows,
    materialRows,
    shortageSkuCount,
    shortageMaterialCount: materialRows.length,
    hasShortage: shortageSkuCount > 0,
  };
}

/** 日终：库存达 SS 则清除锁定；批次日已过仍低于 SS 则清除以便 MRP 重排下一批 */
function finalizeSsBatchTargets(sim) {
  const today = formatDate(sim.currentDate);
  for (const pid of sim.productIds) {
    const ss = sim.safetyStock.finishedGoods[String(pid)] ?? 0;
    if (ss <= 0) continue;
    const stock = getFinished(sim.inventory, pid);
    if (stock + 1e-9 >= ss) {
      sim.ssBatchTargets?.delete(pid);
      continue;
    }
    const target = sim.ssBatchTargets?.get(pid);
    if (target && target.productionDate <= today) {
      sim.ssBatchTargets.delete(pid);
    }
  }
}

/** 当日日订单：登记整单 → 按交期先后整单出库（不允许拆单） */
function fulfillDailyDemand(sim, logFn) {
  if (!sim.openDeliveryOrders) sim.openDeliveryOrders = createOpenDeliveryOrders();
  const ds = formatDate(sim.currentDate);
  const demandPlan = registerDailyOrdersForDay(
    sim.openDeliveryOrders,
    sim.taskState,
    sim.productIds,
    sim.currentDate
  );
  const dueDeliveryQty = calcDueDeliveryBacklog(sim.openDeliveryOrders, ds);
  const lostWait = getOrderLostWaitDays(sim);
  const { shippedTotal, pendingCount, lostCount, lostQty } = fulfillOpenDeliveryOrders(
    sim.inventory,
    sim.openDeliveryOrders,
    ds,
    logFn,
    lostWait
  );
  if (pendingCount > 0) {
    logFn?.({
      type: 'warn',
      message: `整单待交：${pendingCount} 笔订单库存未齐（不允许拆单，交期后 ${lostWait} 天未齐将丢失）`,
    });
  }
  if (lostCount > 0 && shippedTotal <= 0) {
    /* 丢失明细已在 fulfillOpenDeliveryOrders 逐笔记录 */
  } else if (shippedTotal > 0 && pendingCount === 0 && lostCount === 0) {
    logFn?.({
      type: 'ship',
      message: `${ds} 整单出库合计 ${Math.round(shippedTotal)} 件`,
    });
  }
  return {
    demandPlan,
    deliveryStats: summarizeDeliveryOrders(sim.openDeliveryOrders, ds, {
      shippedTotal,
      lostCount,
      lostQty,
      demandPlan,
      dueDeliveryQty,
    }),
  };
}

/** 将产量 Map 按 Batch / 起做量规范化 */
function normalizeActualMap(sim, actualMap) {
  const out = new Map();
  for (const pid of sim.productIds) {
    out.set(pid, normalizeProductionQty(actualMap.get(pid) ?? 0, pid, sim.productionPolicy));
  }
  return out;
}

/** 执行生产（按 todayActual 或自动） */
export function executeProduction(sim, actualMap) {
  let total = 0;
  const ds = formatDate(sim.currentDate);
  const lineOrder = getProductionLineOrder(sim.productIds, ds);
  for (const pid of lineOrder) {
    const qty = normalizeProductionQty(actualMap.get(pid) ?? 0, pid, sim.productionPolicy);
    if (qty <= 0) continue;
    const bom = sim.bomIndex.get(pid) ?? [];
    const res = consumeBom(sim.inventory, bom, qty);
    if (!res.ok) {
      log(sim, {
        type: 'warn',
        message: `生产未入库 SKU ${pid} × ${qty}：共线扣料冲突（前序 SKU 已占用原料）`,
      });
      continue;
    }
    sim.inventory.finished.set(pid, (sim.inventory.finished.get(pid) ?? 0) + qty);
    recordProduction(sim.taskState, pid, monthKey(sim.currentDate), qty);
    total += qty;
    log(sim, { type: 'prod', message: `生产 SKU ${pid} × ${qty}` });
  }
  sim.stats.lastDayProduced = total;
  return total;
}

/**
 * 自动步进直到到达目标日（含目标日本身，不进入目标日之后）
 * @returns {{ ok: boolean, steps: number, date: string, reason?: string }}
 */
export function jumpSimulationTo(sim, targetDateStr) {
  if (sim.pendingDecision) {
    return { ok: false, steps: 0, date: formatDate(sim.currentDate), reason: 'waiting' };
  }
  if (formatDate(sim.currentDate) >= targetDateStr) {
    return { ok: true, steps: 0, date: formatDate(sim.currentDate), reason: 'already' };
  }

  let steps = 0;
  const maxSteps = 400;

  while (formatDate(sim.currentDate) < targetDateStr && steps < maxSteps) {
    const result = stepSimulation(sim);
    steps += 1;
    if (result.reason === 'manual') {
      return { ok: false, steps, date: formatDate(sim.currentDate), reason: 'manual' };
    }
    if (!result.advanced) {
      return { ok: false, steps, date: formatDate(sim.currentDate), reason: result.reason ?? 'blocked' };
    }
  }

  const reached = formatDate(sim.currentDate) >= targetDateStr;
  return {
    ok: reached,
    steps,
    date: formatDate(sim.currentDate),
    reason: reached ? undefined : 'maxSteps',
  };
}

/** 单步仿真（1 天） */
export function stepSimulation(sim) {
  if (sim.pendingDecision) return { advanced: false, reason: 'waiting' };

  sim.dayUndoCheckpoint = captureSimCheckpoint(sim);

  const ds = formatDate(sim.currentDate);

  processArrivals(sim.procurement, sim.inventory, sim.currentDate, (e) => log(sim, e));

  beginDailyCapacityDraw(sim, ds);

  const demandChanged = applyDemandNotices(
    sim.taskState,
    sim.master.demandNotices,
    sim.currentDate,
    (e) => log(sim, e)
  );
  if (demandChanged) {
    rebuildDailyPlans(sim, sim.currentDate);
    log(sim, {
      type: 'sys',
      message: '需求通报变更：日计划已按原料约束刷新；可改 PO 已同步改量（含提前期缺口补单）',
    });
  }

  const { plan, kitStatus, blocked, alternatives, needManual } = analyzeProductionDay(sim);
  sim.stats.lastDayPlanned = [...plan.values()].reduce((a, b) => a + b, 0);
  sim.todayActual = new Map(sim.productIds.map((id) => [id, 0]));

  if (needManual) {
    sim.pendingDecision = { plan, kitStatus, blocked, alternatives };
    sim.runState = SimState.WAITING_USER;
    log(sim, { type: 'decision', message: `缺料且多个 SKU 可转产，等待人工决策` });
    return { advanced: false, reason: 'manual' };
  }

  const kitInv = inventoryForKitCheck(sim.inventory, sim.procurement, ds);
  const dailyCapacity = getActiveDayCapacity(sim, ds);
  const actual = buildDailyProductionFromPlan(productionLineCtx(sim), plan, kitInv, sim.productIds, ds);

  sim.todayActual = normalizeActualMap(sim, applyCapacityLimit(actual, dailyCapacity, sim.productIds));
  recordDaySchedule(sim, ds, plan, sim.todayActual);
  executeProduction(sim, sim.todayActual);
  /** 整单日志延后写入，避免被日末 rebuild 采购日志淹没 */
  const dayFulfillLogs = [];
  const { deliveryStats } = fulfillDailyDemand(sim, (e) => dayFulfillLogs.push(e));
  finalizeSsBatchTargets(sim);

  sim._lastOpenPo = openPoCount(sim.procurement, sim.currentDate);
  sim._lastShortageSkus = analyzeMaterialShortages(sim).shortageSkuCount;
  recordInventorySnapshot(sim, ds, deliveryStats);

  commitDailyCapacity(sim, ds);
  ensureCapacityForecastSchedule(sim);
  const capPolicy = getCapacityPolicyForDate(sim.capacityForecastSchedule, ds, sim._simStartDate);
  log(sim, {
    type: 'sys',
    message: `${ds} 日结束：当日产能上限揭晓为 ${sim.dailyCapacityCache.get(ds)} 件（${buildCapacityDistributionHint(capPolicy)}）`,
  });

  sim.currentDate = addDays(sim.currentDate, 1);
  rebuildDailyPlans(sim, sim.currentDate);
  for (const e of dayFulfillLogs) log(sim, e);
  sim.dayUndoCheckpoint = null;
  pushHistory(sim);

  return { advanced: true };
}

/** 用户确认生产决策 */
export function applyManualDecision(sim, actualMap) {
  const ds = formatDate(sim.currentDate);
  const plan = sim.pendingDecision?.plan ?? new Map();
  const dailyCapacity = getActiveDayCapacity(sim, ds);
  const kitInv = inventoryForKitCheck(sim.inventory, sim.procurement, ds);
  const capped = normalizeActualMap(
    sim,
    applyCapacityLimit(actualMap, dailyCapacity, sim.productIds)
  );
  const sequential = applySequentialProductionCap(
    productionLineCtx(sim),
    capped,
    kitInv,
    sim.productIds,
    ds
  );
  recordDaySchedule(sim, ds, plan, sequential);
  sim.todayActual = sequential;
  executeProduction(sim, sequential);
  const dayFulfillLogs = [];
  const { deliveryStats } = fulfillDailyDemand(sim, (e) => dayFulfillLogs.push(e));
  finalizeSsBatchTargets(sim);
  sim.stats.manualDecisions += 1;
  sim.pendingDecision = null;
  sim.runState = SimState.PAUSED;

  sim._lastOpenPo = openPoCount(sim.procurement, sim.currentDate);
  sim._lastShortageSkus = analyzeMaterialShortages(sim).shortageSkuCount;
  recordInventorySnapshot(sim, ds, deliveryStats);

  commitDailyCapacity(sim, ds);
  ensureCapacityForecastSchedule(sim);
  const capPolicy = getCapacityPolicyForDate(sim.capacityForecastSchedule, ds, sim._simStartDate);
  log(sim, {
    type: 'sys',
    message: `${ds} 日结束：当日产能上限揭晓为 ${sim.dailyCapacityCache.get(ds)} 件（${buildCapacityDistributionHint(capPolicy)}）`,
  });

  sim.currentDate = addDays(sim.currentDate, 1);
  rebuildDailyPlans(sim, sim.currentDate);
  for (const e of dayFulfillLogs) log(sim, e);
  sim.dayUndoCheckpoint = null;
  pushHistory(sim);
}

export { getScheduleTimeline } from './schedule-history.js';
export { getRawPolicyLabel, RAW_MATERIAL_POLICY_TYPES, createRawMaterialPolicy } from './raw-material-policy.js';

export function getSnapshot(sim) {
  const ds = formatDate(sim.currentDate);
  const mk = monthKey(sim.currentDate);
  const { plan, kitStatus } = analyzeProductionDay(sim);
  const dailyCapacity = getRevealedDailyCapacity(sim, ds);
  ensureCapacityForecastSchedule(sim);
  const capPolicy = getCapacityPolicyForDate(
    sim.capacityForecastSchedule,
    ds,
    sim._simStartDate
  );

  return {
    date: ds,
    monthKey: mk,
    runState: sim.runState,
    plan,
    kitStatus,
    dailyCapacity,
    capacityDistributionHint: buildCapacityDistributionHint(capPolicy),
    capacityForecastHint: buildCapacityForecastScheduleHint(
      sim.capacityForecastSchedule,
      ds,
      sim._simStartDate
    ),
    capacityRevealedToday: dailyCapacity != null,
    todayActual: sim.todayActual,
    pendingDecision: sim.pendingDecision,
    stats: { ...sim.stats },
    openPo: openPoCount(sim.procurement, sim.currentDate),
    belowSafety: countBelowSafety(
      sim.inventory,
      sim.safetyStock,
      sim.productIds,
      sim.materialIds
    ),
    monthRemaining: Object.fromEntries(
      sim.productIds.map((id) => [id, getMonthRemaining(sim.taskState, id, mk)])
    ),
    effectiveTasks: Object.fromEntries(
      sim.productIds.map((id) => [id, sim.taskState.effectiveTasks.get(id)?.get(mk) ?? 0])
    ),
    producedThisMonth: Object.fromEntries(
      sim.productIds.map((id) => [id, sim.taskState.producedThisMonth.get(id)?.get(mk) ?? 0])
    ),
    events: sim.events,
    procurementOrders: sim.procurement.orders.filter((o) => !o.cancelled).slice(-30),
    inventoryRawSample: [...sim.inventory.raw.entries()].slice(0, 20),
    safetyStock: sim.safetyStock,
    canStepBack: canStepBack(sim),
    shortageReport: analyzeMaterialShortages(sim),
    rawMaterialPolicy: { ...sim.rawMaterialPolicy },
    productionPolicy: cloneProductionPolicy(sim.productionPolicy),
    supplierPolicy: cloneSupplierPolicy(sim.supplierPolicy),
    capacityPolicy: cloneCapacityPolicy(sim.capacityPolicy),
    inventoryHistory: (sim.inventoryHistory ?? []).slice(-120),
    policyComparisonResults: sim.policyComparisonResults,
    finishedInventory: Object.fromEntries(
      sim.productIds.map((id) => [id, sim.inventory.finished.get(id) ?? 0])
    ),
    ssBatchByProduct: Object.fromEntries(
      sim.productIds.map((id) => {
        const t = sim.ssBatchTargets?.get(id);
        const ss = sim.safetyStock.finishedGoods[String(id)] ?? 0;
        const stock = sim.inventory.finished.get(id) ?? 0;
        return [
          id,
          {
            ss,
            stock,
            nextBatchDate: t?.productionDate ?? null,
            nextBatchQty: t?.qty ?? 0,
            belowSs: ss > 0 && stock + 1e-9 < ss,
          },
        ];
      })
    ),
    deliverySummary: summarizeDeliveryOrders(sim.openDeliveryOrders ?? [], ds),
    openDeliveryOrders: cloneOpenDeliveryOrders(sim.openDeliveryOrders),
    orderLostWaitDays: sim.orderLostWaitDays ?? DEFAULT_ORDER_LOST_WAIT_DAYS,
  };
}
