/**
 * 共线日产能策略：分时段正态分布预测 + 单日参数
 */

export const DEFAULT_CAPACITY_MEAN = 180;
export const DEFAULT_CAPACITY_P90_LOW = 160;
export const DEFAULT_CAPACITY_P90_HIGH = 200;
export const DEFAULT_CAPACITY_MAX = 220;

/** 正态 5%/95% 分位对应 z ≈ 1.645 */
const Z_P90_HALF = 1.645;

export const DEFAULT_CAPACITY_POLICY = {
  mean: DEFAULT_CAPACITY_MEAN,
  p90Low: DEFAULT_CAPACITY_P90_LOW,
  p90High: DEFAULT_CAPACITY_P90_HIGH,
  max: DEFAULT_CAPACITY_MAX,
};

/** 远期默认结束日（分时段预测） */
export const CAPACITY_FORECAST_FAR_END = '2099-12-31';

/** 规范化产能策略参数 */
export function normalizeCapacityPolicy(raw) {
  const src = raw ?? DEFAULT_CAPACITY_POLICY;
  let p90Low = Math.max(0, Math.floor(Number(src.p90Low ?? DEFAULT_CAPACITY_P90_LOW)));
  let p90High = Math.max(p90Low + 1, Math.floor(Number(src.p90High ?? DEFAULT_CAPACITY_P90_HIGH)));
  let mean = Math.floor(Number(src.mean ?? DEFAULT_CAPACITY_MEAN));
  mean = Math.min(Math.max(mean, p90Low), p90High);
  let max = Math.max(p90High, Math.floor(Number(src.max ?? DEFAULT_CAPACITY_MAX)));
  return { mean, p90Low, p90High, max };
}

export function createCapacityPolicy(fromJson) {
  return normalizeCapacityPolicy(fromJson);
}

export function cloneCapacityPolicy(policy) {
  return normalizeCapacityPolicy(policy);
}

/** 由 90% 区间推算正态标准差（对称） */
export function getCapacityStd(policy) {
  const p = normalizeCapacityPolicy(policy);
  return (p.p90High - p.p90Low) / (2 * Z_P90_HALF);
}

/** 产能分布说明文案 */
export function buildCapacityDistributionHint(policy) {
  const p = normalizeCapacityPolicy(policy);
  return `均值 ${p.mean}，约 90% 在 ${p.p90Low}～${p.p90High} 之间（正态分布，硬上限 ${p.max}，当日结束才揭晓具体值）`;
}

/** 规范化分时段预测条目 */
export function normalizeCapacityForecastSegment(raw, fallbackFrom = '2026-01-01') {
  const fromDate = String(raw?.fromDate ?? fallbackFrom).slice(0, 10);
  const toDate = String(raw?.toDate ?? CAPACITY_FORECAST_FAR_END).slice(0, 10);
  const policy = normalizeCapacityPolicy(raw);
  const [from, to] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate];
  return { fromDate: from, toDate: to, ...policy };
}

/** 创建默认单段预测（自起始日至远期） */
export function createDefaultCapacityForecastSchedule(startDateStr, policy = DEFAULT_CAPACITY_POLICY) {
  const p = normalizeCapacityPolicy(policy);
  return [
    {
      fromDate: String(startDateStr ?? '2026-01-01').slice(0, 10),
      toDate: CAPACITY_FORECAST_FAR_END,
      ...p,
    },
  ];
}

export function cloneCapacityForecastSchedule(schedule) {
  return (schedule ?? []).map((seg) => ({
    ...normalizeCapacityForecastSegment(seg),
  }));
}

/** 排序并规范化（不合并相邻时段，保留各段独立参数） */
export function normalizeCapacityForecastSchedule(segments, fallbackStart = '2026-01-01') {
  if (!segments?.length) {
    return createDefaultCapacityForecastSchedule(fallbackStart);
  }

  return segments
    .map((s) => normalizeCapacityForecastSegment(s, fallbackStart))
    .sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.toDate.localeCompare(b.toDate));
}

/** 查询某日生效的产能分布参数（重叠时段取起始日较晚者） */
export function getCapacityPolicyForDate(schedule, dateStr, fallbackStart = '2026-01-01') {
  const ds = String(dateStr).slice(0, 10);
  const list = normalizeCapacityForecastSchedule(schedule, fallbackStart);
  let match = null;
  for (const seg of list) {
    if (ds >= seg.fromDate && ds <= seg.toDate) {
      if (!match || seg.fromDate >= match.fromDate) match = seg;
    }
  }
  return match ? normalizeCapacityPolicy(match) : normalizeCapacityPolicy(DEFAULT_CAPACITY_POLICY);
}

/** 站在 asOfDate，合并「已过期时段 + 用户新编未来时段」 */
export function applyCapacityForecastFromDate(schedule, asOfDate, futureSegments, fallbackStart = '2026-01-01') {
  const asOf = String(asOfDate).slice(0, 10);
  const kept = normalizeCapacityForecastSchedule(schedule, fallbackStart).filter((s) => s.toDate < asOf);

  const incoming = (futureSegments ?? [])
    .map((s) => normalizeCapacityForecastSegment(s, asOf))
    .filter((s) => s.toDate >= asOf)
    .map((s) => ({
      ...s,
      fromDate: s.fromDate < asOf ? asOf : s.fromDate,
    }));

  if (!incoming.length) {
    const fallbackPolicy =
      kept.length > 0
        ? normalizeCapacityPolicy(kept[kept.length - 1])
        : normalizeCapacityPolicy(DEFAULT_CAPACITY_POLICY);
    incoming.push(
      normalizeCapacityForecastSegment(
        {
          fromDate: asOf,
          toDate: CAPACITY_FORECAST_FAR_END,
          ...fallbackPolicy,
        },
        asOf
      )
    );
  }

  return normalizeCapacityForecastSchedule([...kept, ...incoming], fallbackStart);
}

/** 列出 asOfDate 及之后仍生效的预测时段（Policy 编辑用） */
export function listEditableCapacityForecastSegments(schedule, asOfDate, fallbackStart = '2026-01-01') {
  const asOf = String(asOfDate).slice(0, 10);
  const list = normalizeCapacityForecastSchedule(schedule, fallbackStart);
  const editable = list
    .filter((s) => s.toDate >= asOf)
    .map((s) => ({
      ...s,
      fromDate: s.fromDate < asOf ? asOf : s.fromDate,
      lockedPast: s.fromDate < asOf,
    }));

  if (!editable.length) {
    return [
      normalizeCapacityForecastSegment(
        {
          fromDate: asOf,
          toDate: CAPACITY_FORECAST_FAR_END,
          ...DEFAULT_CAPACITY_POLICY,
        },
        asOf
      ),
    ];
  }

  return editable;
}

/** 分时段预测摘要（Policy 信息区） */
export function buildCapacityForecastScheduleHint(schedule, asOfDate, fallbackStart = '2026-01-01') {
  const asOf = String(asOfDate).slice(0, 10);
  const editable = listEditableCapacityForecastSegments(schedule, asOf, fallbackStart);
  const lines = editable.slice(0, 6).map((s) => {
    const range = s.fromDate === s.toDate ? s.fromDate : `${s.fromDate}～${s.toDate}`;
    return `${range}：均值 ${s.mean}（90% ${s.p90Low}～${s.p90High}，上限 ${s.max}）`;
  });
  const more = editable.length > 6 ? ` …共 ${editable.length} 段` : '';
  return `站在 ${asOf}：以下 ${editable.length} 个时段作用于当日及之后的计划与抽样；已揭晓历史产能不变。${lines.join('；')}${more}`;
}

/** 确保 sim 有分时段预测（兼容旧快照） */
export function ensureCapacityForecastSchedule(sim) {
  if (sim.capacityForecastSchedule?.length) {
    sim.capacityForecastSchedule = normalizeCapacityForecastSchedule(
      sim.capacityForecastSchedule,
      sim._simStartDate ?? '2026-01-01'
    );
    return sim.capacityForecastSchedule;
  }
  sim.capacityForecastSchedule = createDefaultCapacityForecastSchedule(
    sim._simStartDate ?? '2026-01-01',
    sim.capacityPolicy ?? DEFAULT_CAPACITY_POLICY
  );
  return sim.capacityForecastSchedule;
}
