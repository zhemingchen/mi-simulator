/**
 * 生产计划时间线：历史实际产量 + 未来可行日计划
 */

import { addDays, formatDate, parseDate } from './scheduler.js';

/**
 * @param {object} sim
 * @param {'total'|string|number} productSelection total 或 SKU id
 * @param {number} horizonDays
 */
export function buildProductionPlanTimeline(sim, productSelection = 'total', horizonDays = 60) {
  const asOf = formatDate(sim.currentDate);
  const dates = new Set();

  for (const dateStr of Object.keys(sim.scheduleHistory ?? {})) {
    dates.add(dateStr);
  }
  for (const h of sim.inventoryHistory ?? []) {
    if (h.date <= asOf) dates.add(h.date);
  }

  let d = parseDate(asOf);
  for (let i = 0; i < horizonDays; i++) {
    dates.add(formatDate(d));
    d = addDays(d, 1);
  }

  const isTotal = productSelection === 'total';
  const pid = isTotal ? null : Number(productSelection);

  const sumActual = (rec) =>
    sim.productIds.reduce((s, id) => s + (rec?.[id] ?? 0), 0);

  const sumPlan = (plan) =>
    sim.productIds.reduce((s, id) => s + (plan?.get(id) ?? 0), 0);

  return [...dates].sort().map((dateStr) => {
    const hist = sim.scheduleHistory?.[dateStr];
    // 实际产量仅来自已步进完成的 scheduleHistory，不用 todayActual（会残留上日数据）
    let actual = 0;
    if (hist) {
      actual = isTotal ? sumActual(hist.actual) : (hist.actual[pid] ?? 0);
    }

    const plan = sim.dailyPlansCache?.get(dateStr);
    // 预计产量：今天及未来（可行日计划）；当天尚未步进完成，无 scheduleHistory 实际值
    let forecast = 0;
    if (dateStr >= asOf) {
      forecast = isTotal ? sumPlan(plan) : (plan?.get(pid) ?? 0);
    }

    let phase = 'future';
    if (dateStr < asOf) phase = 'past';
    else if (dateStr === asOf) phase = 'today';

    return { date: dateStr, phase, actual, forecast };
  });
}
