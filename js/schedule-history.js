/**
 * 日排产历史记录与时间线（过往实际 + 未来日订单）
 */

import { formatDate, addDays, addMonths, SCHEDULE_CHART_FUTURE_MONTHS, computeDailyPlanForecast } from './scheduler.js';

/** 6 SKU 固定配色 */
export const SKU_COLORS = {
  3200650: '#3b82f6',
  3200651: '#22c55e',
  3200652: '#ec4899',
  3200653: '#f59e0b',
  3200654: '#8b5cf6',
  3200655: '#06b6d4',
};

export function createScheduleHistory() {
  return {};
}

/** 记录已完成的一天：计划与实际产量 */
export function recordDaySchedule(sim, dateStr, planMap, actualMap) {
  const planned = {};
  const actual = {};
  for (const pid of sim.productIds) {
    planned[pid] = Math.max(0, Math.floor(planMap.get(pid) ?? 0));
    actual[pid] = Math.max(0, Math.floor(actualMap.get(pid) ?? 0));
  }
  sim.scheduleHistory[dateStr] = { planned, actual };
}

function sumRecord(rec, productIds) {
  return productIds.reduce((s, pid) => s + (rec[pid] ?? 0), 0);
}

/** 某日各 SKU 日订单（随机拆分，与排产趋势一致） */
function buildOrderPlanForDate(sim, dateStr) {
  const d = parseDateStr(dateStr);
  const planMap = computeDailyPlanForecast(sim.taskState, sim.productIds, sim.currentDate, d);
  const planned = {};
  for (const pid of sim.productIds) {
    planned[pid] = Math.max(0, Math.floor(planMap.get(pid) ?? 0));
  }
  return planned;
}

/**
 * 构建图表时间线：计划柱 = 日订单；实际 = 已发生产量
 * @returns {Array<{date, phase, planned, actual, totalPlanned, totalActual}>}
 */
export function getScheduleTimeline(sim) {
  const current = formatDate(sim.currentDate);
  const dates = new Set(Object.keys(sim.scheduleHistory));

  const start = sim._simStartDate ?? current;
  let d = parseDateStr(start);
  const end = addMonths(sim.currentDate, SCHEDULE_CHART_FUTURE_MONTHS);
  while (d <= end) {
    dates.add(formatDate(d));
    d = addDays(d, 1);
  }

  return [...dates]
    .sort()
    .map((date) => {
      const hist = sim.scheduleHistory[date];
      const planned = buildOrderPlanForDate(sim, date);
      const actual = {};

      for (const pid of sim.productIds) {
        actual[pid] = hist ? (hist.actual[pid] ?? 0) : 0;
      }

      if (date === current && !hist) {
        for (const pid of sim.productIds) {
          actual[pid] = sim.todayActual.get(pid) ?? 0;
        }
      }

      let phase = 'future';
      if (date < current) phase = 'past';
      else if (date === current) phase = 'today';

      return {
        date,
        phase,
        planned,
        actual,
        totalPlanned: sumRecord(planned, sim.productIds),
        totalActual: sumRecord(actual, sim.productIds),
      };
    });
}

function parseDateStr(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function cloneScheduleHistory(history) {
  return JSON.parse(JSON.stringify(history ?? {}));
}
