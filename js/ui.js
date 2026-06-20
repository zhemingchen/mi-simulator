/**
 * 界面渲染与交互
 */

import { inTransitQty } from './procurement.js';
import { getScheduleTimeline, SKU_COLORS } from './schedule-history.js';
import { renderScheduleChart } from './schedule-chart.js';
import { computeOrderDeliveryStatuses, ORDER_DELIVERY_STATUS_LABEL, getOrderLostWaitDays } from './order-delivery.js';
import { renderTrendChart } from './inventory-trend-chart.js';
import { renderProductionPlanChart } from './production-plan-chart.js';
import { buildProductionPlanTimeline } from './production-plan-data.js';
import { DEFAULT_FORWARD_PROJECTION_DAYS, buildDashboardMetricSeries, buildDashboardProductMetricSeries, readDashboardRowMetric, buildRawMaterialMetricSeries, buildInTransitForwardProjection, buildInTransitMaterialMetricSeries, getForwardProjectionCache, scheduleForwardProjection, invalidateForwardProjectionCache } from './dashboard-forecast.js';
import { rebuildDailyPlans, getPlanningRebuildStartDate, PLANNING_HORIZON_DAYS } from './simulation.js';
import { addDays, formatDate, parseDate } from './scheduler.js';
import { syncDerivedRawSafetyStock } from './mrp-planner.js';
import {
  getProductProductionPolicy,
  snapProductionInput,
  DEFAULT_MIN_PRODUCTION_QTY,
  DEFAULT_BATCH_SIZE,
} from './production-policy.js';
import { DEFAULT_FINISHED_GOODS_SS } from './data-loader.js';
import { SUPPLIER_DELAY_MEAN_RATIO } from './supplier-policy.js';
import {
  buildCapacityForecastScheduleHint,
  DEFAULT_CAPACITY_POLICY,
  CAPACITY_FORECAST_FAR_END,
  normalizeCapacityPolicy,
  normalizeCapacityForecastSegment,
  applyCapacityForecastFromDate,
  listEditableCapacityForecastSegments,
  createDefaultCapacityForecastSchedule,
  getCapacityPolicyForDate,
  ensureCapacityForecastSchedule,
} from './capacity-policy.js';

const $ = (sel) => document.querySelector(sel);

/** Policy 产能分时段表刷新（步进后更新 asOf） */
let refreshCapacityForecastUI = null;
/** 进行中的前瞻异步任务取消函数 */
let cancelForwardProjection = null;

function firstChangedCapacityDate(sim, nextSchedule, asOf) {
  for (let i = 0; i < PLANNING_HORIZON_DAYS; i++) {
    const day = formatDate(addDays(parseDate(asOf), i));
    const prev = getCapacityPolicyForDate(sim.capacityForecastSchedule, day, sim._simStartDate);
    const next = getCapacityPolicyForDate(nextSchedule, day, sim._simStartDate);
    if (
      (prev?.mean ?? null) !== (next?.mean ?? null) ||
      (prev?.p90Low ?? null) !== (next?.p90Low ?? null) ||
      (prev?.p90High ?? null) !== (next?.p90High ?? null) ||
      (prev?.max ?? null) !== (next?.max ?? null)
    ) {
      return day;
    }
  }
  return null;
}

function isTabPanelActive(panelId) {
  return document.getElementById(panelId)?.classList.contains('active') ?? false;
}

/** 取消进行中的前瞻并重置缓存（步进/重置时调用） */
export function invalidateDashboardProjection(sim) {
  cancelForwardProjection?.();
  cancelForwardProjection = null;
  invalidateForwardProjectionCache(sim);
}

function ensureForwardProjection(sim, onReady) {
  const cached = getForwardProjectionCache(sim);
  if (cached) {
    onReady(cached);
    return;
  }
  cancelForwardProjection?.();
  cancelForwardProjection = scheduleForwardProjection(
    sim,
    DEFAULT_FORWARD_PROJECTION_DAYS,
    (data) => {
      cancelForwardProjection = null;
      onReady(data);
    }
  );
}

export function initTabs(onTabChange) {
  document.querySelectorAll('.tabs:not(.tabs-vertical) .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      btn.closest('.panel')?.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      btn.closest('.panel')?.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${tab}`);
      });
      onTabChange?.();
    });
  });

  document.querySelectorAll('.tabs-vertical .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const side = btn.dataset.side;
      btn.closest('.panel')?.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      btn.closest('.panel')?.querySelectorAll('.side-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `side-${side}`);
      });
    });
  });
}

export function renderAll(sim, master) {
  const snap = sim._lastSnap;
  if (!snap) return;

  $('#sim-date').textContent = snap.date;
  const stateEl = $('#sim-state');
  stateEl.textContent = stateLabel(snap.runState);
  stateEl.className = `badge badge-${badgeClass(snap.runState)}`;

  $('#kpi-planned').textContent = Math.round(snap.stats.lastDayPlanned);
  $('#kpi-produced').textContent = snap.stats.lastDayProduced;
  $('#kpi-shortage').textContent = countShortageSkus(snap);
  $('#kpi-below-ss').textContent = snap.belowSafety;
  $('#kpi-open-po').textContent = snap.openPo;
  $('#kpi-manual').textContent = snap.stats.manualDecisions;

  renderDailyPlan(sim, master, snap);
  renderShortagePanel(master, snap);
  renderInventory(sim, master, snap);
  renderProductionPlanTab(sim, master, snap);
  renderPolicyView(sim);

  if (isTabPanelActive('tab-dashboard')) {
    renderDashboard(sim, master, snap);
  }
  if (isTabPanelActive('tab-raw-material')) {
    renderRawMaterialTrendChart(sim, master);
  }
  if (isTabPanelActive('tab-shortage')) {
    renderInTransitTrendChart(sim, master);
  }
}

function stateLabel(s) {
  return (
    { idle: '就绪', running: '运行中', paused: '暂停中', waiting: '等待决策' }[s] ?? s
  );
}

function badgeClass(s) {
  return (
    { idle: 'idle', running: 'running', paused: 'paused', waiting: 'waiting' }[s] ?? 'idle'
  );
}

function countShortageSkus(snap) {
  let n = 0;
  for (const [, st] of snap.kitStatus) {
    if (st.planned > 0 && !st.kitReady) n += 1;
  }
  return n;
}

export function bindChartMode(sim, onChange) {
  document.querySelectorAll('input[name="chart-mode"]').forEach((inp) => {
    inp.addEventListener('change', () => {
      if (!inp.checked) return;
      sim.chartMode = inp.value;
      onChange?.();
    });
  });
}

/** 确保 SKU 筛选集合已初始化 */
export function ensureScheduleSkuFilter(sim, master) {
  if (!sim.scheduleSkuFilter || !(sim.scheduleSkuFilter instanceof Set)) {
    sim.scheduleSkuFilter = new Set(master.products.map((p) => p.id));
  }
}

/** 当前选中的 SKU id 列表 */
export function getSelectedScheduleSkus(sim, master) {
  ensureScheduleSkuFilter(sim, master);
  const valid = new Set(master.products.map((p) => p.id));
  return [...sim.scheduleSkuFilter].filter((id) => valid.has(id));
}

function updateSkuFilterUI(container, sim) {
  if (!container) return;
  container.querySelectorAll('.sku-filter-chip').forEach((chip) => {
    const pid = Number(chip.dataset.pid);
    chip.classList.toggle('active', sim.scheduleSkuFilter.has(pid));
  });
}

/** 绑定排产趋势 SKU 多选筛选 */
export function bindScheduleSkuFilter(sim, master, onChange) {
  ensureScheduleSkuFilter(sim, master);
  const container = $('#schedule-sku-filter');
  if (!container || container.dataset.bound) {
    updateSkuFilterUI(container, sim);
    return;
  }
  container.dataset.bound = '1';

  container.innerHTML = master.products
    .map(
      (p) =>
        `<button type="button" class="sku-filter-chip" data-pid="${p.id}" title="${esc(p.name)}" style="--chip-color:${SKU_COLORS[p.id] ?? '#888'}">${String(p.id).slice(-4)}</button>`
    )
    .join('');

  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.sku-filter-chip');
    if (!chip) return;
    const pid = Number(chip.dataset.pid);
    if (sim.scheduleSkuFilter.has(pid)) sim.scheduleSkuFilter.delete(pid);
    else sim.scheduleSkuFilter.add(pid);
    updateSkuFilterUI(container, sim);
    onChange?.();
  });

  $('#schedule-sku-all')?.addEventListener('click', () => {
    sim.scheduleSkuFilter = new Set(master.products.map((p) => p.id));
    updateSkuFilterUI(container, sim);
    onChange?.();
  });

  $('#schedule-sku-none')?.addEventListener('click', () => {
    sim.scheduleSkuFilter = new Set();
    updateSkuFilterUI(container, sim);
    onChange?.();
  });

  updateSkuFilterUI(container, sim);
}

/** 仅刷新排产趋势区域（图表 + 订单表） */
export function renderSchedulePartial(sim, master) {
  const snap = sim._lastSnap;
  if (!snap) return;
  renderScheduleView(sim, master, snap);
}

function renderScheduleView(sim, master, snap) {
  const container = $('#schedule-chart');
  if (!container) return;

  ensureScheduleSkuFilter(sim, master);
  updateSkuFilterUI($('#schedule-sku-filter'), sim);

  const timeline = getScheduleTimeline(sim);
  const selectedProductIds = getSelectedScheduleSkus(sim, master);

  renderScheduleChart(container, {
    timeline,
    products: master.products,
    mode: sim.chartMode ?? 'planned',
    currentDate: snap.date,
    selectedProductIds,
  });

  renderOrderTable(timeline, master, sim, selectedProductIds);
}

function renderOrderStatusCell(status, detail) {
  const label = ORDER_DELIVERY_STATUS_LABEL[status] ?? status;
  const cls =
    status === 'delivered' ? 'order-status-delivered' : status === 'lost' ? 'order-status-lost' : 'order-status-pending';
  const title = detail ? esc(detail) : '';
  return `<td${title ? ` title="${title}"` : ''}><span class="order-status ${cls}">${label}</span></td>`;
}

function renderOrderTable(timeline, master, sim, selectedProductIds) {
  const tbody = $('#schedule-order-table tbody');
  const table = $('#schedule-order-table');
  if (!tbody || !table) return;

  const mode = sim.chartMode ?? 'planned';
  const showActual = mode === 'actual' || mode === 'both';
  const showOrder = mode === 'planned' || mode === 'both';
  const selected = selectedProductIds ?? getSelectedScheduleSkus(sim, master);
  const selectedSet = new Set(selected);

  table.querySelectorAll('.col-schedule-order').forEach((el) => {
    el.style.display = showOrder ? '' : 'none';
  });
  table.querySelectorAll('.col-schedule-actual').forEach((el) => {
    el.style.display = showActual ? '' : 'none';
  });

  const phaseLabel = { past: '过往', today: '今日', future: '未来' };
  const productById = new Map(master.products.map((p) => [p.id, p]));
  const deliveryStatuses = computeOrderDeliveryStatuses(sim, timeline);
  const rows = [];

  for (const row of timeline) {
    for (const pid of selected) {
      const orderQty = row.planned[pid] ?? 0;
      const actualQty = row.phase === 'future' ? 0 : (row.actual[pid] ?? 0);

      if (showOrder && !showActual && orderQty <= 0) continue;
      if (!showOrder && showActual && actualQty <= 0) continue;
      if (showOrder && showActual && orderQty <= 0 && actualQty <= 0) continue;

      const p = productById.get(pid);
      const delivery = deliveryStatuses.get(`${row.date}|${pid}`) ?? { status: 'pending' };
      rows.push({
        date: row.date,
        phase: row.phase,
        pid,
        name: p?.name ?? '',
        orderQty,
        actualQty,
        status: delivery.status,
        statusDetail:
          delivery.status === 'delivered' && delivery.deliveredDate
            ? `整单交货于 ${delivery.deliveredDate}`
            : delivery.status === 'lost'
              ? `交期 ${row.date} 起等待 ${getOrderLostWaitDays(sim)} 天仍未齐套，订单丢失`
              : row.phase === 'future'
                ? '未到交期'
                : '成品仓未齐套，整单待交',
      });
    }
  }

  if (!selectedSet.size) {
    tbody.innerHTML = '<tr><td colspan="7" class="hint">请选择至少一个 SKU</td></tr>';
    return;
  }

  tbody.innerHTML = rows.length
    ? rows
        .map(
          (r) => `
    <tr class="row-${r.phase}">
      <td>${r.date}</td>
      <td>${phaseLabel[r.phase] ?? r.phase}</td>
      <td>${r.pid}</td>
      <td title="${esc(r.name)}">${esc(trunc(r.name, 32))}</td>
      <td class="col-schedule-order">${showOrder ? r.orderQty : '—'}</td>
      <td class="col-schedule-actual">${showActual ? (r.phase === 'future' ? '—' : r.actualQty) : '—'}</td>
      ${renderOrderStatusCell(r.status, r.statusDetail)}
    </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="hint">当前筛选条件下无订单数据</td></tr>';
}

function renderDailyPlan(sim, master, snap) {
  const tbody = $('#daily-plan-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const ssInfo = snap.ssBatchByProduct ?? {};
  let belowCount = 0;
  let nextBatchDates = new Set();
  for (const p of master.products) {
    const info = ssInfo[p.id];
    if (info?.belowSs) belowCount += 1;
    if (info?.nextBatchDate) nextBatchDates.add(info.nextBatchDate);
  }

  const summary = $('#daily-plan-summary');
  if (summary) {
    const prevDate = formatDate(addDays(parseDate(snap.date), -1));
    const timeHint = `仿真日 <strong>${snap.date}</strong>：「日计划/齐套」= 今日；「成品库存/上日实际」= <strong>${prevDate}</strong> 步进结果（生产后整单出库，库存不叠加计划量）。`;
    const fgSsTotal = master.products.reduce(
      (s, p) => s + (snap.safetyStock.finishedGoods[String(p.id)] ?? 0),
      0
    );
    if (fgSsTotal <= 0) {
      summary.innerHTML = `${timeHint}<br />未配置成品 SS：请在 Policy「成品安全库存」填写。`;
    } else if (belowCount > 0 && nextBatchDates.size > 0) {
      const dates = [...nextBatchDates].sort().join('、');
      summary.innerHTML =
        `${timeHint}<br />当前 <strong>${belowCount}</strong> 个 SKU 低于 SS；下一批 SS 组装日：<strong>${dates}</strong>。`;
    } else if (belowCount > 0) {
      summary.innerHTML = `${timeHint}<br />当前 <strong>${belowCount}</strong> 个 SKU 低于 SS，尚未排上下一批次。`;
    } else {
      summary.innerHTML = `${timeHint}<br />各 SKU 成品库存均 ≥ SS，或当日无 SS 批次计划。`;
    }
  }

  for (const p of master.products) {
    const st = snap.kitStatus.get(p.id) ?? { planned: 0, kitReady: true, maxQty: 0 };
    const actual = snap.todayActual.get(p.id) ?? 0;
    const info = ssInfo[p.id] ?? { ss: 0, stock: 0, nextBatchDate: null, nextBatchQty: 0, belowSs: false };
    const kitLabel =
      st.planned > 0
        ? st.partialKit
          ? `部分齐套→${st.maxQty}`
          : st.kitReady
            ? '齐套'
            : '缺料'
        : '—';
    const kitClass =
      st.planned > 0 ? (st.kitReady ? 'status-ok' : st.partialKit ? 'status-warn' : 'status-bad') : '';
    const stockClass = info.belowSs ? 'status-warn' : '';
    const batchCell =
      info.belowSs && info.nextBatchDate
        ? `${info.nextBatchDate} ×${info.nextBatchQty}`
        : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td title="${esc(p.name)}">${esc(trunc(p.name, 28))}</td>
      <td>${st.planned}</td>
      <td class="${kitClass}">${kitLabel}</td>
      <td class="${stockClass}">${info.stock}</td>
      <td>${info.ss > 0 ? info.ss : '—'}</td>
      <td>${batchCell}</td>
      <td>${actual}</td>
      <td>${snap.monthRemaining[p.id] ?? 0}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderShortagePanel(master, snap) {
  const report = snap.shortageReport;
  if (!report) return;

  const summaryEl = $('#shortage-summary');
  if (summaryEl) {
    if (!report.hasShortage) {
      summaryEl.innerHTML =
        '<div class="shortage-banner shortage-ok">当日计划 SKU 原料齐套（含当日计划到货），无缺料。</div>';
    } else {
      summaryEl.innerHTML = `
        <div class="shortage-banner shortage-bad">
          <strong>${report.shortageSkuCount}</strong> 个 SKU 缺料，
          涉及 <strong>${report.shortageMaterialCount}</strong> 种原料
        </div>`;
    }
  }

  const skuBody = $('#shortage-sku-table tbody');
  if (skuBody) {
    const plannedSkus = report.skuRows;
    if (!plannedSkus.length) {
      skuBody.innerHTML = '<tr><td colspan="6" class="hint-cell">当日无排产计划</td></tr>';
    } else {
      skuBody.innerHTML = plannedSkus
        .map((row) => {
          const p = master.products.find((x) => x.id === row.productId);
          return `
          <tr>
            <td>${row.productId}</td>
            <td title="${esc(p?.name ?? '')}">${esc(trunc(p?.name ?? '', 28))}</td>
            <td>${row.planned}</td>
            <td>${row.maxQty}</td>
            <td class="${row.kitReady ? 'status-ok' : row.maxQty > 0 ? 'status-warn' : 'status-bad'}">${row.kitReady ? '齐套' : row.maxQty > 0 ? `部分→${row.maxQty}` : '缺料'}</td>
            <td>${row.shortageCount}</td>
          </tr>`;
        })
        .join('');
    }
  }

  const matBody = $('#shortage-material-table tbody');
  if (matBody) {
    if (!report.materialRows.length) {
      matBody.innerHTML = '<tr><td colspan="9" class="hint-cell">无原料缺口</td></tr>';
    } else {
      matBody.innerHTML = report.materialRows
        .map((row) => {
          const skuLabel = row.productIds.map((id) => String(id).slice(-4)).join(', ');
          return `
          <tr>
            <td>${row.materialId}</td>
            <td title="${esc(row.name)}">${esc(trunc(row.name, 24))}</td>
            <td>${skuLabel}</td>
            <td>${fmtQty(row.need)}</td>
            <td>${fmtQty(row.have)}</td>
            <td class="status-bad">${fmtQty(row.gap)}</td>
            <td>${fmtQty(row.rawStock)}</td>
            <td>${fmtQty(row.todayArrival)}</td>
            <td>${fmtQty(row.inTransit)}</td>
          </tr>`;
        })
        .join('');
    }
  }
}

function fmtQty(v) {
  return Number(v).toFixed(2);
}

function renderMonthlyTasks(sim, master, snap) {
  const tbody = $('#monthly-task-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const p of master.products) {
    const eff = snap.effectiveTasks[p.id] ?? 0;
    const prod = snap.producedThisMonth[p.id] ?? 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td>${eff}</td>
      <td>${prod}</td>
      <td>${Math.max(0, eff - prod)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderInventory(sim, master, snap) {
  const tbody = $('#inventory-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const selection = getRawMaterialChartSelection();
  const rows = [];

  for (const m of master.materials) {
    const stock = sim.inventory.raw.get(m.id) ?? 0;
    const transit = inTransitQty(sim.procurement, m.id, sim.currentDate);
    if (selection !== 'total' && String(m.id) !== String(selection)) continue;
    if (selection === 'total' && stock <= 0 && transit <= 0) continue;
    rows.push({ m, stock, transit });
  }

  if (selection !== 'total' && !rows.length) {
    const m = master.materials.find((x) => String(x.id) === String(selection));
    if (m) {
      rows.push({
        m,
        stock: sim.inventory.raw.get(m.id) ?? 0,
        transit: inTransitQty(sim.procurement, m.id, sim.currentDate),
      });
    }
  }

  rows.sort((a, b) => (b.transit - a.transit) || (b.stock - a.stock));
  const limit = selection === 'total' ? 40 : rows.length;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="hint">暂无库存/在途数据</td></tr>';
    return;
  }

  for (const r of rows.slice(0, limit)) {
    const tr = document.createElement('tr');
    if (selection !== 'total') tr.classList.add('row-selected');
    tr.innerHTML = `
      <td>${r.m.id}</td>
      <td title="${esc(r.m.name)}">${esc(trunc(r.m.name, 24))}</td>
      <td>${r.stock.toFixed(2)}</td>
      <td>${r.transit.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

/** 原料趋势图当前选中：total | materialId */
let rawMaterialChartSelection = 'total';

export function getRawMaterialChartSelection() {
  return rawMaterialChartSelection;
}

/** 原料库存趋势：按物料描述单选 */
export function bindRawMaterialChartSelector(master, onChange) {
  const sel = $('#raw-material-chart-select');
  if (!sel) return;

  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      rawMaterialChartSelection = sel.value;
      onChange?.();
    });
  }

  const prev = rawMaterialChartSelection;
  const sorted = master.materials.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  sel.innerHTML =
    `<option value="total">全部原料合计</option>` +
    sorted
      .map(
        (m) =>
          `<option value="${m.id}">${esc(trunc(m.name, 40))}（${m.id}）</option>`
      )
      .join('');

  if (prev === 'total' || sorted.some((m) => String(m.id) === prev)) {
    sel.value = prev;
  } else {
    rawMaterialChartSelection = 'total';
    sel.value = 'total';
  }
}

/** 生产计划 Tab：SKU 选择 */
let productionPlanSkuSelection = 'total';

export function getProductionPlanSkuSelection() {
  return productionPlanSkuSelection;
}

export function bindProductionPlanSkuSelector(master, onChange) {
  const sel = $('#production-plan-sku-select');
  if (!sel) return;

  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      productionPlanSkuSelection = sel.value;
      onChange?.();
    });
  }

  const prev = productionPlanSkuSelection;
  sel.innerHTML =
    `<option value="total">全部 SKU 合计</option>` +
    master.products
      .map((p) => `<option value="${p.id}">${p.id} · ${esc(trunc(p.name, 36))}</option>`)
      .join('');

  if (prev === 'total' || master.products.some((p) => String(p.id) === prev)) {
    sel.value = prev;
  } else {
    productionPlanSkuSelection = 'total';
    sel.value = 'total';
  }
}

function renderProductionPlanTab(sim, master, snap) {
  const container = $('#chart-production-plan');
  if (!container) return;

  const selection = getProductionPlanSkuSelection();
  const timeline = buildProductionPlanTimeline(sim, selection, PLANNING_HORIZON_DAYS);
  const product = master.products.find((p) => String(p.id) === String(selection));
  const skuLabel =
    selection === 'total' ? '全部 SKU 合计' : `${selection} · ${trunc(product?.name ?? '', 20)}`;

  renderProductionPlanChart(container, {
    timeline,
    currentDate: snap.date,
    skuLabel,
  });
}

/** 原料库存 Tab：趋势图 */
function renderRawMaterialTrendChart(sim, master) {
  const hist = sim.inventoryHistory ?? [];
  const asOf = formatDate(sim.currentDate);
  const selection = getRawMaterialChartSelection();
  const chartEl = $('#chart-inventory-raw');

  const draw = (forecast) => {
    if (!chartEl || !isTabPanelActive('tab-raw-material')) return;
    const rows = forecast?.rows ?? [];
    renderTrendChart(chartEl, {
      title:
        selection === 'total'
          ? `原料库存总量 · 自 ${asOf} 前瞻`
          : `原料库存 · ${trunc(master.materials.find((m) => String(m.id) === selection)?.name ?? selection, 28)}`,
      scrollable: true,
      todayMarker: asOf,
      series:
        selection === 'total'
          ? [
              buildDashboardMetricSeries(hist, rows, 'rawTotal', asOf, '账面合计', '#3b82f6'),
            ]
          : [
              buildRawMaterialMetricSeries(
                hist,
                rows,
                Number(selection),
                asOf,
                trunc(master.materials.find((m) => String(m.id) === selection)?.name ?? selection, 20),
                '#3b82f6'
              ),
            ],
      referenceLines: [],
    });
  };

  const cached = getForwardProjectionCache(sim);
  if (cached) {
    draw(cached);
    return;
  }

  if (chartEl) {
    chartEl.innerHTML =
      '<p class="chart-loading">前瞻计算中…（计算完成后显示图表）</p>';
  }
  ensureForwardProjection(sim, draw);
}

/** 缺料情况 Tab：在途 PO backlog 趋势 */
let inTransitChartSelection = 'total';

export function getInTransitChartSelection() {
  return inTransitChartSelection;
}

export function bindInTransitChartSelector(master, onChange) {
  const sel = $('#in-transit-chart-select');
  if (!sel) return;

  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      inTransitChartSelection = sel.value;
      onChange?.();
    });
  }

  const prev = inTransitChartSelection;
  const sorted = master.materials.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  sel.innerHTML =
    `<option value="total">全部在途合计</option>` +
    sorted
      .map(
        (m) =>
          `<option value="${m.id}">${esc(trunc(m.name, 40))}（${m.id}）</option>`
      )
      .join('');

  if (prev === 'total' || sorted.some((m) => String(m.id) === prev)) {
    sel.value = prev;
  } else {
    inTransitChartSelection = 'total';
    sel.value = 'total';
  }
}

function renderInTransitTrendChart(sim, master) {
  const hist = sim.inventoryHistory ?? [];
  const asOf = formatDate(sim.currentDate);
  const transitForecast = buildInTransitForwardProjection(sim, DEFAULT_FORWARD_PROJECTION_DAYS);
  const selection = getInTransitChartSelection();

  renderTrendChart($('#chart-in-transit'), {
    title:
      selection === 'total'
        ? `在途来料 backlog · 自 ${asOf} 前瞻`
        : `在途来料 · ${trunc(master.materials.find((m) => String(m.id) === selection)?.name ?? selection, 28)}`,
    scrollable: true,
    todayMarker: asOf,
    series:
      selection === 'total'
        ? [
            buildDashboardMetricSeries(
              hist,
              transitForecast.rows,
              'inTransitTotal',
              asOf,
              '在途合计',
              '#f59e0b'
            ),
          ]
        : [
            buildInTransitMaterialMetricSeries(
              hist,
              transitForecast.rows,
              Number(selection),
              asOf,
              trunc(master.materials.find((m) => String(m.id) === selection)?.name ?? selection, 20),
              '#f59e0b'
            ),
          ],
    referenceLines: [],
  });
}

const EVENT_LOG_PRIORITY_TYPES = new Set([
  'ship',
  'warn',
  'prod',
  'arrival',
  'decision',
  'reroute',
  'sys',
]);

/** 优先展示整单/生产/到货等业务事件，避免采购 rebuild 日志占满 80 条 */
function pickEventLogEntries(events, limit = 80) {
  const list = events ?? [];
  const priority = [];
  const rest = [];
  for (const e of list) {
    const msg = e.message ?? '';
    const isPriority =
      EVENT_LOG_PRIORITY_TYPES.has(e.type) ||
      /整单|订单丢失|生产 SKU|到货|转产|等待人工/.test(msg);
    if (isPriority) priority.push(e);
    else rest.push(e);
  }
  const merged = [];
  const seen = new Set();
  for (const e of [...priority, ...rest]) {
    const key = `${e.time}|${e.type ?? ''}|${e.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
    if (merged.length >= limit) break;
  }
  return merged;
}

function renderEventLog(snap) {
  const ul = $('#event-log');
  ul.innerHTML = pickEventLogEntries(snap.events)
    .map(
      (e) =>
        `<li class="evt-${esc(e.type ?? 'info')}"><span class="time">${e.time}</span>${esc(e.message)}</li>`
    )
    .join('');
}

function renderPoTable(snap, master) {
  const tbody = $('#po-table tbody');
  tbody.innerHTML = snap.procurementOrders
    .slice()
    .reverse()
    .map((o) => {
      const planned = o.plannedArriveDate ?? o.arriveDate;
      const delay = o.supplierDelayDays ?? 0;
      const arriveCell =
        delay > 0
          ? `${o.arriveDate} <small class="po-delay" title="计划 ${planned}">+${delay}d</small>`
          : o.arriveDate;
      return `<tr><td>${o.materialId}</td><td>${o.qty.toFixed(1)}</td><td>${o.orderDate}</td><td>${arriveCell}</td></tr>`;
    })
    .join('');
}

/** 渲染安全库存编辑列表 */
export function renderSafetyStockEditors(sim, master, onRefresh) {
  const fgList = $('#fg-safety-list');
  if (!fgList) return;
  fgList.innerHTML = master.products
    .map((p) => {
      const v = sim.safetyStock.finishedGoods[String(p.id)] ?? 0;
      return `
        <div class="ss-row" data-type="fg" data-id="${p.id}">
          <span>${p.id}</span>
          <span class="name" title="${esc(p.name)}">${esc(trunc(p.name, 18))}</span>
          <input type="number" min="0" step="1" value="${v}" />
        </div>`;
    })
    .join('');

  renderRmSafetyList(sim, master, '', onRefresh);

  fgList.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const id = inp.closest('.ss-row').dataset.id;
      sim.safetyStock.finishedGoods[id] = Math.max(0, Number(inp.value) || 0);
      sim.ssBatchTargets?.clear();
      syncDerivedRawSafetyStock(sim);
      rebuildDailyPlans(sim, sim.currentDate);
      renderRmSafetyList(sim, master, $('#rm-ss-search')?.value ?? '', onRefresh);
      onRefresh?.();
    });
  });
}

function renderRmSafetyList(sim, master, filter, onRefresh) {
  const list = $('#rm-safety-list');
  if (!list) return;
  const q = filter.trim().toLowerCase();
  const items = master.materials.filter(
    (m) =>
      !q ||
      String(m.id).includes(q) ||
      m.name.toLowerCase().includes(q)
  );

  list.innerHTML = items
    .map((m) => {
      const v = sim.safetyStock.rawMaterials[String(m.id)] ?? 0;
      return `
        <div class="ss-row ss-row-derived" data-type="rm" data-id="${m.id}">
          <span>${m.id}</span>
          <span class="name" title="${esc(m.name)}">${esc(trunc(m.name, 18))}</span>
          <input type="number" min="0" step="0.01" value="${v.toFixed(2)}" readonly tabindex="-1" title="由成品安全库存 × BOM 自动计算" />
        </div>`;
    })
    .join('');
}

export function bindSafetyStockToolbar(sim, master, onRefresh) {
  $('#fg-ss-zero')?.addEventListener('click', () => {
    for (const p of master.products) {
      sim.safetyStock.finishedGoods[String(p.id)] = DEFAULT_FINISHED_GOODS_SS;
    }
    sim.ssBatchTargets?.clear();
    syncDerivedRawSafetyStock(sim);
    rebuildDailyPlans(sim, sim.currentDate);
    renderSafetyStockEditors(sim, master, onRefresh);
    onRefresh?.();
  });
  $('#rm-ss-search')?.addEventListener('input', (e) => {
    renderRmSafetyList(sim, master, e.target.value, onRefresh);
  });
}

/** 渲染各 SKU 起做量 / Batch 编辑列表 */
export function renderProductionPolicyEditors(sim, master, onRefresh) {
  const list = $('#production-policy-list');
  if (!list) return;

  list.innerHTML = master.products
    .map((p) => {
      const pol = getProductProductionPolicy(sim.productionPolicy, p.id);
      return `
        <div class="ss-row production-row" data-id="${p.id}">
          <span>${p.id}</span>
          <span class="name" title="${esc(p.name)}">${esc(trunc(p.name, 14))}</span>
          <label class="prod-field" title="最少起做量">MOQ<input type="number" min="0" step="1" data-field="min" value="${pol.minProductionQty}" /></label>
          <label class="prod-field" title="Batch 整数倍">Batch<input type="number" min="1" step="1" data-field="batch" value="${pol.batchSize}" /></label>
        </div>`;
    })
    .join('');

  list.querySelectorAll('.production-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const cur = sim.productionPolicy.byProduct[id] ?? {
          minProductionQty: DEFAULT_MIN_PRODUCTION_QTY,
          batchSize: DEFAULT_BATCH_SIZE,
        };
        if (inp.dataset.field === 'min') {
          cur.minProductionQty = Math.max(0, Math.floor(Number(inp.value) || 0));
        } else {
          cur.batchSize = Math.max(1, Math.floor(Number(inp.value) || DEFAULT_BATCH_SIZE));
        }
        sim.productionPolicy.byProduct[id] = cur;
        sim.ssBatchTargets?.clear();
        rebuildDailyPlans(sim, sim.currentDate);
        onRefresh?.();
      });
    });
  });
}

export function bindProductionPolicyToolbar(sim, master, onRefresh) {
  $('#prod-policy-default')?.addEventListener('click', () => {
    for (const p of master.products) {
      sim.productionPolicy.byProduct[String(p.id)] = {
        minProductionQty: DEFAULT_MIN_PRODUCTION_QTY,
        batchSize: DEFAULT_BATCH_SIZE,
      };
    }
    sim.ssBatchTargets?.clear();
    rebuildDailyPlans(sim, sim.currentDate);
    renderProductionPolicyEditors(sim, master, onRefresh);
    onRefresh?.();
  });
}

/** 共线日产能分时段预测（Policy） */
export function bindCapacityPolicy(sim, onRefresh) {
  const tbody = $('#capacity-forecast-tbody');
  const asOfEl = $('#capacity-policy-asof');
  const info = $('#capacity-policy-info');
  if (!tbody) return;

  const asOfStr = () => formatDate(sim.currentDate);

  const renderCapacityForecastTable = () => {
    ensureCapacityForecastSchedule(sim);
    const asOf = asOfStr();
    if (asOfEl) {
      asOfEl.innerHTML = `当前仿真日 <strong>${esc(asOf)}</strong>：下表时段自该日起生效，用于未来计划；此前已揭晓产能只读。`;
    }

    const segments = listEditableCapacityForecastSegments(
      sim.capacityForecastSchedule,
      asOf,
      sim._simStartDate
    );

    tbody.innerHTML = segments
      .map(
        (seg, idx) => `
      <tr data-row="${idx}">
        <td><input type="date" class="cap-from" value="${seg.fromDate}" min="${asOf}" /></td>
        <td><input type="date" class="cap-to" value="${seg.toDate}" min="${asOf}" /></td>
        <td><input type="number" class="cap-mean" min="1" step="1" value="${seg.mean}" /></td>
        <td><input type="number" class="cap-low" min="0" step="1" value="${seg.p90Low}" /></td>
        <td><input type="number" class="cap-high" min="1" step="1" value="${seg.p90High}" /></td>
        <td><input type="number" class="cap-max" min="1" step="1" value="${seg.max}" /></td>
        <td><button type="button" class="btn btn-sm btn-icon cap-del" title="删除时段">×</button></td>
      </tr>`
      )
      .join('');

    if (info) {
      info.textContent = buildCapacityForecastScheduleHint(
        sim.capacityForecastSchedule,
        asOf,
        sim._simStartDate
      );
    }
  };

  const readSegmentsFromForm = () => {
    const asOf = asOfStr();
    return [...tbody.querySelectorAll('tr')].map((tr) =>
      normalizeCapacityForecastSegment(
        {
          fromDate: tr.querySelector('.cap-from')?.value || asOf,
          toDate: tr.querySelector('.cap-to')?.value || CAPACITY_FORECAST_FAR_END,
          mean: tr.querySelector('.cap-mean')?.value,
          p90Low: tr.querySelector('.cap-low')?.value,
          p90High: tr.querySelector('.cap-high')?.value,
          max: tr.querySelector('.cap-max')?.value,
        },
        asOf
      )
    );
  };

  const applyForecast = () => {
    const asOf = asOfStr();
    const nextSchedule = applyCapacityForecastFromDate(
      sim.capacityForecastSchedule,
      asOf,
      readSegmentsFromForm(),
      sim._simStartDate
    );
    const changedFrom = firstChangedCapacityDate(sim, nextSchedule, asOf);
    sim.capacityForecastSchedule = nextSchedule;
    sim.capacityPolicy = getCapacityPolicyForDate(
      sim.capacityForecastSchedule,
      asOf,
      sim._simStartDate
    );
    rebuildDailyPlans(
      sim,
      changedFrom ? getPlanningRebuildStartDate(sim, changedFrom) : sim.currentDate
    );
    renderCapacityForecastTable();
    onRefresh?.();
  };

  if (!tbody.dataset.bound) {
    tbody.dataset.bound = '1';
    $('#capacity-forecast-apply')?.addEventListener('click', applyForecast);
    $('#capacity-forecast-add')?.addEventListener('click', () => {
      const asOf = asOfStr();
      const rows = readSegmentsFromForm();
      const last = rows[rows.length - 1];
      const nextFrom = last?.toDate && last.toDate < CAPACITY_FORECAST_FAR_END ? addDays(parseDate(last.toDate), 1) : parseDate(asOf);
      rows.push(
        normalizeCapacityForecastSegment(
          {
            fromDate: formatDate(nextFrom),
            toDate: CAPACITY_FORECAST_FAR_END,
            ...DEFAULT_CAPACITY_POLICY,
          },
          asOf
        )
      );
      sim.capacityForecastSchedule = applyCapacityForecastFromDate(
        sim.capacityForecastSchedule,
        asOf,
        rows,
        sim._simStartDate
      );
      renderCapacityForecastTable();
    });
    tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('.cap-del');
      if (!btn) return;
      const tr = btn.closest('tr');
      if (!tr || tbody.querySelectorAll('tr').length <= 1) return;
      tr.remove();
    });
    $('#capacity-policy-default')?.addEventListener('click', () => {
      sim.capacityForecastSchedule = applyCapacityForecastFromDate(
        sim.capacityForecastSchedule,
        asOfStr(),
        createDefaultCapacityForecastSchedule(asOfStr(), DEFAULT_CAPACITY_POLICY),
        sim._simStartDate
      );
      applyForecast();
    });
  }

  renderCapacityForecastTable();

  refreshCapacityForecastUI = () => {
    if (document.activeElement?.closest('#capacity-forecast-table')) return;
    renderCapacityForecastTable();
  };
}

/** 订单丢失等待天数（Policy） */
export function bindOrderLostWaitDays(sim, onRefresh) {
  const inp = $('#order-lost-wait-days');
  if (!inp) return;
  if (!inp.dataset.bound) {
    inp.dataset.bound = '1';
    inp.addEventListener('change', () => {
      sim.orderLostWaitDays = Math.max(0, Math.min(90, Math.floor(Number(inp.value) || 0)));
      inp.value = String(getOrderLostWaitDays(sim));
      onRefresh?.();
    });
  }
  if (document.activeElement !== inp) {
    inp.value = String(getOrderLostWaitDays(sim));
  }
}

/** 供应商延期概率（0～100%） */
export function bindSupplierPolicy(sim, onRefresh) {
  const inp = $('#supplier-delay-probability');
  if (!inp) return;
  inp.value = String(Math.round((sim.supplierPolicy?.delayProbability ?? 0) * 100));
  inp.addEventListener('change', () => {
    const pct = Math.min(100, Math.max(0, Number(inp.value) || 0));
    inp.value = String(pct);
    sim.supplierPolicy.delayProbability = pct / 100;
    onRefresh?.();
  });
  inp.addEventListener('input', () => {
    const pct = Math.min(100, Math.max(0, Number(inp.value) || 0));
    sim.supplierPolicy.delayProbability = pct / 100;
  });
}

function renderFinishedInventory(master, snap) {
  const tbody = $('#finished-inventory-table tbody');
  if (!tbody) return;
  tbody.innerHTML = master.products
    .map((p) => {
      const stock = snap.finishedInventory?.[p.id] ?? 0;
      const ss = snap.safetyStock.finishedGoods[String(p.id)] ?? 0;
      const gap = stock - ss;
      const warn = stock + 1e-9 < ss;
      const ok = ss > 0 && !warn;
      const status = ss <= 0 ? '—' : warn ? '低于 SS' : ok ? '达标' : '—';
      const statusClass = warn ? 'status-warn' : ok ? 'status-ok' : '';
      return `
      <tr>
        <td>${p.id}</td>
        <td title="${esc(p.name)}">${esc(trunc(p.name, 28))}</td>
        <td class="${warn ? 'status-warn' : ''}">${stock}</td>
        <td>${ss}</td>
        <td class="${warn ? 'status-warn' : ''}">${ss > 0 ? (gap >= 0 ? `+${gap}` : gap) : '—'}</td>
        <td class="${statusClass}">${status}</td>
      </tr>`;
    })
    .join('');
}

function syncPolicyFormFromSim(sim) {
  sim.rawMaterialPolicy = { type: 'mrp' };
}

/** 绑定原料策略（固定 MRP） */
export function bindRawMaterialPolicy(sim) {
  syncPolicyFormFromSim(sim);
}

/** Dashboard 当前选中 SKU：total | productId */
let dashboardSkuSelection = 'total';

export function getDashboardSkuSelection() {
  return dashboardSkuSelection;
}

export function bindDashboardSkuSelector(master, onChange) {
  const sel = $('#dashboard-sku-select');
  if (!sel) return;

  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      dashboardSkuSelection = sel.value;
      onChange?.();
    });
  }

  const prev = dashboardSkuSelection;
  sel.innerHTML =
    `<option value="total">全部 SKU 合计</option>` +
    master.products
      .map((p) => `<option value="${p.id}">${p.id} · ${esc(trunc(p.name, 36))}</option>`)
      .join('');

  if (prev === 'total' || master.products.some((p) => String(p.id) === prev)) {
    sel.value = prev;
  } else {
    dashboardSkuSelection = 'total';
    sel.value = 'total';
  }
}

/** Dashboard：前瞻成品库存 + 待交货 + 丢失订单 */
function renderDashboard(sim, master, snap) {
  const cached = getForwardProjectionCache(sim);
  if (cached) {
    renderDashboardContent(sim, master, snap, cached);
    return;
  }

  const hint = document.querySelector('#tab-dashboard .hint');
  if (hint) {
    hint.textContent = '前瞻计算中…（计算完成后显示图表）';
  }
  const kpiEl = $('#dashboard-kpi');
  if (kpiEl) kpiEl.innerHTML = '<p class="chart-loading">计算中…</p>';
  $('#chart-dashboard-delivery')?.replaceChildren();
  $('#chart-dashboard-inventory')?.replaceChildren();
  $('#dashboard-daily-table tbody')?.replaceChildren();

  ensureForwardProjection(
    sim,
    (forecast) => {
      if (!isTabPanelActive('tab-dashboard')) return;
      const latestSnap = sim._lastSnap ?? snap;
      renderDashboardContent(sim, master, latestSnap, forecast);
    }
  );
}

function renderDashboardContent(sim, master, snap, forecast, { partial = false } = {}) {
  const asOf = forecast.asOfDate;
  const rows = forecast.rows;
  const todayRow = rows[0];
  const nextRow = rows[1];
  const skuSel = getDashboardSkuSelection();
  const isTotal = skuSel === 'total';
  const pid = isTotal ? null : Number(skuSel);
  const product = master.products.find((p) => String(p.id) === String(skuSel));
  const skuLabel = isTotal ? '全部 SKU 合计' : `${skuSel} · ${trunc(product?.name ?? '', 24)}`;

  const hint = document.querySelector('#tab-dashboard .hint');
  if (hint) {
    hint.innerHTML =
      `站在 <strong>${esc(asOf)}</strong>：下方两张趋势图与「查看 SKU」<strong>联动</strong>。竖线左侧实线为已发生，右侧虚线为预计。` +
        `当前：<strong>${esc(skuLabel)}</strong>。橙线 = 日末仍待 backlog；红线 = 累计丢失。预计段为 shadow 仿真（逐日重算计划/PO，产能取均值、不含未来需求通报与供应商随机延期）；与实际差异主要来自<strong>需求通报变更、供应商延期、当日产能揭晓</strong>。` +
        (partial ? ' <em class="chart-partial-hint">（前瞻计算进行中，虚线随进度延长）</em>' : '');
  }

  const fgSsTotal = sim.productIds.reduce(
    (s, id) => s + (sim.safetyStock.finishedGoods[String(id)] ?? 0),
    0
  );
  const fgSs = isTotal ? fgSsTotal : (sim.safetyStock.finishedGoods[String(pid)] ?? 0);
  const finishedNow = isTotal
    ? sim.productIds.reduce((s, id) => s + (sim.inventory.finished.get(id) ?? 0), 0)
    : (sim.inventory.finished.get(pid) ?? 0);
  const d = snap.deliverySummary ?? {};

  const endToday = readDashboardRowMetric(todayRow ?? {}, 'finishedAvailable', skuSel) || finishedNow;
  const pendingToday = readDashboardRowMetric(todayRow ?? {}, 'pendingDueQty', skuSel);
  const pendingTomorrow = nextRow ? readDashboardRowMetric(nextRow, 'pendingDueQty', skuSel) : null;
  const lostEnd = readDashboardRowMetric(rows[rows.length - 1] ?? {}, 'lostQtyCumulative', skuSel);
  const lostActual = isTotal
    ? (d.lostQtyCumulative ?? 0)
    : readProductMetricFromSnap(snap, pid, 'lost');

  const kpiEl = $('#dashboard-kpi');
  if (kpiEl) {
    const invClass =
      fgSs > 0 && endToday + 1e-9 < fgSs ? 'kpi-warn' : endToday >= fgSs ? 'kpi-ok' : '';

    kpiEl.innerHTML = `
      <div class="dashboard-kpi-card kpi-inventory ${invClass}">
        <span class="kpi-label">${isTotal ? '今日末预计可用库存' : '今日末预计库存'}</span>
        <span class="kpi-value">${endToday}</span>
        <span class="kpi-sub">${esc(skuLabel)} · 当前 ${finishedNow}${fgSs > 0 ? ` · SS ${fgSs}` : ''}</span>
      </div>
      <div class="dashboard-kpi-card kpi-pending ${pendingToday > 0 ? 'kpi-warn' : ''}">
        <span class="kpi-label">今日末仍待 backlog</span>
        <span class="kpi-value">${pendingToday}</span>
        <span class="kpi-sub">出库前需交 ${readDashboardRowMetric(todayRow ?? {}, 'dueOrderQty', skuSel)} · 明日末 ${pendingTomorrow ?? '—'}</span>
      </div>
      <div class="dashboard-kpi-card kpi-lost ${lostEnd > 0 ? 'kpi-danger' : ''}">
        <span class="kpi-label">预计累计丢失（${rows.length} 天末）</span>
        <span class="kpi-value">${lostEnd}</span>
        <span class="kpi-sub">当前实际累计 ${lostActual} · 今日预计丢失 ${readDashboardRowMetric(todayRow ?? {}, 'lostQtyToday', skuSel) || (todayRow?.lostQtyToday && isTotal ? todayRow.lostQtyToday : 0)}</span>
      </div>
    `;
  }

  const hist = sim.inventoryHistory ?? [];
  const chartCommon = {
    scrollable: true,
    todayMarker: asOf,
  };

  const inventorySeries = isTotal
    ? [
        buildDashboardMetricSeries(hist, rows, 'finishedAvailable', asOf, '可用成品库存', '#3b82f6'),
      ]
    : [
        buildDashboardProductMetricSeries(
          hist,
          rows,
          pid,
          'finishedAvailable',
          asOf,
          trunc(product?.name ?? String(pid), 16),
          '#3b82f6'
        ),
      ];

  const deliverySeries = isTotal
    ? [
        buildDashboardMetricSeries(hist, rows, 'pendingDueQty', asOf, '日末待交 backlog', '#f59e0b'),
        buildDashboardMetricSeries(hist, rows, 'lostQtyCumulative', asOf, '累计丢失', '#ef4444'),
      ]
    : [
        buildDashboardProductMetricSeries(
          hist,
          rows,
          pid,
          'pendingDueQty',
          asOf,
          '日末待交 backlog',
          '#f59e0b'
        ),
        buildDashboardProductMetricSeries(
          hist,
          rows,
          pid,
          'lostQtyCumulative',
          asOf,
          '累计丢失',
          '#ef4444'
        ),
      ];

  renderTrendChart($('#chart-dashboard-delivery'), {
    ...chartCommon,
    title: `交货 backlog / 丢失 · ${skuLabel}`,
    series: deliverySeries,
    referenceLines: [],
  });

  renderTrendChart($('#chart-dashboard-inventory'), {
    ...chartCommon,
    title: `成品库存 · ${skuLabel}`,
    series: inventorySeries,
    referenceLines:
      fgSs > 0 ? [{ value: fgSs, label: `SS ${fgSs}`, color: '#94a3b8' }] : [],
  });

  const tbody = $('#dashboard-daily-table tbody');
  if (tbody) {
    tbody.innerHTML = '';
    for (const r of rows) {
      const inv = readDashboardRowMetric(r, 'finishedAvailable', skuSel);
      const due = readDashboardRowMetric(r, 'dueOrderQty', skuSel);
      const pending = readDashboardRowMetric(r, 'pendingDueQty', skuSel);
      const lostCum = readDashboardRowMetric(r, 'lostQtyCumulative', skuSel);
      const belowSs = fgSs > 0 && inv + 1e-9 < fgSs;
      const lostToday = (r.lostQtyToday ?? 0) > 0 && isTotal;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.date}${r.isToday ? ' <span class="badge badge-idle">今日</span>' : ''}</td>
        <td class="${belowSs ? 'status-warn' : ''}">${inv}</td>
        <td>${due}</td>
        <td>${isTotal ? (r.produced ?? 0) : '—'}</td>
        <td class="${pending > 0 ? 'status-warn' : ''}">${pending}</td>
        <td>${isTotal ? (r.pendingDueCount ?? 0) : '—'}</td>
        <td class="${lostToday ? 'status-danger' : ''}">${isTotal ? (r.lostQtyToday ?? 0) : '—'}</td>
        <td>${lostCum}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  const orderBody = $('#dashboard-order-table tbody');
  if (orderBody) {
    orderBody.innerHTML = '';
    const productMap = new Map(master.products.map((p) => [p.id, p]));
    let orders = (snap.openDeliveryOrders ?? [])
      .filter((o) => o.status === 'pending' || o.status === 'lost')
      .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.pid - b.pid);

    if (!isTotal) {
      orders = orders.filter((o) => o.pid === pid);
    }

    if (!orders.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="5" class="hint">${isTotal ? '暂无待交或已丢失订单' : '该 SKU 暂无待交或已丢失订单'}</td>`;
      orderBody.appendChild(tr);
    } else {
      for (const o of orders.slice(-80)) {
        const p = productMap.get(o.pid);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${o.deliveryDate}</td>
          <td>${o.pid}</td>
          <td title="${esc(p?.name ?? '')}">${esc(trunc(p?.name ?? '—', 28))}</td>
          <td>${o.qty}</td>
          <td class="${o.status === 'lost' ? 'status-danger' : 'status-warn'}">${ORDER_DELIVERY_STATUS_LABEL[o.status] ?? o.status}</td>
        `;
        orderBody.appendChild(tr);
      }
    }
  }
}

function readProductMetricFromSnap(snap, pid, kind) {
  if (kind === 'lost') {
    const orders = snap.openDeliveryOrders ?? [];
    return orders.filter((o) => o.pid === pid && o.status === 'lost').reduce((s, o) => s + o.qty, 0);
  }
  return 0;
}

function renderPolicyView(sim) {
  syncPolicyFormFromSim(sim);

  const lostInp = $('#order-lost-wait-days');
  if (lostInp && document.activeElement !== lostInp) {
    lostInp.value = String(getOrderLostWaitDays(sim));
  }

  const capInfo = $('#capacity-policy-info');
  if (capInfo && document.activeElement?.closest('#capacity-forecast-table') == null) {
    ensureCapacityForecastSchedule(sim);
    capInfo.textContent = buildCapacityForecastScheduleHint(
      sim.capacityForecastSchedule,
      formatDate(sim.currentDate),
      sim._simStartDate
    );
  }
  refreshCapacityForecastUI?.();

  const probPct = Math.round((sim.supplierPolicy?.delayProbability ?? 0) * 100);
  const probInp = $('#supplier-delay-probability');
  if (probInp && document.activeElement !== probInp) {
    probInp.value = String(probPct);
  }
  const supplierInfo = $('#supplier-policy-info');
  if (supplierInfo) {
    supplierInfo.innerHTML = `
      <p class="hint">当前延期概率 <strong>${probPct}%</strong>：每张<strong>新建</strong> PO 独立抽样；触发时额外延期天数 ~ 正态(均值 ${SUPPLIER_DELAY_MEAN_RATIO * 100}%×采购周期)，<strong>四舍五入取整</strong>。已在途 PO 不因改概率而重算。</p>`;
  }
}

/** 打开人工决策弹窗 */
export function showDecisionModal(sim, master, onConfirm) {
  const pending = sim.pendingDecision;
  if (!pending) return;

  const modal = $('#decision-modal');
  const body = $('#decision-body');
  body.innerHTML = '';

  const candidates = new Set([
    ...sim.productIds.filter((id) => (pending.plan.get(id) ?? 0) > 0),
    ...pending.alternatives,
  ]);

  for (const pid of candidates) {
    const p = master.products.find((x) => x.id === pid);
    const st = pending.kitStatus.get(pid);
    if (!st || st.maxQty <= 0) continue;

    const { batchSize, minProductionQty } = getProductProductionPolicy(sim.productionPolicy, pid);
    const planned = pending.plan.get(pid) ?? 0;
    let defaultQty = st.kitReady && planned > 0 ? planned : Math.min(planned || st.maxQty, st.maxQty);
    defaultQty = snapProductionInput(defaultQty, st.maxQty, batchSize);

    const row = document.createElement('div');
    row.className = 'decision-row';
    row.innerHTML = `
      <span>${pid}</span>
      <span title="${esc(p?.name ?? '')}">${esc(trunc(p?.name ?? '', 22))}</span>
      <span>计划 ${planned} / 可执行 ${st.maxQty} · MOQ ${minProductionQty} · Batch ${batchSize}</span>
      <input type="number" min="0" max="${st.maxQty}" step="${batchSize}" value="${defaultQty}" data-pid="${pid}" data-batch="${batchSize}" />
    `;
    const inp = row.querySelector('input');
    inp.addEventListener('change', () => {
      inp.value = String(snapProductionInput(inp.value, st.maxQty, batchSize));
    });
    body.appendChild(row);
  }

  const form = $('#decision-form');
  form.onsubmit = (e) => {
    e.preventDefault();
    const actual = new Map(sim.productIds.map((id) => [id, 0]));
    body.querySelectorAll('input[data-pid]').forEach((inp) => {
      const pid = Number(inp.dataset.pid);
      const batch = Number(inp.dataset.batch) || 1;
      const max = Number(inp.max) || 0;
      actual.set(pid, snapProductionInput(inp.value, max, batch));
    });
    modal.close();
    onConfirm(actual);
  };

  $('#decision-skip').onclick = () => {
    modal.close();
    onConfirm(new Map(sim.productIds.map((id) => [id, 0])));
  };

  modal.showModal();
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function trunc(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 缓存 snapshot 供 render 使用 */
export function cacheSnapshot(sim, snap) {
  sim._lastSnap = snap;
}
