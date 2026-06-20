/**
 * 库存/生产趋势图（SVG，Y 轴固定 + 横向滚动）
 */

import { bindChartScrollUI, initChartScrollPosition } from './chart-scroll.js';
import { buildSeriesValuesByDate, hoverBandSvg, bindDateHoverTooltip } from './chart-line-hover.js';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6'];
const Y_AXIS_W = 52;
const H = 220;
const PAD_T = 28;
const PAD_B = 36;
const PAD_R = 12;
const PAD_PLOT_L = 8;
const CHART_H = H - PAD_T - PAD_B;

/**
 * @param {HTMLElement} container
 * @param {{
 *   series: Array<object>,
 *   title,
 *   yLabel?,
 *   scrollable?,
 *   referenceLines?: Array<{ value, label?, color? }>,
 *   todayMarker?: string,
 * }} opts
 */
export function renderTrendChart(container, {
  series,
  title,
  yLabel = '',
  scrollable = false,
  referenceLines = [],
  todayMarker = null,
}) {
  if (!container) return;

  const prevScroll = container.querySelector('.chart-scroll')?.scrollLeft;

  const normalized = (series ?? []).map((s) => {
    const splitMode = Boolean(s.actualPoints?.length || s.forecastPoints?.length);
    return splitMode
      ? { ...s, splitMode: true, actualPoints: s.actualPoints ?? [], forecastPoints: s.forecastPoints ?? [] }
      : { ...s, splitMode: false, points: s.points ?? [] };
  });

  const allPoints = normalized.flatMap((s) =>
    s.splitMode ? [...s.actualPoints, ...s.forecastPoints] : s.points
  );

  if (!normalized.length || !allPoints.length) {
    container.innerHTML = '<p class="hint">暂无数据，请步进仿真或运行策略对比。</p>';
    return;
  }

  const dates = [...new Set(allPoints.map((p) => p.date))].sort();
  const n = dates.length;
  if (n === 0) {
    container.innerHTML = '<p class="hint">暂无数据。</p>';
    return;
  }

  let yMax = 0;
  for (const p of allPoints) yMax = Math.max(yMax, p.value);
  for (const ref of referenceLines ?? []) {
    yMax = Math.max(yMax, ref.value ?? 0);
  }
  yMax = Math.max(yMax * 1.1, 1);

  const plotW = Math.max(468, n * 8);
  const useScroll = scrollable && plotW > 468;
  const W = plotW + PAD_PLOT_L + PAD_R;

  const xAt = (i) => PAD_PLOT_L + (i / Math.max(1, n - 1)) * (plotW - PAD_PLOT_L);
  const yAt = (v) => PAD_T + CHART_H - (v / yMax) * CHART_H;

  const titleEl = yLabel ? `${title} · ${yLabel}` : title;

  const yParts = [];
  yParts.push(`<svg class="trend-chart-y-svg" viewBox="0 0 ${Y_AXIS_W} ${H}" width="${Y_AXIS_W}" height="${H}">`);
  yParts.push(
    `<text x="${Y_AXIS_W - 4}" y="16" class="chart-axis trend-title" text-anchor="end">${titleEl}</text>`
  );
  for (let g = 0; g <= 4; g++) {
    const val = (yMax * g) / 4;
    const y = yAt(val);
    yParts.push(`<text x="${Y_AXIS_W - 6}" y="${y + 3}" class="chart-axis" text-anchor="end">${Math.round(val)}</text>`);
  }
  yParts.push('</svg>');

  const plotParts = [];
  plotParts.push(`<svg class="trend-chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);

  for (let g = 0; g <= 4; g++) {
    const val = (yMax * g) / 4;
    const y = yAt(val);
    plotParts.push(`<line x1="${PAD_PLOT_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" class="chart-grid"/>`);
  }

  for (const ref of referenceLines) {
    const v = ref.value ?? 0;
    if (v <= 0) continue;
    const y = yAt(v);
    const color = ref.color ?? '#ef4444';
    plotParts.push(
      `<line x1="${PAD_PLOT_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 4" class="chart-ref-line"/>`
    );
    plotParts.push(
      `<text x="${W - PAD_R}" y="${y - 4}" class="chart-axis chart-ref-label" text-anchor="end" font-size="9" fill="${color}">${ref.label ?? 'SS'}</text>`
    );
  }

  const todayIdx = todayMarker != null ? dates.findIndex((d) => d >= todayMarker) : -1;
  const dateIndex = new Map(dates.map((date, i) => [date, i]));

  if (todayIdx >= 0) {
    const x = xAt(todayIdx);
    plotParts.push(
      `<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + CHART_H}" stroke="var(--accent, #6366f1)" stroke-width="2" class="chart-today-marker"/>`
    );
    plotParts.push(
      `<text x="${x}" y="${PAD_T - 6}" class="chart-axis chart-today-label" text-anchor="middle" font-size="10" font-weight="600" fill="var(--accent, #6366f1)">今天</text>`
    );
  }

  const pathForPoints = (pts) => {
    const ordered = pts
      .map((p) => ({ ...p, i: dateIndex.get(p.date) ?? -1 }))
      .filter((p) => p.i >= 0)
      .sort((a, b) => a.i - b.i);
    if (!ordered.length) return '';
    let d = '';
    ordered.forEach((p, idx) => {
      d += `${idx === 0 ? 'M' : 'L'}${xAt(p.i).toFixed(1)},${yAt(p.value).toFixed(1)} `;
    });
    return d.trim();
  };

  normalized.forEach((s, si) => {
    const color = s.color ?? COLORS[si % COLORS.length];
    if (s.splitMode) {
      const actualPts = (s.actualPoints ?? []).filter((p) => !todayMarker || p.date < todayMarker);
      const forecastPts = (s.forecastPoints ?? []).filter((p) => !todayMarker || p.date >= todayMarker);
      const dSolid = pathForPoints(actualPts);
      const dDash = pathForPoints(forecastPts);
      if (dSolid) {
        plotParts.push(
          `<path d="${dSolid}" fill="none" stroke="${color}" stroke-width="2" class="trend-line trend-line-actual"/>`
        );
      }
      if (dDash) {
        plotParts.push(
          `<path d="${dDash}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6 4" class="trend-line trend-line-forecast"/>`
        );
      }
      return;
    }

    const byDate = new Map(s.points.map((p) => [p.date, p.value]));
    let d = '';
    dates.forEach((date, i) => {
      const v = byDate.get(date) ?? 0;
      d += `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
    });
    plotParts.push(
      `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="2" class="trend-line"${s.dashed ? ' stroke-dasharray="6 4"' : ''}/>`
    );
  });

  const labelStep = n <= 14 ? 1 : Math.ceil(n / 12);
  dates.forEach((date, i) => {
    if (i % labelStep !== 0 && i !== n - 1 && i !== todayIdx) return;
    plotParts.push(
      `<text x="${xAt(i)}" y="${H - 6}" class="chart-axis" text-anchor="middle" font-size="9"${i === todayIdx ? ' font-weight="600" fill="var(--accent, #6366f1)"' : ''}>${date.slice(5)}</text>`
    );
  });

  plotParts.push(
    hoverBandSvg(dates, xAt, PAD_T, CHART_H, PAD_PLOT_L, W - PAD_R)
  );

  plotParts.push('</svg>');

  const hoverMatrix = buildSeriesValuesByDate(normalized, dates, todayMarker);

  const legend = normalized
    .map(
      (s, i) =>
        `<span class="chart-legend-item"><i style="background:${s.color ?? COLORS[i % COLORS.length]}"></i>${s.label}</span>`
    )
    .concat(
      todayMarker
        ? [
            '<span class="chart-legend-item chart-legend-ref"><i style="background:transparent;border:2px solid var(--accent,#6366f1)"></i>今天</span>',
            '<span class="chart-legend-item chart-legend-ref"><i style="background:transparent;border:2px solid #3b82f6"></i>已发生</span>',
            '<span class="chart-legend-item chart-legend-ref"><i style="background:transparent;border:2px dashed #3b82f6"></i>预计</span>',
          ]
        : []
    )
    .concat(
      (referenceLines ?? [])
        .filter((r) => (r.value ?? 0) > 0)
        .map(
          (r) =>
            `<span class="chart-legend-item chart-legend-ref"><i style="background:transparent;border:2px dashed ${r.color ?? '#ef4444'}"></i>${r.label ?? 'SS'}</span>`
        )
    )
    .join('');

  const plotBody = plotParts.join('');
  const scrollBlock = useScroll
    ? `
      <div class="chart-scroll-wrap chart-scroll-wrap--with-axis">
        <div class="chart-plot-row">
          <div class="chart-y-axis-fixed">${yParts.join('')}</div>
          <div class="chart-scroll" tabindex="0" aria-label="${titleEl}，可拖动查看">
            <div class="chart-scroll-inner" style="width:${W}px" data-point-count="${n}">${plotBody}</div>
          </div>
        </div>
        <input type="range" class="chart-scroll-slider" min="0" max="1000" value="0" aria-label="时间轴滑块" />
      </div>`
    : `
      <div class="chart-plot-row chart-plot-row--static">
        <div class="chart-y-axis-fixed">${yParts.join('')}</div>
        <div class="chart-plot-static">${plotBody}</div>
      </div>`;

  container.innerHTML = `<div class="trend-legend">${legend}</div>${scrollBlock}<div class="chart-tooltip" hidden></div>`;

  bindDateHoverTooltip(container, hoverMatrix);

  if (useScroll) {
    const scrollEl = container.querySelector('.chart-scroll');
    const sliderEl = container.querySelector('.chart-scroll-slider');
    bindChartScrollUI(scrollEl, sliderEl);
    initChartScrollPosition(scrollEl, sliderEl, { todayIdx, prevScroll });
  }
}

export function historyToSeries(history, field, label) {
  return {
    label,
    points: (history ?? []).map((h) => ({ date: h.date, value: h[field] ?? 0 })),
  };
}

export function comparisonToSeries(results, field) {
  return results.map((r, i) => ({
    label: r.label,
    color: COLORS[i % COLORS.length],
    points: (r.history ?? []).map((h) => ({ date: h.date, value: h[field] ?? 0 })),
  }));
}
