/**
 * 生产计划柱状图：左实柱=已发生实际产量，右虚柱=未来预计产量，竖线=今天
 */

import { bindChartScrollUI, syncSliderFromScroll } from './chart-scroll.js';

const BAR_W = 14;
const BAR_GAP = 4;
const Y_AXIS_W = 44;
const PAD_PLOT_L = 8;
const PAD_R = 8;
const PAD_T = 28;
const PAD_B = 40;
const CHART_H = 220;

/**
 * @param {HTMLElement} container
 * @param {{ timeline, currentDate, skuLabel? }} opts
 */
export function renderProductionPlanChart(container, { timeline, currentDate, skuLabel = '全部 SKU' }) {
  if (!container) return;

  if (!timeline?.length) {
    container.innerHTML = '<p class="hint">暂无生产数据，请重置或步进仿真。</p>';
    return;
  }

  const prevScroll = container.querySelector('.chart-scroll')?.scrollLeft;
  const asOf = currentDate;

  let yMax = 1;
  for (const row of timeline) {
    yMax = Math.max(yMax, row.actual ?? 0, row.forecast ?? 0);
  }
  yMax = Math.max(Math.ceil(yMax * 1.12), 1);

  const groups = timeline.length;
  const innerW = groups * (BAR_W + BAR_GAP);
  const plotW = PAD_PLOT_L + innerW + PAD_R;
  const height = CHART_H + PAD_T + PAD_B;
  const yScale = (v) => PAD_T + CHART_H - (v / yMax) * CHART_H;
  const x0At = (i) => PAD_PLOT_L + i * (BAR_W + BAR_GAP);

  const yParts = [];
  yParts.push(
    `<svg class="production-plan-y-svg" viewBox="0 0 ${Y_AXIS_W} ${height}" width="${Y_AXIS_W}" height="${height}">`
  );
  yParts.push(
    `<text x="${Y_AXIS_W - 4}" y="16" class="chart-axis trend-title" text-anchor="end">产量 · ${skuLabel}</text>`
  );
  for (let g = 0; g <= 4; g++) {
    const val = (yMax * g) / 4;
    const y = yScale(val);
    yParts.push(
      `<text x="${Y_AXIS_W - 6}" y="${y + 3}" class="chart-axis" text-anchor="end">${Math.round(val)}</text>`
    );
  }
  yParts.push('</svg>');

  const plotParts = [];
  plotParts.push(
    `<svg class="production-plan-svg" viewBox="0 0 ${plotW} ${height}" width="${plotW}" height="${height}">`
  );

  for (let g = 0; g <= 4; g++) {
    const val = (yMax * g) / 4;
    const y = yScale(val);
    plotParts.push(`<line x1="${PAD_PLOT_L}" y1="${y}" x2="${plotW - PAD_R}" y2="${y}" class="chart-grid"/>`);
  }

  const todayIdx = timeline.findIndex((r) => r.date === asOf);

  timeline.forEach((row, i) => {
    const x = x0At(i);
    const isFuture = row.phase === 'future';
    const isToday = row.phase === 'today';
    const showActual = row.phase !== 'future' && (row.actual ?? 0) > 0;
    const showForecast = (row.phase === 'today' || row.phase === 'future') && (row.forecast ?? 0) > 0;

    if (showActual) {
      const h = yScale(0) - yScale(row.actual);
      const y = yScale(row.actual);
      plotParts.push(
        `<rect x="${x}" y="${y}" width="${BAR_W}" height="${h}" fill="#3b82f6" opacity="${isToday ? 0.92 : 1}" class="prod-bar prod-bar-actual" data-date="${row.date}" data-qty="${row.actual}" data-kind="实际"><title>${row.date} 实际 ${row.actual}</title></rect>`
      );
    }

    if (showForecast) {
      const h = yScale(0) - yScale(row.forecast);
      const y = yScale(row.forecast);
      plotParts.push(
        `<rect x="${x}" y="${y}" width="${BAR_W}" height="${h}" fill="#f59e0b" fill-opacity="${isFuture ? 0.35 : 0.5}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3" class="prod-bar prod-bar-forecast" data-date="${row.date}" data-qty="${row.forecast}" data-kind="预计"><title>${row.date} 预计 ${row.forecast}</title></rect>`
      );
    }
  });

  timeline.forEach((row, i) => {
    if (i % Math.max(1, Math.ceil(groups / 14)) !== 0 && i !== groups - 1 && i !== todayIdx) return;
    plotParts.push(
      `<text x="${x0At(i) + BAR_W / 2}" y="${height - 6}" class="chart-axis" text-anchor="middle" font-size="9"${i === todayIdx ? ' font-weight="600" fill="var(--accent,#6366f1)"' : ''}>${row.date.slice(5)}</text>`
    );
  });

  if (todayIdx >= 0) {
    const cx = x0At(todayIdx) + BAR_W / 2;
    plotParts.push(
      `<line x1="${cx}" y1="${PAD_T}" x2="${cx}" y2="${PAD_T + CHART_H}" stroke="var(--accent,#6366f1)" stroke-width="2" class="chart-today-marker"/>`
    );
    plotParts.push(
      `<text x="${cx}" y="${PAD_T - 6}" class="chart-axis chart-today-label" text-anchor="middle" font-size="10" font-weight="600" fill="var(--accent,#6366f1)">今天</text>`
    );
  }

  plotParts.push('</svg>');

  container.innerHTML = `
    <div class="trend-legend">
      <span class="chart-legend-item"><i style="background:#3b82f6"></i>实际产量（已发生）</span>
      <span class="chart-legend-item"><i style="background:transparent;border:2px dashed #f59e0b"></i>预计产量（今天及未来）</span>
      <span class="chart-legend-item chart-legend-ref"><i style="background:transparent;border:2px solid var(--accent,#6366f1)"></i>今天</span>
    </div>
    <div class="chart-scroll-wrap chart-scroll-wrap--with-axis">
      <div class="chart-plot-row">
        <div class="chart-y-axis-fixed">${yParts.join('')}</div>
        <div class="chart-scroll" tabindex="0" aria-label="生产计划柱状图，可拖动查看">
          <div class="chart-scroll-inner" style="width:${plotW}px" data-point-count="${groups}">
            ${plotParts.join('')}
          </div>
        </div>
      </div>
      <input type="range" class="chart-scroll-slider" min="0" max="1000" value="0" aria-label="时间轴滑块" />
    </div>
  `;

  const scrollEl = container.querySelector('.chart-scroll');
  const sliderEl = container.querySelector('.chart-scroll-slider');
  const step = BAR_W + BAR_GAP;

  const scrollToIndex = (idx, center = true) => {
    if (!scrollEl || idx < 0) return;
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    const x = PAD_PLOT_L + idx * step;
    scrollEl.scrollLeft = center
      ? Math.max(0, Math.min(maxScroll, x - scrollEl.clientWidth / 2 + BAR_W))
      : Math.max(0, Math.min(maxScroll, x));
    syncSliderFromScroll(scrollEl, sliderEl);
  };

  if (scrollEl) {
    bindChartScrollUI(scrollEl, sliderEl);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
        if (typeof prevScroll === 'number' && prevScroll > 0) {
          scrollEl.scrollLeft = Math.min(prevScroll, maxScroll);
        } else if (todayIdx >= 0) {
          scrollToIndex(todayIdx, true);
        }
        syncSliderFromScroll(scrollEl, sliderEl);
      });
    });
  }
}
