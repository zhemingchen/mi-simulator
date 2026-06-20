/**
 * 折线/趋势图：按日期悬停显示各序列数值
 */

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  return n.toFixed(1);
}

/**
 * @param {Array<{ label, color?, splitMode?, actualPoints?, forecastPoints?, points? }>} series
 * @param {string[]} dates
 * @param {string|null} todayMarker
 */
export function buildSeriesValuesByDate(series, dates, todayMarker = null) {
  return dates.map((date) => {
    const entries = [];
    for (const s of series ?? []) {
      const color = s.color ?? '#3b82f6';
      if (s.splitMode) {
        let pt = null;
        let segment = '';
        if (todayMarker && date < todayMarker) {
          pt = (s.actualPoints ?? []).find((p) => p.date === date);
          segment = '已发生';
        } else {
          pt = (s.forecastPoints ?? []).find((p) => p.date === date);
          segment = '预计';
        }
        if (pt) entries.push({ label: s.label, value: pt.value, color, segment });
        continue;
      }
      const byDate = new Map((s.points ?? []).map((p) => [p.date, p.value]));
      if (byDate.has(date)) {
        entries.push({ label: s.label, value: byDate.get(date), color, segment: '' });
      }
    }
    return { date, entries };
  });
}

/**
 * 在 SVG 中插入透明 hover 带
 */
export function hoverBandSvg(dates, xAt, plotTop, plotHeight, plotLeft, plotRight) {
  const n = dates.length;
  if (n <= 0) return '';
  const parts = ['<g class="chart-hover-layer">'];
  for (let i = 0; i < n; i++) {
    const xLeft = i === 0 ? plotLeft : (xAt(i - 1) + xAt(i)) / 2;
    const xRight = i === n - 1 ? plotRight : (xAt(i) + xAt(i + 1)) / 2;
    const w = Math.max(1, xRight - xLeft);
    parts.push(
      `<rect class="chart-hover-band" x="${xLeft.toFixed(1)}" y="${plotTop}" width="${w.toFixed(1)}" height="${plotHeight}" fill="transparent" data-date-idx="${i}"/>`
    );
  }
  parts.push('</g>');
  return parts.join('');
}

/**
 * @param {HTMLElement} container 含 .chart-tooltip 与 hover band 的根节点
 * @param {ReturnType<typeof buildSeriesValuesByDate>} valuesByDate
 */
export function bindDateHoverTooltip(container, valuesByDate) {
  const tip = container.querySelector('.chart-tooltip');
  if (!tip || !valuesByDate?.length) return;

  const hide = () => {
    tip.hidden = true;
  };

  const show = (idx, clientX, clientY) => {
    const row = valuesByDate[idx];
    if (!row) return hide();

    const lines = row.entries
      .map((e) => {
        const seg = e.segment ? ` <span class="chart-tooltip-seg">(${e.segment})</span>` : '';
        return `<div class="chart-tooltip-row"><span><i class="chart-tooltip-dot" style="background:${e.color}"></i>${escHtml(e.label)}${seg}</span><strong>${formatValue(e.value)}</strong></div>`;
      })
      .join('');

    tip.innerHTML = `<div class="chart-tooltip-title">${row.date}</div>${lines || '<div class="chart-tooltip-row"><span>无数据</span></div>'}`;
    tip.hidden = false;

    const rect = container.getBoundingClientRect();
    const tipW = tip.offsetWidth || 220;
    const tipH = tip.offsetHeight || 80;
    let left = clientX - rect.left + 12;
    let top = clientY - rect.top - tipH - 8;
    if (left + tipW > rect.width - 8) left = rect.width - tipW - 8;
    if (top < 4) top = clientY - rect.top + 16;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${top}px`;
  };

  container.querySelectorAll('.chart-hover-band').forEach((band) => {
    band.addEventListener('pointerenter', (e) => show(Number(band.dataset.dateIdx), e.clientX, e.clientY));
    band.addEventListener('pointermove', (e) => show(Number(band.dataset.dateIdx), e.clientX, e.clientY));
    band.addEventListener('pointerleave', hide);
  });
}
