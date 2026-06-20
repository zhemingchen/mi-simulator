/**
 * 日期与需求通报、均衡日排产
 */

const SIM_YEAR = 2026;

/** @returns {Date} */
export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** 增加自然月（排产趋势等用） */
export function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/** 排产趋势图：从当前仿真日向后展示的自然月数 */
export const SCHEDULE_CHART_FUTURE_MONTHS = 6;

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** 月份键，如 "2026-3" */
export function monthKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}`;
}

export function monthFromNoticeKey(key) {
  const n = parseInt(key, 10);
  return { year: SIM_YEAR, month: n };
}

/**
 * 需求任务状态
 * effectiveTasks: Map productId -> Map monthKey -> qty
 * dailyOrders: Map productId -> Map monthKey -> number[]（下标 0 = 1 号，各日订单量，月合计 = 任务）
 */
export function createTaskState(productIds) {
  return {
    effectiveTasks: new Map(productIds.map((id) => [id, new Map()])),
    dailyOrders: new Map(productIds.map((id) => [id, new Map()])),
    /** 本月已产：Map productId -> Map monthKey -> qty */
    producedThisMonth: new Map(productIds.map((id) => [id, new Map()])),
  };
}

/** 可复现伪随机（同一 SKU+月份 在未改任务前拆分不变） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...parts) {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

/**
 * 将整数总量随机拆到若干天（允许为 0，合计精确等于 total）
 * 算法：每件随机落入某一天（多项分布）
 */
export function randomSplitAcrossDays(total, daysInMonth, rng) {
  const n = Math.max(0, Math.round(total));
  const dim = Math.max(0, daysInMonth | 0);
  const counts = new Array(dim).fill(0);
  if (n === 0 || dim === 0) return counts;
  for (let i = 0; i < n; i++) {
    counts[Math.floor(rng() * dim)] += 1;
  }
  return counts;
}

/** 为某 SKU 某月生成/刷新随机日订单并写入 taskState
 * @param {Date|null} onDate 需求更新日：同月内该日之前的日订单冻结，仅重随机剩余天数
 */
export function generateRandomDailyOrders(taskState, productId, mk, total, onDate = null, log) {
  const [yearStr, monthStr] = mk.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const dim = daysInMonth(year, month);
  const targetTotal = Math.max(0, Math.round(total));

  let byMonth = taskState.dailyOrders.get(productId);
  if (!byMonth) {
    byMonth = new Map();
    taskState.dailyOrders.set(productId, byMonth);
  }

  const prev = byMonth.get(mk);
  const updateMk = onDate ? monthKey(onDate) : null;
  const sameMonthUpdate = onDate && updateMk === mk;
  const frozenCount = sameMonthUpdate ? Math.max(0, onDate.getDate() - 1) : 0;

  const counts = new Array(dim).fill(0);
  let frozenSum = 0;

  if (sameMonthUpdate && frozenCount > 0 && prev) {
    for (let i = 0; i < frozenCount; i++) {
      counts[i] = prev[i] ?? 0;
      frozenSum += counts[i];
    }
  }

  const remainingDays = dim - frozenCount;
  const remainingTotal = Math.max(0, targetTotal - frozenSum);

  if (remainingDays > 0) {
    const rng = mulberry32(
      hashSeed(productId, mk, targetTotal, onDate ? formatDate(onDate) : 'full', frozenSum, frozenCount)
    );
    const tail = randomSplitAcrossDays(remainingTotal, remainingDays, rng);
    for (let i = 0; i < tail.length; i++) {
      counts[frozenCount + i] = tail[i];
    }
  }

  byMonth.set(mk, counts);

  const sum = counts.reduce((s, v) => s + v, 0);
  const activeDays = counts.filter((v) => v > 0).length;

  if (sameMonthUpdate && frozenCount > 0) {
    const fromDay = frozenCount + 1;
    const tailActive = counts.slice(frozenCount).filter((v) => v > 0).length;
    log?.({
      type: 'demand',
      message:
        `日订单拆分：SKU ${productId} ${mk} 冻结 ${fromDay - 1} 号及之前共 ${frozenSum} 件，` +
        `剩余 ${remainingTotal} 件随机拆至 ${fromDay}～${dim} 号（${remainingDays} 天，${tailActive} 天有单）`,
    });
  } else {
    log?.({
      type: 'demand',
      message: `日订单拆分：SKU ${productId} ${mk} 共 ${sum} 件 → ${activeDays}/${dim} 天有单（需求更新随机，可预知未来日订单）`,
    });
  }

  return counts;
}

/** 某日订单量（1-based dayOfMonth） */
export function getDailyOrder(taskState, productId, mk, dayOfMonth) {
  const arr = taskState.dailyOrders.get(productId)?.get(mk);
  if (!arr || dayOfMonth < 1) return 0;
  return arr[dayOfMonth - 1] ?? 0;
}

function ensureDailyOrders(taskState, productId, mk, asOfDate) {
  const total = getEffectiveTask(taskState, productId, mk);
  if (total <= 0) return;
  if (taskState.dailyOrders.get(productId)?.has(mk)) return;
  generateRandomDailyOrders(taskState, productId, mk, total, asOfDate ?? null);
}

export function ensureDailyOrdersForMonth(taskState, productIds, mk, asOfDate) {
  for (const pid of productIds) {
    ensureDailyOrders(taskState, pid, mk, asOfDate);
  }
}

export function cloneDailyOrders(dailyOrders) {
  const outer = new Map();
  for (const [pid, byMonth] of dailyOrders ?? []) {
    outer.set(pid, new Map([...byMonth.entries()].map(([mk, arr]) => [mk, [...arr]])));
  }
  return outer;
}

/** 应用需求通报 */
export function applyDemandNotices(taskState, notices, onDate, log) {
  const dateStr = formatDate(onDate);
  const todayNotices = notices.filter((n) => n.noticeDate === dateStr);
  if (!todayNotices.length) return false;

  for (const n of todayNotices) {
    const map = taskState.effectiveTasks.get(n.productId);
    if (!map) continue;
    for (const [m, qty] of Object.entries(n.months)) {
      const mk = `${SIM_YEAR}-${m}`;
      map.set(mk, qty);
      generateRandomDailyOrders(taskState, n.productId, mk, qty, onDate, log);
      log?.({
        type: 'demand',
        message: `需求通报：SKU ${n.productId} ${mk} 任务 → ${qty} 件`,
      });
    }
  }
  return true;
}

/**
 * 重置时应用所有不晚于起始日的需求通报（含 2025-12-30 首版）
 * 按通报日期升序；同一月份后到的通报覆盖先前的
 */
export function applyDemandNoticesUpTo(taskState, notices, upToDateStr, log) {
  const dates = [...new Set(notices.map((n) => n.noticeDate).filter((d) => d <= upToDateStr))].sort();
  if (!dates.length) return false;

  for (const d of dates) {
    applyDemandNotices(taskState, notices, parseDate(d), log);
  }
  return true;
}

/** 获取某月有效任务，未通报为 0 */
export function getEffectiveTask(taskState, productId, mk) {
  return taskState.effectiveTasks.get(productId)?.get(mk) ?? 0;
}

/** 获取本月已产 */
export function getProduced(taskState, productId, mk) {
  return taskState.producedThisMonth.get(productId)?.get(mk) ?? 0;
}

export function recordProduction(taskState, productId, mk, qty) {
  const map = taskState.producedThisMonth.get(productId);
  map.set(mk, (map.get(mk) ?? 0) + qty);
}

/**
 * 日排产：取当月该日的随机订单量（整数）
 * @param {Date} date 计划日
 */
export function computeDailyPlan(taskState, productIds, date) {
  const mk = monthKey(date);
  const dayOfMonth = date.getDate();
  const plan = new Map();

  for (const pid of productIds) {
    ensureDailyOrders(taskState, pid, mk, date);
    plan.set(pid, getDailyOrder(taskState, pid, mk, dayOfMonth));
  }

  return plan;
}

/**
 * 日计划（含未来预览）：各日取已随机拆分的日订单量
 */
export function computeDailyPlanForecast(taskState, productIds, asOfDate, planDate) {
  const planMk = monthKey(planDate);
  const dayOfMonth = planDate.getDate();
  const plan = new Map();

  for (const pid of productIds) {
    ensureDailyOrders(taskState, pid, planMk, asOfDate);
    plan.set(pid, getDailyOrder(taskState, pid, planMk, dayOfMonth));
  }

  return plan;
}

/** 将浮点日计划按总量取整到整数件（最大余数法） */
export function integerizeDailyPlan(plan) {
  const entries = [...plan.entries()];
  const floors = entries.map(([id, v]) => [id, Math.floor(v + 1e-9)]);
  let sumFloor = floors.reduce((s, [, v]) => s + v, 0);
  const target = Math.round(entries.reduce((s, [, v]) => s + v, 0));
  const remainders = entries
    .map(([id, v], i) => ({ id, r: v - floors[i][1], i }))
    .sort((a, b) => b.r - a.r);

  const result = new Map(floors);
  let k = 0;
  while (sumFloor < target && k < remainders.length) {
    const { id } = remainders[k % remainders.length];
    result.set(id, result.get(id) + 1);
    sumFloor += 1;
    k += 1;
  }
  return result;
}

/** 月剩余任务 */
export function getMonthRemaining(taskState, productId, mk) {
  const total = getEffectiveTask(taskState, productId, mk);
  const produced = getProduced(taskState, productId, mk);
  return Math.max(0, total - produced);
}
