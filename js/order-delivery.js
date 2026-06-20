/**
 * 订单交货：整单交货、交期后等待 7 天未满足则丢失
 */

import { formatDate, parseDate, computeDailyPlan } from './scheduler.js';
import { getFinished } from './inventory.js';

/** 交期后最多等待天数，超时视为丢失（默认；仿真内可覆盖） */
export const DEFAULT_ORDER_LOST_WAIT_DAYS = 7;
export const ORDER_LOST_WAIT_DAYS = DEFAULT_ORDER_LOST_WAIT_DAYS;

export function getOrderLostWaitDays(simOrDays) {
  if (typeof simOrDays === 'number' && Number.isFinite(simOrDays)) {
    return Math.max(0, Math.floor(simOrDays));
  }
  return Math.max(0, Math.floor(simOrDays?.orderLostWaitDays ?? DEFAULT_ORDER_LOST_WAIT_DAYS));
}

export const ORDER_DELIVERY_STATUS_LABEL = {
  pending: '未交货',
  delivered: '已交货',
  lost: '丢失',
};

/** @typedef {{ deliveryDate: string, pid: number, qty: number, status: 'pending'|'delivered'|'lost', deliveredDate?: string }} OpenDeliveryOrder */

export function createOpenDeliveryOrders() {
  return [];
}

export function cloneOpenDeliveryOrders(orders) {
  return (orders ?? []).map((o) => ({ ...o }));
}

function dayDiff(fromDateStr, toDateStr) {
  const a = parseDate(fromDateStr);
  const b = parseDate(toDateStr);
  return Math.round((b - a) / 86400000);
}

/** 登记当日日订单（每张为一笔整单，交期 = 当日） */
export function registerDailyOrdersForDay(openOrders, taskState, productIds, asOfDate) {
  const deliveryDate = formatDate(asOfDate);
  const demandPlan = computeDailyPlan(taskState, productIds, asOfDate);
  for (const pid of productIds) {
    const qty = demandPlan.get(pid) ?? 0;
    if (qty <= 0) continue;
    openOrders.push({
      deliveryDate,
      pid,
      qty,
      status: 'pending',
    });
  }
  return demandPlan;
}

/** 交期 ≤ 当日且仍为 pending 的整单数量合计（登记后、出库前 = 当日需交货 backlog） */
export function calcDueDeliveryBacklog(openOrders, asOfDateStr) {
  let total = 0;
  for (const o of openOrders ?? []) {
    if (o.status === 'pending' && o.deliveryDate <= asOfDateStr) {
      total += o.qty;
    }
  }
  return total;
}

/**
 * 按交期先后尝试整单交货（不允许拆单）；超期未齐则丢失
 */
export function fulfillOpenDeliveryOrders(
  inventory,
  openOrders,
  dateStr,
  logFn,
  lostWaitDays = DEFAULT_ORDER_LOST_WAIT_DAYS
) {
  let shippedTotal = 0;
  let pendingCount = 0;
  let lostCount = 0;
  let lostQty = 0;

  const duePending = openOrders
    .filter((o) => o.status === 'pending' && o.deliveryDate <= dateStr)
    .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.pid - b.pid);

  for (const order of duePending) {
    const stock = getFinished(inventory, order.pid);
    if (stock + 1e-9 >= order.qty) {
      inventory.finished.set(order.pid, stock - order.qty);
      order.status = 'delivered';
      order.deliveredDate = dateStr;
      shippedTotal += order.qty;
      logFn?.({
        type: 'ship',
        message: `整单交货：SKU ${order.pid} × ${order.qty}（交期 ${order.deliveryDate}）`,
      });
      continue;
    }

    if (dayDiff(order.deliveryDate, dateStr) >= lostWaitDays) {
      order.status = 'lost';
      lostCount += 1;
      lostQty += order.qty;
      logFn?.({
        type: 'warn',
        message: `订单丢失：SKU ${order.pid} × ${order.qty}（交期 ${order.deliveryDate}，超 ${lostWaitDays} 天未齐套）`,
      });
    } else {
      pendingCount += 1;
    }
  }

  return { shippedTotal, pendingCount, lostCount, lostQty };
}

/**
 * 汇总订单交货指标（Dashboard / 日终快照）
 * @param {OpenDeliveryOrder[]} openOrders
 * @param {string} asOfDateStr
 * @param {{ shippedTotal?: number, lostCount?: number, lostQty?: number, demandPlan?: Map<number, number> }} dayStats
 */
export function summarizeDeliveryOrders(openOrders, asOfDateStr, dayStats = {}) {
  let pendingDueQty = 0;
  let pendingDueCount = 0;
  let lostQtyCumulative = 0;
  let lostCountCumulative = 0;

  for (const o of openOrders ?? []) {
    if (o.status === 'pending' && o.deliveryDate <= asOfDateStr) {
      pendingDueQty += o.qty;
      pendingDueCount += 1;
    }
    if (o.status === 'lost') {
      lostQtyCumulative += o.qty;
      lostCountCumulative += 1;
    }
  }

  let todayOrderQty = 0;
  for (const q of dayStats.demandPlan?.values() ?? []) {
    todayOrderQty += q ?? 0;
  }

  const shippedTotal = dayStats.shippedTotal ?? 0;
  const lostQtyToday = dayStats.lostQty ?? 0;
  const dueDeliveryQty =
    dayStats.dueDeliveryQty ?? pendingDueQty + shippedTotal + lostQtyToday;

  return {
    shippedTotal,
    pendingDueQty,
    pendingDueCount,
    lostQtyToday,
    lostCountToday: dayStats.lostCount ?? 0,
    lostQtyCumulative,
    lostCountCumulative,
    todayOrderQty,
    dueDeliveryQty,
  };
}

/**
 * 订单交货状态（排产趋势 / 订单表）：优先读仿真内 openDeliveryOrders，与未来待交一致
 * @returns {Map<string, { status: 'pending'|'delivered'|'lost', deliveredDate?: string }>}
 *   key = `${交期}|${productId}`
 */
export function computeOrderDeliveryStatuses(sim, timeline) {
  const current = formatDate(sim.currentDate);
  const result = new Map();

  for (const row of timeline) {
    for (const pid of sim.productIds) {
      const qty = row.planned[pid] ?? 0;
      if (qty <= 0) continue;
      const key = `${row.date}|${pid}`;
      if (row.date > current) {
        result.set(key, { status: 'pending' });
      }
    }
  }

  for (const o of sim.openDeliveryOrders ?? []) {
    result.set(`${o.deliveryDate}|${o.pid}`, {
      status: o.status,
      deliveredDate: o.deliveredDate,
    });
  }

  return result;
}

export function getOrderDeliveryStatus(statusMap, deliveryDate, pid) {
  return statusMap.get(`${deliveryDate}|${pid}`)?.status ?? 'pending';
}
