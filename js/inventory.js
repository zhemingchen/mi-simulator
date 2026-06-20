/**
 * 库存管理：原料仓、成品仓
 */

export function createInventory(productIds, materialIds) {
  return {
    raw: new Map(materialIds.map((id) => [id, 0])),
    finished: new Map(productIds.map((id) => [id, 0])),
  };
}

export function getRaw(inv, materialId) {
  return inv.raw.get(materialId) ?? 0;
}

export function getFinished(inv, productId) {
  return inv.finished.get(productId) ?? 0;
}

/** 扣减原料；不足返回 false */
export function consumeRaw(inv, materialId, qty) {
  const cur = getRaw(inv, materialId);
  if (cur + 1e-9 < qty) return false;
  inv.raw.set(materialId, cur - qty);
  return true;
}

/** 批量扣减 BOM；任一不足则回滚 */
export function consumeBom(inv, bomLines, multiplier) {
  const deltas = bomLines.map(({ materialId, qty }) => ({
    materialId,
    need: qty * multiplier,
  }));

  for (const { materialId, need } of deltas) {
    if (getRaw(inv, materialId) + 1e-9 < need) return { ok: false, shortages: findShortages(inv, bomLines, multiplier) };
  }

  for (const { materialId, need } of deltas) {
    inv.raw.set(materialId, getRaw(inv, materialId) - need);
  }
  return { ok: true, shortages: [] };
}

/** 缺料清单 */
export function findShortages(inv, bomLines, multiplier) {
  const list = [];
  for (const { materialId, qty } of bomLines) {
    const need = qty * multiplier;
    const have = getRaw(inv, materialId);
    if (have + 1e-9 < need) {
      list.push({ materialId, need, have });
    }
  }
  return list;
}

/** 是否齐套（至少生产 qty 件） */
export function canProduce(inv, bomLines, qty) {
  if (qty <= 0) return true;
  return findShortages(inv, bomLines, qty).length === 0;
}

/** 在现有库存下最多可产件数（按瓶颈原料） */
export function maxProducible(inv, bomLines) {
  if (!bomLines.length) return 0;
  let max = Infinity;
  for (const { materialId, qty } of bomLines) {
    if (qty <= 0) continue;
    const have = getRaw(inv, materialId);
    max = Math.min(max, Math.floor(have / qty));
  }
  return max === Infinity ? 0 : max;
}

export function addRaw(inv, materialId, qty) {
  inv.raw.set(materialId, getRaw(inv, materialId) + qty);
}

export function addFinished(inv, productId, qty) {
  inv.finished.set(productId, getFinished(inv, productId) + qty);
}

/** 日订单出库：整单交货，库存不足则不发货（不允许拆单） */
export function shipFinishedWholeOrder(inv, productId, qty) {
  if (qty <= 0) return { shipped: 0, fulfilled: true };
  const cur = getFinished(inv, productId);
  if (cur + 1e-9 < qty) return { shipped: 0, fulfilled: false };
  inv.finished.set(productId, cur - qty);
  return { shipped: qty, fulfilled: true };
}

/** @deprecated 使用整单交货 {@link shipFinishedWholeOrder} */
export function shipFinishedDemand(inv, productId, qty) {
  if (qty <= 0) return { shipped: 0, shortfall: 0 };
  const cur = getFinished(inv, productId);
  const shipped = Math.min(cur, qty);
  inv.finished.set(productId, cur - shipped);
  return { shipped, shortfall: qty - shipped };
}

/** 统计低于安全库存的品种数 */
export function countBelowSafety(inv, safetyStock, productIds, materialIds) {
  let n = 0;
  for (const id of productIds) {
    if (getFinished(inv, id) < (safetyStock.finishedGoods[String(id)] ?? 0)) n += 1;
  }
  for (const id of materialIds) {
    if (getRaw(inv, id) < (safetyStock.rawMaterials[String(id)] ?? 0)) n += 1;
  }
  return n;
}
