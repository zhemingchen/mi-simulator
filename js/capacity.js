/**
 * 共线日产能上限：正态随机，具体数值仅在当日步进时抽取，日结束后揭晓并缓存
 */

import {
  DEFAULT_CAPACITY_MEAN,
  DEFAULT_CAPACITY_P90_LOW,
  DEFAULT_CAPACITY_P90_HIGH,
  DEFAULT_CAPACITY_POLICY,
  getCapacityStd,
  normalizeCapacityPolicy,
  buildCapacityDistributionHint,
  getCapacityPolicyForDate,
  ensureCapacityForecastSchedule,
} from './capacity-policy.js';

export {
  DEFAULT_CAPACITY_MEAN,
  DEFAULT_CAPACITY_P90_LOW,
  DEFAULT_CAPACITY_P90_HIGH,
  DEFAULT_CAPACITY_POLICY,
  buildCapacityDistributionHint,
  normalizeCapacityPolicy,
  getCapacityStd,
  getCapacityPolicyForDate,
  ensureCapacityForecastSchedule,
} from './capacity-policy.js';

/** @deprecated 兼容旧引用 */
export const DAILY_CAPACITY_MEAN = DEFAULT_CAPACITY_MEAN;

/** @deprecated 兼容旧引用 */
export const DAILY_CAPACITY_STD = getCapacityStd(DEFAULT_CAPACITY_POLICY);

/** @deprecated 兼容旧引用 */
export const DAILY_CAPACITY_DISTRIBUTION_HINT = buildCapacityDistributionHint(DEFAULT_CAPACITY_POLICY);

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

/** Box-Muller 正态采样 */
function normalSample(rng, mean, std) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + std * z;
}

/** 采样某日产能上限（整数件，至少 0），不写入缓存 */
export function sampleDailyCapacity(dateStr, simStartDate, policy = DEFAULT_CAPACITY_POLICY) {
  const p = normalizeCapacityPolicy(policy);
  const std = getCapacityStd(p);
  const rng = mulberry32(hashSeed('daily-capacity', simStartDate ?? '', dateStr));
  const raw = Math.round(normalSample(rng, p.mean, std));
  return Math.max(0, Math.min(raw, p.max));
}

/** 已揭晓的历史产能（仅日结束后才有） */
export function getRevealedDailyCapacity(simOrCache, dateStr) {
  const cache = simOrCache?.dailyCapacityCache ?? simOrCache;
  if (!(cache instanceof Map) || !cache.has(dateStr)) return null;
  return cache.get(dateStr);
}

/**
 * 计划/投影用产能：已揭晓用缓存；否则用当日预测分布的均值
 * @param {object} sim
 */
export function getPlanningDailyCapacity(sim, dateStr) {
  const revealed = getRevealedDailyCapacity(sim, dateStr);
  if (revealed != null) return revealed;

  if (sim._pendingDayCapacityDate === dateStr && sim._pendingDayCapacity != null) {
    return sim._pendingDayCapacity;
  }

  ensureCapacityForecastSchedule(sim);
  const policy = getCapacityPolicyForDate(
    sim.capacityForecastSchedule,
    dateStr,
    sim._simStartDate
  );
  return policy.mean;
}

/** 当日步进开始时抽取产能（暂存，日结束后 commit） */
export function beginDailyCapacityDraw(sim, dateStr) {
  if (sim._pendingDayCapacity != null && sim._pendingDayCapacityDate === dateStr) {
    return sim._pendingDayCapacity;
  }
  ensureCapacityForecastSchedule(sim);
  const policy = getCapacityPolicyForDate(
    sim.capacityForecastSchedule,
    dateStr,
    sim._simStartDate
  );
  const cap = sampleDailyCapacity(dateStr, sim._simStartDate, policy);
  sim._pendingDayCapacity = cap;
  sim._pendingDayCapacityDate = dateStr;
  return cap;
}

/** 日结束时写入缓存并清除暂存 */
export function commitDailyCapacity(sim, dateStr) {
  if (sim._pendingDayCapacity != null && sim._pendingDayCapacityDate === dateStr) {
    sim.dailyCapacityCache.set(dateStr, sim._pendingDayCapacity);
  }
  sim._pendingDayCapacity = null;
  sim._pendingDayCapacityDate = null;
}

/** 清除未提交的当日抽样（后退/重置） */
export function clearPendingDailyCapacity(sim) {
  sim._pendingDayCapacity = null;
  sim._pendingDayCapacityDate = null;
}

/**
 * 生产截断用：已揭晓则用缓存；当日步进中则用暂存值；否则不限产能
 */
export function getActiveDayCapacity(sim, dateStr) {
  const revealed = getRevealedDailyCapacity(sim, dateStr);
  if (revealed != null) return revealed;
  if (sim._pendingDayCapacityDate === dateStr && sim._pendingDayCapacity != null) {
    return sim._pendingDayCapacity;
  }
  return null;
}

export function cloneDailyCapacityCache(cache) {
  return new Map(cache ?? []);
}

/**
 * 将日计划/产量按共线产能上限截断（capacity 为 null 时不限制）
 * @param {Map<number, number>} plan
 * @returns {Map<number, number>}
 */
export function applyCapacityLimit(plan, capacity, productIds) {
  if (capacity == null || !Number.isFinite(capacity) || capacity < 0) {
    return new Map(plan);
  }

  const entries = productIds
    .map((pid) => [pid, Math.max(0, Math.floor(plan.get(pid) ?? 0))])
    .filter(([, q]) => q > 0);

  const total = entries.reduce((s, [, q]) => s + q, 0);
  if (total <= capacity) {
    const out = new Map(productIds.map((id) => [id, 0]));
    for (const [pid, q] of entries) out.set(pid, q);
    return out;
  }

  if (capacity === 0) return new Map(productIds.map((id) => [id, 0]));

  const floats = entries.map(([pid, q]) => ({ pid, raw: (q * capacity) / total }));
  const floors = floats.map(({ pid, raw }) => ({ pid, qty: Math.floor(raw), frac: raw - Math.floor(raw) }));
  let assigned = floors.reduce((s, x) => s + x.qty, 0);
  const sorted = [...floors].sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (assigned < capacity && i < sorted.length) {
    sorted[i % sorted.length].qty += 1;
    assigned += 1;
    i += 1;
  }

  const out = new Map(productIds.map((id) => [id, 0]));
  for (const { pid, qty } of floors) out.set(pid, qty);
  return out;
}
