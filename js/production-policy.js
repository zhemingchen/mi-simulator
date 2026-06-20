/**
 * 生产批次策略：最少起做量（MOQ）与 Batch 整数倍
 */

/** 默认 MOQ / Batch（与 data/production-policy.json 一致） */
export const DEFAULT_MIN_PRODUCTION_QTY = 5;
export const DEFAULT_BATCH_SIZE = 5;

/** @param {number[]} productIds @param {object} [fromJson] */
export function createProductionPolicy(productIds, fromJson) {
  const byProduct = {};
  for (const id of productIds) {
    const key = String(id);
    const src = fromJson?.byProduct?.[key] ?? {};
    byProduct[key] = {
      minProductionQty: Math.max(
        0,
        Math.floor(Number(src.minProductionQty ?? DEFAULT_MIN_PRODUCTION_QTY) || DEFAULT_MIN_PRODUCTION_QTY)
      ),
      batchSize: Math.max(
        1,
        Math.floor(Number(src.batchSize ?? DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE)
      ),
    };
  }
  return { byProduct };
}

export function cloneProductionPolicy(policy) {
  const byProduct = {};
  for (const [k, v] of Object.entries(policy?.byProduct ?? {})) {
    byProduct[k] = { ...v };
  }
  return { byProduct };
}

export function getProductProductionPolicy(policy, productId) {
  const p = policy?.byProduct?.[String(productId)] ?? {};
  return {
    minProductionQty: Math.max(0, Math.floor(p.minProductionQty ?? DEFAULT_MIN_PRODUCTION_QTY)),
    batchSize: Math.max(1, Math.floor(p.batchSize ?? DEFAULT_BATCH_SIZE)),
  };
}

/**
 * 计划排产量：所需量（含安全库存缺口）≥ 起做量时，向上取整到 Batch 整数倍；否则不排产
 * @param {number} rawNeed 毛需求（件）
 */
export function applyProductionLotRules(rawNeed, minProductionQty, batchSize) {
  if (rawNeed <= 1e-9) return 0;
  const min = Math.max(0, Math.floor(minProductionQty ?? 0));
  const batch = Math.max(1, Math.floor(batchSize ?? 1));
  if (min > 0 && rawNeed + 1e-9 < min) return 0;
  return Math.ceil(rawNeed / batch) * batch;
}

/** 实际产量向下取整到 Batch 整数倍 */
export function floorToBatchMultiple(qty, batchSize) {
  const q = Math.max(0, Math.floor(qty));
  const batch = Math.max(1, Math.floor(batchSize ?? 1));
  if (q <= 0) return 0;
  return Math.floor(q / batch) * batch;
}

/** 执行阶段：Batch 取整 + 起做量校验 */
export function normalizeProductionQty(qty, productId, policy) {
  const { minProductionQty, batchSize } = getProductProductionPolicy(policy, productId);
  const batched = floorToBatchMultiple(qty, batchSize);
  if (batched <= 0) return 0;
  if (minProductionQty > 0 && batched + 1e-9 < minProductionQty) return 0;
  return batched;
}

/** 将用户输入吸附到不超过 maxQty 的 Batch 整数倍 */
export function snapProductionInput(value, maxQty, batchSize) {
  const batch = Math.max(1, Math.floor(batchSize ?? 1));
  const max = Math.max(0, Math.floor(maxQty));
  let q = Math.max(0, Math.floor(Number(value) || 0));
  q = Math.min(q, max);
  return floorToBatchMultiple(q, batch);
}
