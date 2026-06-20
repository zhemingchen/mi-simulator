/**
 * 图表横向滚动：拖动 + 滑块同步
 */

export function syncSliderFromScroll(scrollEl, sliderEl) {
  if (!sliderEl || !scrollEl) return;
  const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
  if (maxScroll <= 0) {
    sliderEl.value = '0';
    sliderEl.disabled = true;
    return;
  }
  sliderEl.disabled = false;
  sliderEl.value = String(Math.round((scrollEl.scrollLeft / maxScroll) * 1000));
}

/** 拖动平移 + 底部滑块 + 滚轮横向 */
export function bindChartScrollUI(scrollEl, sliderEl, onScroll) {
  if (!scrollEl) return;

  let dragging = false;
  let startX = 0;
  let startScroll = 0;

  const syncSlider = () => {
    syncSliderFromScroll(scrollEl, sliderEl);
    onScroll?.();
  };

  scrollEl.addEventListener('scroll', syncSlider, { passive: true });

  scrollEl.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (scrollEl.scrollWidth <= scrollEl.clientWidth) return;
      scrollEl.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false }
  );

  scrollEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.chart-bar-seg, a, button, input, select')) return;
    dragging = true;
    startX = e.clientX;
    startScroll = scrollEl.scrollLeft;
    scrollEl.setPointerCapture(e.pointerId);
    scrollEl.classList.add('is-dragging');
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    scrollEl.classList.remove('is-dragging');
    if (e.pointerId != null) {
      try {
        scrollEl.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  scrollEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    scrollEl.scrollLeft = startScroll - (e.clientX - startX);
  });
  scrollEl.addEventListener('pointerup', endDrag);
  scrollEl.addEventListener('pointercancel', endDrag);

  sliderEl?.addEventListener('input', () => {
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    scrollEl.scrollLeft = (Number(sliderEl.value) / 1000) * maxScroll;
  });

  syncSlider();
}

/** 初始化滚动位置（优先 today 索引） */
export function initChartScrollPosition(scrollEl, sliderEl, { todayIdx = -1, prevScroll } = {}) {
  if (!scrollEl) return;

  const apply = () => {
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    if (maxScroll <= 0) {
      syncSliderFromScroll(scrollEl, sliderEl);
      return;
    }
    if (typeof prevScroll === 'number' && prevScroll > 0) {
      scrollEl.scrollLeft = Math.min(prevScroll, maxScroll);
    } else if (todayIdx >= 0) {
      const inner = scrollEl.querySelector('.chart-scroll-inner');
      const plotW = inner?.offsetWidth ?? scrollEl.scrollWidth;
      const n = Math.max(1, Number(inner?.dataset.pointCount) || 1);
      const step = plotW / Math.max(1, n - 1);
      const x = todayIdx * step;
      scrollEl.scrollLeft = Math.max(0, Math.min(maxScroll, x - scrollEl.clientWidth / 2));
    } else {
      scrollEl.scrollLeft = maxScroll;
    }
    syncSliderFromScroll(scrollEl, sliderEl);
  };

  requestAnimationFrame(() => requestAnimationFrame(apply));
}
