/**
 * 供应商交货延期：概率触发 + 正态分布延期天数（均值为提前期的 10%）
 */

import { addDays, formatDate, parseDate } from './scheduler.js';

/** 延期天数均值 = 名义提前期 × 该比例；标准差 = 均值 × 该比例 */
export const SUPPLIER_DELAY_MEAN_RATIO = 0.1;
export const SUPPLIER_DELAY_STD_RATIO = 0.25;

export function createSupplierPolicy(fromJson) {
  const p = Number(fromJson?.delayProbability ?? 0);
  return {
    /** 0～1，供应商延期发生的概率 */
    delayProbability: Math.min(1, Math.max(0, p)),
  };
}

export function cloneSupplierPolicy(policy) {
  return {
    delayProbability: Math.min(1, Math.max(0, Number(policy?.delayProbability ?? 0))),
  };
}

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

function normalSample(rng, mean, std) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + std * z;
}

/**
 * 抽样供应商额外延期天数（四舍五入取整，至少 0）
 * @param {number} nominalLeadDays 名义采购周期
 */
export function sampleSupplierDelayDays(materialId, orderDate, demandDate, nominalLeadDays, policy) {
  const prob = policy?.delayProbability ?? 0;
  const lead = Math.max(0, Math.floor(nominalLeadDays ?? 0));
  if (prob <= 0 || lead <= 0) return 0;

  const rng = mulberry32(
    hashSeed('supplier-delay', materialId, orderDate, demandDate, lead, prob)
  );
  if (rng() >= prob) return 0;

  const mean = lead * SUPPLIER_DELAY_MEAN_RATIO;
  const std = Math.max(mean * SUPPLIER_DELAY_STD_RATIO, 0.5);
  return Math.max(0, Math.round(normalSample(rng, mean, std)));
}

/**
 * 新建 PO 时应用延期（写入 plannedArriveDate / supplierDelayDays）
 * @param {object} po 采购单（需含 arriveDate）
 */
export function applySupplierDelayToPo(po, nominalLeadDays, policy) {
  if (po.supplierDelayDays != null && po.plannedArriveDate) return po.supplierDelayDays ?? 0;

  po.plannedArriveDate = po.arriveDate;
  const delayDays = sampleSupplierDelayDays(
    po.materialId,
    po.orderDate,
    po.demandDate,
    nominalLeadDays,
    policy
  );
  po.supplierDelayDays = delayDays;
  if (delayDays > 0) {
    po.arriveDate = formatDate(addDays(parseDate(po.plannedArriveDate), delayDays));
  }
  return delayDays;
}
