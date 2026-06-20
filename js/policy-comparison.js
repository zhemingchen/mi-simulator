/**
 * 多策略并行推演对比（无 UI 自动步进）
 */

import { cloneSafetyStock } from './data-loader.js';
import {
  createSimulation,
  resetSimulation,
  stepSimulation,
  applyManualDecision,
} from './simulation.js';
import { createRawMaterialPolicy, getRawPolicyLabel, RAW_MATERIAL_POLICY_TYPES } from './raw-material-policy.js';

/** 缺料决策时自动选第一个可转产 SKU */
function resolvePendingDecision(sim) {
  const pending = sim.pendingDecision;
  if (!pending) return;

  const actual = new Map(sim.productIds.map((id) => [id, 0]));
  for (const pid of pending.alternatives) {
    const st = pending.kitStatus.get(pid);
    if (!st || st.maxQty <= 0) continue;
    const planned = pending.plan.get(pid) ?? 0;
    actual.set(pid, planned > 0 ? Math.min(planned, st.maxQty) : st.maxQty);
    break;
  }
  applyManualDecision(sim, actual);
}

/**
 * @param {object} master
 * @param {{ startDate: string, days: number, policies?: object[] }} opts
 */
export function runPolicyComparison(master, { startDate, days, policies }) {
  const policyList =
    policies ??
    Object.keys(RAW_MATERIAL_POLICY_TYPES).map((type) => createRawMaterialPolicy({ type }));

  const results = [];

  for (const policyConfig of policyList) {
    const sim = createSimulation({
      ...master,
      safetyStock: cloneSafetyStock(master.safetyStock),
    });
    sim.rawMaterialPolicy = { ...createRawMaterialPolicy(), ...policyConfig };
    resetSimulation(sim, startDate);

    let steps = 0;
    const maxSteps = days + 5;

    while (steps < days && steps < maxSteps) {
      if (sim.pendingDecision) resolvePendingDecision(sim);
      const result = stepSimulation(sim);
      if (result.reason === 'manual') {
        resolvePendingDecision(sim);
      }
      if (!result.advanced && !sim.pendingDecision) break;
      steps += 1;
    }

    results.push({
      type: policyConfig.type,
      label: getRawPolicyLabel(policyConfig.type),
      params: { ...policyConfig },
      history: [...(sim.inventoryHistory ?? [])],
      totalProduced: (sim.inventoryHistory ?? []).reduce((s, h) => s + h.produced, 0),
      finalRaw: sim.inventoryHistory?.[sim.inventoryHistory.length - 1]?.rawTotal ?? 0,
      finalFinished: sim.inventoryHistory?.[sim.inventoryHistory.length - 1]?.finishedTotal ?? 0,
    });
  }

  return results;
}
