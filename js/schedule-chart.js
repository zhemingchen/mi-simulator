/**
 * 日排产堆叠柱状图（SVG，Y 轴固定 + 横向滚动）
 */

import { SKU_COLORS } from './schedule-history.js';
import { bindChartScrollUI, syncSliderFromScroll } from './chart-scroll.js';

const BAR_W = 16;
const BAR_GAP = 5;
const Y_AXIS_W = 44;
const PAD_PLOT_L = 8;
const PAD_R = 8;
const PAD_T = 16;
const PAD_B = 52;
/** 绘图区高度（越大柱越高） */
const CHART_H = 480;

const PHASE_LABEL = { past: '过往', today: '今日', future: '未来' };

/**
 * @param {HTMLElement} container
 * @param {{ timeline, products, mode, currentDate, selectedProductIds? }} opts
 * mode: 'planned' | 'actual' | 'both'
 */
export function renderScheduleChart(container, {
  timeline,
  products,
  mode = 'planned',
  currentDate,
  selectedProductIds,
}) {
  if (!timeline.length) {
    container.innerHTML = '<p class="hint">暂无排产数据，请重置或步进仿真。</p>';
    return;
  }

  const filterSet = selectedProductIds
    ? new Set(selectedProductIds)
    : new Set(products.map((p) => p.id));
  const productIds = products.map((p) => p.id).filter((id) => filterSet.has(id));
  const productById = new Map(products.map((p) => [p.id, p]));

  if (!productIds.length) {
    container.innerHTML = '<p class="hint">请至少选择一个 SKU 进行筛选。</p>';
    return;
  }

  const prevScroll = container.querySelector('.chart-scroll')?.scrollLeft;

  const usePlanned = mode === 'planned' || mode === 'both';
  const useActual = mode === 'actual' || mode === 'both';

  const yMax = computeYMax(timeline, currentDate, usePlanned, useActual, filterSet);

  const groups = timeline.length;
  const groupW = mode === 'both' ? BAR_W * 2 + 4 : BAR_W;
  const innerW = groups * (groupW + BAR_GAP);
  const plotW = PAD_PLOT_L + innerW + PAD_R;
  const height = CHART_H + PAD_T + PAD_B;

  const yScale = (v) => PAD_T + CHART_H - (v / yMax) * CHART_H;
  const x0At = (i) => PAD_PLOT_L + i * (groupW + BAR_GAP);

  const yParts = [];
  yParts.push(
    `<svg class="schedule-chart-y-svg" viewBox="0 0 ${Y_AXIS_W} ${height}" width="${Y_AXIS_W}" height="${height}">`
  );
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const val = (yMax * i) / gridSteps;
    const y = yScale(val);
    yParts.push(
      `<text x="${Y_AXIS_W - 6}" y="${y + 4}" class="chart-axis" text-anchor="end">${Math.round(val)}</text>`
    );
  }
  yParts.push('</svg>');

  const plotParts = [];
  plotParts.push(
    `<svg class="schedule-chart-svg" viewBox="0 0 ${plotW} ${height}" width="${plotW}" height="${height}">`
  );

  for (let i = 0; i <= gridSteps; i++) {
    const val = (yMax * i) / gridSteps;
    const y = yScale(val);
    plotParts.push(`<line x1="${PAD_PLOT_L}" y1="${y}" x2="${plotW - PAD_R}" y2="${y}" class="chart-grid"/>`);
  }

  timeline.forEach((row, i) => {
    const x0 = x0At(i);
    const isFuture = row.phase === 'future';
    const isToday = row.phase === 'today';

    if (usePlanned) {
      plotParts.push(stackedBar(x0, BAR_W, row.planned, productIds, yScale, {
        opacity: isFuture ? 0.45 : isToday ? 0.9 : 1,
        dashed: isFuture,
        kind: 'order',
        kindLabel: '日订单',
        date: row.date,
        phase: row.phase,
      }));
    }
    if (useActual && row.phase !== 'future') {
      const x = mode === 'both' ? x0 + BAR_W + 4 : x0;
      plotParts.push(
        stackedBar(x, BAR_W, row.actual, productIds, yScale, {
          opacity: row.phase === 'past' ? 0.92 : 0.75,
          dashed: false,
          kind: 'actual',
          kindLabel: '实际产量',
          date: row.date,
          phase: row.phase,
          outline: true,
        })
      );
    }
  });

  timeline.forEach((row, i) => {
    const x0 = x0At(i);
    const day = parseInt(row.date.slice(8), 10);
    const showLabel =
      i === 0 ||
      i === timeline.length - 1 ||
      day === 1 ||
      i % 7 === 0;
    if (showLabel) {
      const label = row.date.slice(5);
      plotParts.push(
        `<text x="${x0 + groupW / 2}" y="${height - 8}" class="chart-axis" text-anchor="middle">${label}</text>`
      );
    }
  });

  timeline.forEach((row, i) => {
    if (row.phase !== 'today') return;
    const cx = x0At(i) + groupW / 2;
    plotParts.push(`<line x1="${cx}" y1="${PAD_T}" x2="${cx}" y2="${PAD_T + CHART_H}" class="chart-today"/>`);
  });

  plotParts.push('</svg>');

  const legend = products
    .filter((p) => filterSet.has(p.id))
    .map(
      (p) =>
        `<span class="chart-legend-item"><i style="background:${SKU_COLORS[p.id] ?? '#888'}"></i>${p.id.toString().slice(-4)}</span>`
    )
    .join('');

  const modeHint =
    mode === 'planned'
      ? '柱 = 随机拆分的日订单（月合计 = 任务量）'
      : mode === 'actual'
        ? '仅显示已发生日的实际产量'
        : '左柱 = 日订单，右柱 = 实际产量';

  const rangeStart = timeline[0]?.date ?? '';
  const rangeEnd = timeline[timeline.length - 1]?.date ?? '';

  container.innerHTML = `
    <div class="chart-legend">${legend}</div>
    <p class="hint chart-hint">${modeHint} · ${rangeStart} → ${rangeEnd}（共 ${timeline.length} 天）</p>
    <div class="chart-nav">
      <button type="button" class="btn btn-sm chart-nav-btn" data-chart-nav="start">← 起点</button>
      <button type="button" class="btn btn-sm chart-nav-btn" data-chart-nav="today">今天</button>
      <button type="button" class="btn btn-sm chart-nav-btn" data-chart-nav="end">终点 →</button>
      <span class="chart-nav-range" id="chart-visible-range">${rangeStart}</span>
    </div>
    <div class="chart-scroll-wrap chart-scroll-wrap--with-axis">
      <div class="chart-plot-row">
        <div class="chart-y-axis-fixed">${yParts.join('')}</div>
        <div class="chart-scroll" tabindex="0" aria-label="排产趋势图，可拖动平移">
          <div class="chart-scroll-inner" style="width:${plotW}px" data-point-count="${groups}">
            ${plotParts.join('')}
          </div>
        </div>
      </div>
      <input type="range" class="chart-scroll-slider" min="0" max="1000" value="0" aria-label="时间轴滑块" />
    </div>
    <div class="chart-tooltip" hidden></div>
  `;

  const scrollEl = container.querySelector('.chart-scroll');
  const sliderEl = container.querySelector('.chart-scroll-slider');
  const rangeEl = container.querySelector('#chart-visible-range');
  const todayIdx = timeline.findIndex((r) => r.date === currentDate);

  bindChartTooltips(container, productById);

  const scrollToIndex = (idx, center = true) => {
    if (!scrollEl || idx < 0) return;
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    const step = groupW + BAR_GAP;
    const x = PAD_PLOT_L + idx * step;
    scrollEl.scrollLeft = center
      ? Math.max(0, Math.min(maxScroll, x - scrollEl.clientWidth / 2 + groupW))
      : Math.max(0, Math.min(maxScroll, x));
    syncSliderFromScroll(scrollEl, sliderEl);
    updateVisibleRangeHint(scrollEl, timeline, groupW, BAR_GAP, rangeEl);
  };

  if (scrollEl) {
    bindChartScrollUI(scrollEl, sliderEl, () => {
      updateVisibleRangeHint(scrollEl, timeline, groupW, BAR_GAP, rangeEl);
    });

    container.querySelectorAll('[data-chart-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nav = btn.getAttribute('data-chart-nav');
        if (nav === 'start') scrollToIndex(0, false);
        else if (nav === 'end') scrollToIndex(timeline.length - 1, false);
        else scrollToIndex(todayIdx >= 0 ? todayIdx : 0, true);
      });
    });

    const applyInitialScroll = () => {
      const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      if (maxScroll <= 0) {
        syncSliderFromScroll(scrollEl, sliderEl);
        updateVisibleRangeHint(scrollEl, timeline, groupW, BAR_GAP, rangeEl);
        return;
      }
      if (typeof prevScroll === 'number' && prevScroll > 0) {
        scrollEl.scrollLeft = Math.min(prevScroll, maxScroll);
      } else if (todayIdx >= 0) {
        scrollToIndex(todayIdx, true);
        return;
      }
      syncSliderFromScroll(scrollEl, sliderEl);
      updateVisibleRangeHint(scrollEl, timeline, groupW, BAR_GAP, rangeEl);
    };

    requestAnimationFrame(() => requestAnimationFrame(applyInitialScroll));
  }
}

/** HTML 悬停提示：日期、SKU、订单/实际量、阶段 */
function bindChartTooltips(container, productById) {
  const tip = container.querySelector('.chart-tooltip');
  if (!tip) return;

  const hide = () => {
    tip.hidden = true;
  };

  const show = (seg, clientX, clientY) => {
    const pid = Number(seg.dataset.pid);
    const qty = seg.dataset.qty;
    const kindLabel = seg.dataset.kindLabel ?? '';
    const date = seg.dataset.date ?? '';
    const phase = PHASE_LABEL[seg.dataset.phase] ?? seg.dataset.phase ?? '';
    const p = productById.get(pid);
    const name = p?.name ?? '';

    tip.innerHTML = `
      <div class="chart-tooltip-title">${date} · ${phase}</div>
      <div class="chart-tooltip-row"><span>SKU</span><strong>${pid}</strong></div>
      <div class="chart-tooltip-row"><span>描述</span><span>${escHtml(name)}</span></div>
      <div class="chart-tooltip-row"><span>${kindLabel}</span><strong>${qty}</strong></div>
    `;
    tip.hidden = false;

    const rect = container.getBoundingClientRect();
    const tipW = tip.offsetWidth || 200;
    const tipH = tip.offsetHeight || 80;
    let left = clientX - rect.left + 12;
    let top = clientY - rect.top - tipH - 8;
    if (left + tipW > rect.width - 8) left = rect.width - tipW - 8;
    if (top < 4) top = clientY - rect.top + 16;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${top}px`;
  };

  container.querySelectorAll('.chart-bar-seg').forEach((seg) => {
    seg.addEventListener('pointerenter', (e) => show(seg, e.clientX, e.clientY));
    seg.addEventListener('pointermove', (e) => show(seg, e.clientX, e.clientY));
    seg.addEventListener('pointerleave', hide);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 根据滚动位置提示当前可见日期区间 */
function updateVisibleRangeHint(scrollEl, timeline, groupW, barGap, rangeEl) {
  if (!rangeEl || !timeline.length) return;
  const step = groupW + barGap;
  const idx = Math.max(0, Math.floor((scrollEl.scrollLeft + PAD_PLOT_L + step * 0.5) / step));
  const endIdx = Math.min(
    timeline.length - 1,
    Math.max(idx, Math.floor((scrollEl.scrollLeft + scrollEl.clientWidth) / step) - 1)
  );
  rangeEl.textContent = `当前可见：${timeline[idx].date} ~ ${timeline[endIdx].date}`;
}

function stackedBar(x, w, record, productIds, yScale, opts) {
  let yTop = yScale(0);
  const segs = [];
  let total = 0;

  for (const pid of productIds) {
    const v = record[pid] ?? 0;
    if (v <= 0) continue;
    total += v;
    const y1 = yScale(total);
    const h = yTop - y1;
    const color = SKU_COLORS[pid] ?? '#888';
    const dash = opts.dashed ? ' stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 2"' : '';
    const stroke = opts.outline ? ' stroke="#e7ecf3" stroke-width="0.5"' : '';
    segs.push(
      `<rect class="chart-bar-seg" x="${x}" y="${y1}" width="${w}" height="${h}" fill="${color}" opacity="${opts.opacity}"${dash}${stroke}` +
        ` data-date="${opts.date}" data-pid="${pid}" data-qty="${v}" data-kind="${opts.kind}" data-kind-label="${opts.kindLabel}" data-phase="${opts.phase}">` +
        `<title>${opts.date} ${opts.kindLabel} SKU${pid}: ${v}</title></rect>`
    );
    yTop = y1;
  }

  return segs.join('');
}

function parseDateStr(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function niceCeil(v) {
  if (v <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function sumFiltered(record, filterSet) {
  let s = 0;
  for (const pid of filterSet) s += record[pid] ?? 0;
  return s;
}

function computeYMax(timeline, currentDate, usePlanned, useActual, filterSet) {
  const anchor = currentDate ? parseDateStr(currentDate).getTime() : null;
  const msPerDay = 86400000;
  let peak = 0;

  for (const row of timeline) {
    if (usePlanned) peak = Math.max(peak, sumFiltered(row.planned, filterSet));
    if (useActual && row.phase !== 'future') peak = Math.max(peak, sumFiltered(row.actual, filterSet));
  }

  if (peak <= 0 && anchor != null) {
    const nearby = timeline
      .filter((row) => Math.abs(parseDateStr(row.date).getTime() - anchor) / msPerDay <= 14)
      .map((row) => {
        let v = 0;
        if (usePlanned) v = Math.max(v, sumFiltered(row.planned, filterSet));
        if (useActual && row.phase !== 'future') v = Math.max(v, sumFiltered(row.actual, filterSet));
        return v;
      })
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    if (nearby.length) peak = nearby[Math.floor(nearby.length / 2)];
  }

  if (peak <= 0) peak = 1;
  return niceCeil(Math.max(peak * 1.12, 1));
}
