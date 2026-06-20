/**
 * 共线生产顺序与联合扣料（多 SKU 共享原料）
 */

import { canProduce, consumeBom, maxProducible } from './inventory.js';
import { floorToBatchMultiple, getProductProductionPolicy } from './production-policy.js';

/** 按日期轮换共线生产优先级，避免固定末位 SKU 长期缺料 */
export function getProductionLineOrder(productIds, dateStr) {
  let h = 2166136261;
  for (let i = 0; i < dateStr.length; i++) {
    h ^= dateStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const offset = (h >>> 0) % productIds.length;
  return [...productIds.slice(offset), ...productIds.slice(0, offset)];
}

function cloneKitInventory(kitInv) {
  return { raw: new Map(kitInv.raw), finished: kitInv.finished };
}

function buildRequestedProductSpecs(ctx, plan, productIds) {
  const specs = [];
  for (const pid of productIds) {
    const target = Math.max(0, Math.floor(plan.get(pid) ?? 0));
    if (target <= 0) continue;
    const { minProductionQty, batchSize } = getProductProductionPolicy(ctx.productionPolicy, pid);
    specs.push({
      pid,
      bom: ctx.bomIndex.get(pid) ?? [],
      minProductionQty,
      batchSize: Math.max(1, batchSize),
      target,
    });
  }
  return specs;
}

function buildLineOrderProductSpecs(ctx, plan, productIds, dateStr) {
  const specs = [];
  for (const pid of getProductionLineOrder(productIds, dateStr)) {
    const target = Math.max(0, Math.floor(plan.get(pid) ?? 0));
    if (target <= 0) continue;
    const { minProductionQty, batchSize } = getProductProductionPolicy(ctx.productionPolicy, pid);
    specs.push({
      pid,
      bom: ctx.bomIndex.get(pid) ?? [],
      minProductionQty,
      batchSize: Math.max(1, batchSize),
      target,
    });
  }
  return specs;
}

function normalizeProductionQtyForSpec(qty, spec) {
  const batched = floorToBatchMultiple(qty, spec.batchSize);
  if (batched <= 0) return 0;
  if (spec.minProductionQty > 0 && batched + 1e-9 < spec.minProductionQty) return 0;
  return batched;
}

function resolveProductionQtyForSpec(planQty, kitInv, spec) {
  if (planQty <= 0) return 0;
  const capped = Math.min(planQty, maxProducible(kitInv, spec.bom));
  const qty = normalizeProductionQtyForSpec(capped, spec);
  if (qty <= 0) return 0;
  return canProduce(kitInv, spec.bom, qty) ? qty : 0;
}

/**
 * 各 SKU 同时占用的原料比例上限 α：sum_p (α·plan_p·BOM) ≤ 库存
 */
function computeJointScaleUpperBound(productSpecs, kitInv) {
  const needByMat = new Map();
  for (const spec of productSpecs) {
    const q = spec.target;
    if (q <= 0) continue;
    for (const { materialId, qty: per } of spec.bom) {
      needByMat.set(materialId, (needByMat.get(materialId) ?? 0) + q * per);
    }
  }

  let alpha = 1;
  for (const [materialId, need] of needByMat) {
    if (need <= 1e-9) continue;
    const have = kitInv.raw.get(materialId) ?? 0;
    if (have <= 1e-9) return 0;
    alpha = Math.min(alpha, have / need);
  }
  return Math.max(0, alpha);
}

/** 在比例 α 下按 Batch/MOQ 取整，并在原始库存上整单校验（非顺序扣减） */
function allocateJointAtScale(productSpecs, kitInv, productIds, alpha) {
  const actual = new Map(productIds.map((id) => [id, 0]));
  const toConsume = [];

  for (const spec of productSpecs) {
    const planQty = spec.target;
    if (planQty <= 0) continue;
    const scaled = planQty * alpha;
    const batched = floorToBatchMultiple(Math.floor(scaled + 1e-9), spec.batchSize);
    const qty = normalizeProductionQtyForSpec(batched, spec);
    if (qty <= 0) continue;
    toConsume.push({ bom: spec.bom, qty });
    actual.set(spec.pid, qty);
  }

  const testInv = cloneKitInventory(kitInv);
  for (const { bom, qty } of toConsume) {
    if (!canProduce(testInv, bom, qty)) return null;
    consumeBom(testInv, bom, qty);
  }

  return actual;
}

function buildRoundRobinBatchProductionFromSpecs(productSpecs, kitInv, productIds, dateStr) {
  const virtual = cloneKitInventory(kitInv);
  const actual = new Map(productIds.map((id) => [id, 0]));
  let progress = true;

  while (progress) {
    progress = false;
    for (const spec of productSpecs) {
      const target = spec.target;

      const cur = actual.get(spec.pid) ?? 0;
      if (cur + 1e-9 >= target) continue;

      const nextTarget = Math.min(target, cur + spec.batchSize);
      const qty = resolveProductionQtyForSpec(nextTarget, virtual, spec);
      if (qty <= cur + 1e-9) continue;

      consumeBom(virtual, spec.bom, qty - cur);
      actual.set(spec.pid, qty);
      progress = true;
    }
  }

  return actual;
}

/**
 * 共线 Batch 轮询：每轮各 SKU 最多追加 1 个 Batch，避免顺序一次性占满原料导致末位 SKU 整月为 0
 */
export function buildRoundRobinBatchProductionFromPlan(ctx, plan, kitInv, productIds, dateStr) {
  return buildRoundRobinBatchProductionFromSpecs(
    buildLineOrderProductSpecs(ctx, plan, productIds, dateStr),
    kitInv,
    productIds,
    dateStr
  );
}

/** @deprecated 整单顺序占满；请用 {@link buildRoundRobinBatchProductionFromPlan} */
export function buildLineOrderedProductionFromPlan(ctx, plan, kitInv, productIds, dateStr) {
  return buildRoundRobinBatchProductionFromPlan(ctx, plan, kitInv, productIds, dateStr);
}

/**
 * 当日可执行产量：原料够整单则联合满产（如 1/31 SS 批次）；否则 Batch 轮询公平分配
 */
export function buildDailyProductionFromPlan(ctx, plan, kitInv, productIds, dateStr) {
  const productSpecs = buildRequestedProductSpecs(ctx, plan, productIds);
  if (!productSpecs.length) {
    return new Map(productIds.map((id) => [id, 0]));
  }

  const alphaMax = computeJointScaleUpperBound(productSpecs, kitInv);
  if (alphaMax + 1e-9 >= 1) {
    const full = allocateJointAtScale(productSpecs, kitInv, productIds, 1);
    if (full) return full;
  }

  return buildRoundRobinBatchProductionFromSpecs(
    buildLineOrderProductSpecs(ctx, plan, productIds, dateStr),
    kitInv,
    productIds,
    dateStr
  );
}

/**
 * @param {{ bomIndex: Map, productionPolicy: object }} ctx
 */
export function resolveProductionQty(ctx, planQty, kitInv, pid) {
  if (planQty <= 0) return 0;
  const { minProductionQty, batchSize } = getProductProductionPolicy(ctx.productionPolicy, pid);
  const spec = {
    pid,
    bom: ctx.bomIndex.get(pid) ?? [],
    minProductionQty,
    batchSize: Math.max(1, batchSize),
  };
  return resolveProductionQtyForSpec(planQty, kitInv, spec);
}

/** @deprecated 使用 {@link buildDailyProductionFromPlan} */
export function buildJointProductionFromPlan(ctx, plan, kitInv, productIds) {
  return buildDailyProductionFromPlan(ctx, plan, kitInv, productIds, '');
}

/**
 * 按共线分配当日可执行产量（与 executeProduction 扣料一致）
 */
export function buildSequentialProductionFromPlan(ctx, plan, kitInv, productIds, dateStr = '') {
  return buildDailyProductionFromPlan(ctx, plan, kitInv, productIds, dateStr);
}

/** 人工指定产量：Batch 轮询截断 */
export function applySequentialProductionCap(ctx, requested, kitInv, productIds, dateStr = '') {
  return buildRoundRobinBatchProductionFromPlan(ctx, requested, kitInv, productIds, dateStr);
}
