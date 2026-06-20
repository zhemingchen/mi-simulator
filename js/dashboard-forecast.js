/**
 * Dashboard 前瞻：shadow 仿真逐日投影（与 stepSimulation 对齐，仅保留三类可解释差异）
 * 1. 未来需求通报未纳入  2. 供应商随机延期  3. 当日产能揭晓（前瞻用计划均值）
 */

import { addDays, formatDate, parseDate } from './scheduler.js';
import {
  calcDueDeliveryBacklog,
} from './order-delivery.js';
import { getPoSeq, setPoSeq } from './procurement.js';
import {
  cloneSimulationForProjection,
  projectSimulationDay,
  rebuildDailyPlansForProjection,
} from './simulation.js';

export const DEFAULT_FORWARD_PROJECTION_DAYS = 60;

/** 按 SKU 汇总日末待交 backlog 与累计丢失 */
export function snapshotDeliveryByProduct(openOrders, productIds, asOfDateStr) {
  const pendingDueByProduct = {};
  const lostQtyCumulativeByProduct = {};
  for (const pid of productIds) {
    pendingDueByProduct[pid] = 0;
    lostQtyCumulativeByProduct[pid] = 0;
  }
  for (const o of openOrders ?? []) {
    if (o.status === 'pending' && o.deliveryDate <= asOfDateStr) {
      pendingDueByProduct[o.pid] = (pendingDueByProduct[o.pid] ?? 0) + o.qty;
    }
    if (o.status === 'lost') {
      lostQtyCumulativeByProduct[o.pid] = (lostQtyCumulativeByProduct[o.pid] ?? 0) + o.qty;
    }
  }
  return { pendingDueByProduct, lostQtyCumulativeByProduct };
}

function snapshotFinishedByProduct(inventory, productIds) {
  const finishedByProduct = {};
  for (const id of productIds) {
    finishedByProduct[id] = inventory.finished.get(id) ?? 0;
  }
  return finishedByProduct;
}

function calcDueDeliveryBacklogByProduct(openOrders, productIds, asOfDateStr) {
  const dueOrderByProduct = {};
  for (const pid of productIds) dueOrderByProduct[pid] = 0;
  for (const o of openOrders ?? []) {
    if (o.status === 'pending' && o.deliveryDate <= asOfDateStr) {
      dueOrderByProduct[o.pid] = (dueOrderByProduct[o.pid] ?? 0) + o.qty;
    }
  }
  return dueOrderByProduct;
}

function snapshotRawInventory(sim, rawMap) {
  const rawByMaterial = {};
  let rawTotal = 0;
  for (const id of sim.materialIds) {
    const q = rawMap.get(id) ?? 0;
    rawTotal += q;
    if (q > 1e-9) rawByMaterial[String(id)] = q;
  }
  return { rawTotal, rawByMaterial };
}

function buildProjectionRow(shadow, sim, dateStr, deliveryStats, trackRaw) {
  const dueOrderQty = calcDueDeliveryBacklog(shadow.openDeliveryOrders, dateStr);
  const dueOrderByProduct = calcDueDeliveryBacklogByProduct(
    shadow.openDeliveryOrders,
    sim.productIds,
    dateStr
  );
  const finishedAvailable = sim.productIds.reduce(
    (s, id) => s + (shadow.inventory.finished.get(id) ?? 0),
    0
  );
  const finishedByProduct = snapshotFinishedByProduct(shadow.inventory, sim.productIds);
  const { pendingDueByProduct, lostQtyCumulativeByProduct } = snapshotDeliveryByProduct(
    shadow.openDeliveryOrders,
    sim.productIds,
    dateStr
  );

  const todayOrderQty = deliveryStats.todayOrderQty ?? 0;

  const row = {
    date: dateStr,
    isToday: dateStr === formatDate(sim.currentDate),
    finishedAvailable,
    finishedByProduct,
    dueOrderQty,
    dueOrderByProduct,
    todayOrderQty,
    produced: shadow.stats.lastDayProduced ?? 0,
    shippedQty: deliveryStats.shippedTotal ?? 0,
    pendingDueQty: deliveryStats.pendingDueQty ?? 0,
    pendingDueByProduct,
    pendingDueCount: deliveryStats.pendingDueCount ?? 0,
    lostQtyToday: deliveryStats.lostQtyToday ?? 0,
    lostCountToday: deliveryStats.lostCountToday ?? 0,
    lostQtyCumulative: deliveryStats.lostQtyCumulative ?? 0,
    lostQtyCumulativeByProduct,
    lostCountCumulative: deliveryStats.lostCountCumulative ?? 0,
  };

  if (trackRaw) {
    Object.assign(row, snapshotRawInventory(sim, shadow.inventory.raw));
  }

  return row;
}

/**
 * 自 asOfDate 起逐日 shadow 仿真投影
 * @param {{ trackRaw?: boolean }} options
 */
export function runForwardProjection(
  sim,
  horizonDays = DEFAULT_FORWARD_PROJECTION_DAYS,
  { trackRaw = false } = {}
) {
  const asOfStr = formatDate(sim.currentDate);
  const savedPoSeq = getPoSeq();
  const shadow = cloneSimulationForProjection(sim);
  const rows = [];

  try {
    for (let i = 0; i < horizonDays; i++) {
      const dateStr = formatDate(shadow.currentDate);
      const deliveryStats = projectSimulationDay(shadow);
      rows.push(buildProjectionRow(shadow, sim, dateStr, deliveryStats, trackRaw));

      shadow.currentDate = addDays(shadow.currentDate, 1);
      if (i < horizonDays - 1) {
        rebuildDailyPlansForProjection(shadow, horizonDays - i - 1);
      }
    }
  } finally {
    setPoSeq(savedPoSeq);
  }

  return { asOfDate: asOfStr, horizonDays, rows };
}

let activeProjectionJob = 0;
let activeProjectionWorker = null;

function projectionCacheKey(sim) {
  return formatDate(sim.currentDate);
}

/** 使前瞻缓存失效（仿真步进/重置后自动因日期变化失效，也可主动调用以取消进行中的任务） */
export function invalidateForwardProjectionCache(sim) {
  if (sim) {
    sim._forwardProjectionCache = null;
    sim._forwardProjectionCacheKey = null;
  }
  activeProjectionWorker?.terminate();
  activeProjectionWorker = null;
  activeProjectionJob += 1;
}

/** 读取当日前瞻缓存（日期不匹配则返回 null） */
export function getForwardProjectionCache(sim) {
  const key = projectionCacheKey(sim);
  if (sim._forwardProjectionCache && sim._forwardProjectionCacheKey === key) {
    return sim._forwardProjectionCache;
  }
  return null;
}

function storeForwardProjectionCache(sim, result, horizonDays) {
  sim._forwardProjectionCache = { ...result, horizonDays };
  sim._forwardProjectionCacheKey = projectionCacheKey(sim);
}

function ensureCachedForwardProjection(sim, horizonDays = DEFAULT_FORWARD_PROJECTION_DAYS) {
  const cached = getForwardProjectionCache(sim);
  if (cached && cached.horizonDays === horizonDays) return cached;
  const result = runForwardProjection(sim, horizonDays, { trackRaw: true });
  storeForwardProjectionCache(sim, result, horizonDays);
  return getForwardProjectionCache(sim);
}

function createProjectionWorker() {
  return new Worker(new URL('./dashboard-forecast-worker.js', import.meta.url), { type: 'module' });
}

/**
 * 异步前瞻（完整计算完成后一次性渲染）
 * @param {(result: object) => void} onReady
 * @returns {() => void} cancel
 */
export function scheduleForwardProjection(
  sim,
  horizonDays = DEFAULT_FORWARD_PROJECTION_DAYS,
  onReady
) {
  if (typeof onReady === 'object' && onReady !== null) {
    onReady = onReady.onReady;
  }

  const cached = getForwardProjectionCache(sim);
  if (cached && cached.horizonDays === horizonDays) {
    onReady?.(cached);
    return () => {};
  }

  const jobId = ++activeProjectionJob;
  let cancelled = false;

  if (typeof Worker !== 'undefined') {
    const worker = createProjectionWorker();
    activeProjectionWorker?.terminate();
    activeProjectionWorker = worker;

    worker.onmessage = ({ data }) => {
      if (cancelled || jobId !== activeProjectionJob) return;
      if (data?.jobId !== jobId) return;

      if (data?.type === 'ready') {
        const result = data.payload;
        storeForwardProjectionCache(sim, result, horizonDays);
        if (activeProjectionWorker === worker) activeProjectionWorker = null;
        worker.terminate();
        onReady?.(getForwardProjectionCache(sim));
        return;
      }

      if (data?.type === 'error') {
        console.error('前瞻计算失败', data.message);
        if (activeProjectionWorker === worker) activeProjectionWorker = null;
        worker.terminate();
      }
    };

    worker.onerror = (err) => {
      if (cancelled || jobId !== activeProjectionJob) return;
      console.error('前瞻 Worker 失败', err);
      if (activeProjectionWorker === worker) activeProjectionWorker = null;
      worker.terminate();
    };

    worker.postMessage({ jobId, sim, horizonDays });

    return () => {
      cancelled = true;
      if (activeProjectionWorker === worker) activeProjectionWorker = null;
      worker.terminate();
    };
  }

  (async () => {
    try {
      const result = runForwardProjection(sim, horizonDays, { trackRaw: true });

      if (cancelled || jobId !== activeProjectionJob) return;
      storeForwardProjectionCache(sim, result, horizonDays);
      onReady?.(getForwardProjectionCache(sim));
    } catch (err) {
      console.error('前瞻计算失败', err);
    }
  })();

  return () => {
    cancelled = true;
  };
}

/**
 * Dashboard 成品 / 交货前瞻
 * @returns {{ asOfDate: string, horizonDays: number, rows: Array<object> }}
 */
export function buildDashboardForwardProjection(
  sim,
  horizonDays = DEFAULT_FORWARD_PROJECTION_DAYS
) {
  const cached = ensureCachedForwardProjection(sim, horizonDays);
  return { asOfDate: cached.asOfDate, horizonDays: cached.horizonDays, rows: cached.rows };
}

/**
 * 原料库存前瞻（日末账面）
 * @returns {{ asOfDate: string, horizonDays: number, rows: Array<{ date, rawTotal, rawByMaterial }> }}
 */
export function buildRawMaterialForwardProjection(
  sim,
  horizonDays = DEFAULT_FORWARD_PROJECTION_DAYS
) {
  const cached = ensureCachedForwardProjection(sim, horizonDays);
  return {
    asOfDate: cached.asOfDate,
    horizonDays: cached.horizonDays,
    rows: cached.rows.map(({ date, rawTotal, rawByMaterial }) => ({
      date,
      rawTotal,
      rawByMaterial,
    })),
  };
}

/** 合并历史实际 + 未来预测，供趋势图使用 */
export function mergeDashboardChartSeries(history, forecastRows, field, asOfDate) {
  const histValue = (h) => {
    if (field === 'dueOrderQty') {
      return (
        h.dueDeliveryQty ??
        (h.pendingDueQty ?? 0) + (h.shippedQty ?? 0) + (h.lostQtyToday ?? 0)
      );
    }
    if (field === 'finishedAvailable') return h.finishedAvailable ?? h.finishedTotal ?? 0;
    return h[field] ?? 0;
  };

  const actual = (history ?? [])
    .filter((h) => h.date < asOfDate)
    .map((h) => ({ date: h.date, value: histValue(h) }));

  const projected = (forecastRows ?? []).map((r) => ({
    date: r.date,
    value: r[field] ?? 0,
  }));

  return { actual, projected };
}

/** 供 Dashboard 趋势图：单指标拆成已发生 + 预计两段 */
export function buildDashboardMetricSeries(history, forecastRows, field, asOfDate, label, color) {
  const { actual, projected } = mergeDashboardChartSeries(history, forecastRows, field, asOfDate);
  return { label, color, actualPoints: actual, forecastPoints: projected };
}

function productFieldMap(field) {
  if (field === 'finishedAvailable') return { hist: 'finishedByProduct', forecast: 'finishedByProduct' };
  if (field === 'pendingDueQty') return { hist: 'pendingDueByProduct', forecast: 'pendingDueByProduct' };
  if (field === 'lostQtyCumulative') {
    return { hist: 'lostQtyCumulativeByProduct', forecast: 'lostQtyCumulativeByProduct' };
  }
  return null;
}

function readProductMetric(record, mapKey, productId) {
  if (!record || !mapKey) return 0;
  const bag = record[mapKey];
  if (!bag) return 0;
  return bag[productId] ?? bag[String(productId)] ?? 0;
}

/** 单 SKU 成品库存 / backlog / 丢失：历史 + 前瞻 */
export function buildDashboardProductMetricSeries(
  history,
  forecastRows,
  productId,
  field,
  asOfDate,
  label,
  color
) {
  const map = productFieldMap(field);
  const pid = Number(productId);
  const actual = (history ?? [])
    .filter((h) => h.date < asOfDate)
    .map((h) => ({
      date: h.date,
      value: readProductMetric(h, map?.hist, pid),
    }));
  const projected = (forecastRows ?? []).map((r) => ({
    date: r.date,
    value: readProductMetric(r, map?.forecast, pid),
  }));
  return { label, color, actualPoints: actual, forecastPoints: projected };
}

/** 从投影行读取指标（合计或单 SKU） */
export function readDashboardRowMetric(row, field, productSelection = 'total') {
  if (productSelection === 'total') return row[field] ?? 0;
  const pid = Number(productSelection);
  if (field === 'finishedAvailable') return readProductMetric(row, 'finishedByProduct', pid);
  if (field === 'pendingDueQty') return readProductMetric(row, 'pendingDueByProduct', pid);
  if (field === 'lostQtyCumulative') return readProductMetric(row, 'lostQtyCumulativeByProduct', pid);
  if (field === 'dueOrderQty') return readProductMetric(row, 'dueOrderByProduct', pid);
  return row[field] ?? 0;
}

/** 单原料库存：历史 + 前瞻 */
export function buildRawMaterialMetricSeries(
  history,
  forecastRows,
  materialId,
  asOfDate,
  label,
  color
) {
  const key = String(materialId);
  const actual = (history ?? [])
    .filter((h) => h.date < asOfDate)
    .map((h) => ({ date: h.date, value: h.rawByMaterial?.[key] ?? 0 }));
  const projected = (forecastRows ?? []).map((r) => ({
    date: r.date,
    value: r.rawByMaterial?.[key] ?? 0,
  }));
  return { label, color, actualPoints: actual, forecastPoints: projected };
}

/** 日末在途 PO 量（供应商来料 backlog） */
function snapshotInTransit(sim, orders, dateStr) {
  const inTransitByMaterial = {};
  let inTransitTotal = 0;
  for (const id of sim.materialIds) {
    let q = 0;
    for (const o of orders) {
      if (o.cancelled || o.received || o.materialId !== id) continue;
      if (o.orderDate <= dateStr && o.arriveDate > dateStr) q += o.qty;
    }
    inTransitTotal += q;
    if (q > 1e-9) inTransitByMaterial[String(id)] = q;
  }
  return { inTransitTotal, inTransitByMaterial };
}

/** 在途来料前瞻（按 PO 到货日推进；含供应商延期后的 arriveDate） */
export function buildInTransitForwardProjection(
  sim,
  horizonDays = DEFAULT_FORWARD_PROJECTION_DAYS
) {
  const asOfStr = formatDate(sim.currentDate);
  const orders = sim.procurement.orders.map((o) => ({ ...o }));

  const dates = [];
  let d = parseDate(asOfStr);
  for (let i = 0; i < horizonDays; i++) {
    dates.push(formatDate(d));
    d = addDays(d, 1);
  }

  const rows = [];
  for (const dateStr of dates) {
    for (const o of orders) {
      if (o.cancelled || o.received) continue;
      if (o.arriveDate > dateStr) continue;
      o.received = true;
    }
    rows.push({ date: dateStr, ...snapshotInTransit(sim, orders, dateStr) });
  }

  return { asOfDate: asOfStr, horizonDays, rows };
}

/** 单原料在途量：历史 + 前瞻 */
export function buildInTransitMaterialMetricSeries(
  history,
  forecastRows,
  materialId,
  asOfDate,
  label,
  color
) {
  const key = String(materialId);
  const actual = (history ?? [])
    .filter((h) => h.date < asOfDate)
    .map((h) => ({ date: h.date, value: h.inTransitByMaterial?.[key] ?? 0 }));
  const projected = (forecastRows ?? []).map((r) => ({
    date: r.date,
    value: r.inTransitByMaterial?.[key] ?? 0,
  }));
  return { label, color, actualPoints: actual, forecastPoints: projected };
}
