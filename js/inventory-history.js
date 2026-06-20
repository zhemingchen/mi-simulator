/**
 * 每日库存与生产历史（用于策略对比与趋势图）
 */

import { getRaw, getFinished } from './inventory.js';
import { inTransitQty } from './procurement.js';
import { snapshotDeliveryByProduct } from './dashboard-forecast.js';

export function createInventoryHistory() {
  return [];
}

/** 日终记录：生产、原料/成品库存汇总 + 订单交货指标 */
export function recordInventorySnapshot(sim, dateStr, deliveryStats = {}) {
  if (!sim.inventoryHistory) sim.inventoryHistory = [];

  let rawTotal = 0;
  let rawBelowSs = 0;
  const rawByMaterial = {};
  for (const id of sim.materialIds) {
    const stock = getRaw(sim.inventory, id);
    rawTotal += stock;
    if (stock > 1e-9) rawByMaterial[String(id)] = stock;
    const ss = sim.safetyStock.rawMaterials[String(id)] ?? 0;
    if (stock < ss) rawBelowSs += 1;
  }

  let finishedTotal = 0;
  let finishedSsTotal = 0;
  let finishedBelowSs = 0;
  const finishedByProduct = {};
  for (const id of sim.productIds) {
    const q = getFinished(sim.inventory, id);
    const ss = sim.safetyStock.finishedGoods[String(id)] ?? 0;
    finishedByProduct[id] = q;
    finishedTotal += q;
    finishedSsTotal += ss;
    if (q + 1e-9 < ss) finishedBelowSs += 1;
  }

  let rawSsRefTotal = 0;
  for (const id of sim.materialIds) {
    rawSsRefTotal += sim.safetyStock.rawMaterials[String(id)] ?? 0;
  }

  let inTransitTotal = 0;
  const inTransitByMaterial = {};
  for (const id of sim.materialIds) {
    const q = inTransitQty(sim.procurement, id, sim.currentDate);
    inTransitTotal += q;
    if (q > 1e-9) inTransitByMaterial[String(id)] = q;
  }

  const { pendingDueByProduct, lostQtyCumulativeByProduct } = snapshotDeliveryByProduct(
    sim.openDeliveryOrders,
    sim.productIds,
    dateStr
  );

  sim.inventoryHistory.push({
    date: dateStr,
    produced: sim.stats.lastDayProduced ?? 0,
    planned: sim.stats.lastDayPlanned ?? 0,
    rawTotal,
    rawByMaterial,
    rawBelowSs,
    rawSsRefTotal,
    finishedTotal,
    finishedSsTotal,
    finishedBelowSs,
    finishedByProduct,
    inTransitTotal,
    inTransitByMaterial,
    pendingDueByProduct,
    lostQtyCumulativeByProduct,
    openPo: sim._lastOpenPo ?? 0,
    shortageSkus: sim._lastShortageSkus ?? 0,
    finishedAvailable: finishedTotal,
    shippedQty: deliveryStats.shippedTotal ?? 0,
    todayOrderQty: deliveryStats.todayOrderQty ?? 0,
    dueDeliveryQty: deliveryStats.dueDeliveryQty ?? 0,
    pendingDueQty: deliveryStats.pendingDueQty ?? 0,
    pendingDueCount: deliveryStats.pendingDueCount ?? 0,
    lostQtyToday: deliveryStats.lostQtyToday ?? 0,
    lostCountToday: deliveryStats.lostCountToday ?? 0,
    lostQtyCumulative: deliveryStats.lostQtyCumulative ?? 0,
    lostCountCumulative: deliveryStats.lostCountCumulative ?? 0,
  });

  if (sim.inventoryHistory.length > 400) sim.inventoryHistory.shift();
}

export function sumFinished(history) {
  return history.reduce((s, h) => s + h.produced, 0);
}
