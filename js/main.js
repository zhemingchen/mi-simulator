/**
 * 排产沙盘入口
 */

import {
  loadMasterData,
  buildMasterDataBundle,
  loadMasterDataFromCsvFiles,
  CSV_DATASET_SPECS,
} from './data-loader.js';
import { formatDate } from './scheduler.js';
import {
  createSimulation,
  resetSimulation,
  stepSimulation,
  stepBackSimulation,
  jumpSimulationTo,
  applyManualDecision,
  getSnapshot,
  SimState,
} from './simulation.js';
import {
  initTabs,
  renderAll,
  renderSafetyStockEditors,
  renderProductionPolicyEditors,
  bindSafetyStockToolbar,
  bindProductionPolicyToolbar,
  bindSupplierPolicy,
  bindDashboardSkuSelector,
  bindProductionPlanSkuSelector,
  bindRawMaterialChartSelector,
  bindInTransitChartSelector,
  bindOrderLostWaitDays,
  bindCapacityPolicy,
  bindRawMaterialPolicy,
  showDecisionModal,
  cacheSnapshot,
  invalidateDashboardProjection,
} from './ui.js';

let sim = null;
let master = null;
let appBooted = false;
let bulkCsvFiles = [];

function setUploadStatus(message, tone = '') {
  const node = document.getElementById('upload-status');
  if (!node) return;
  node.textContent = message;
  node.classList.remove('is-error', 'is-success');
  if (tone) node.classList.add(tone);
}

function showAppShell() {
  document.getElementById('upload-shell')?.classList.add('ui-hidden');
  document.getElementById('app-header')?.classList.remove('ui-hidden');
  document.getElementById('app-main')?.classList.remove('ui-hidden');
}

function buildCsvFileMap(files) {
  const byFileName = new Map(CSV_DATASET_SPECS.map((spec) => [spec.fileName.toLowerCase(), spec]));
  const fileMap = {};
  for (const file of Array.from(files ?? [])) {
    const spec = byFileName.get(String(file.name ?? '').toLowerCase());
    if (spec) fileMap[spec.key] = file;
  }
  return fileMap;
}

function describeCsvSelection(files) {
  const fileMap = buildCsvFileMap(files);
  const matched = CSV_DATASET_SPECS.filter((spec) => fileMap[spec.key]).length;
  const missing = CSV_DATASET_SPECS.filter((spec) => !fileMap[spec.key]).map((spec) => spec.fileName);
  if (!matched) {
    setUploadStatus('未匹配到所需 CSV。请检查文件名。', 'is-error');
    return;
  }
  if (missing.length) {
    setUploadStatus(`已匹配 ${matched}/7，仍缺少：${missing.join('、')}`);
    return;
  }
  setUploadStatus('已匹配 7/7 个 CSV，可以启动。', 'is-success');
}

function collectCsvFiles() {
  const fileMap = buildCsvFileMap(bulkCsvFiles);
  const bulkInput = document.getElementById('csv-bulk-files');
  Object.assign(fileMap, buildCsvFileMap(bulkInput?.files));
  for (const spec of CSV_DATASET_SPECS) {
    const input = document.getElementById(`csv-${camelToKebab(spec.key)}`);
    const file = input?.files?.[0];
    if (file) fileMap[spec.key] = file;
  }
  const missing = CSV_DATASET_SPECS.filter((spec) => !fileMap[spec.key]).map((spec) => spec.fileName);
  if (missing.length) throw new Error(`缺少文件：${missing.join('、')}`);
  return fileMap;
}

function camelToKebab(text) {
  return String(text).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function initApp(data) {
  const bundle = buildMasterDataBundle(data);
  master = bundle.master;
  sim = createSimulation({
    ...master,
    safetyStock: bundle.safetyStock,
  });

  if (!appBooted) {
    initTabs(() => refreshUI());
    bindDashboardSkuSelector(master, () => refreshUI());
    bindProductionPlanSkuSelector(master, () => refreshUI());
    bindRawMaterialChartSelector(master, () => refreshUI());
    bindInTransitChartSelector(master, () => refreshUI());
    bindControls();
    appBooted = true;
  }

  bindRawMaterialPolicy(sim);
  bindSupplierPolicy(sim, () => refreshUI());
  bindOrderLostWaitDays(sim, () => refreshUI());
  bindCapacityPolicy(sim, () => refreshUI());

  const start = document.getElementById('start-date').value;
  resetSimulation(sim, start);
  renderSafetyStockEditors(sim, master, () => refreshUI());
  renderProductionPolicyEditors(sim, master, () => refreshUI());
  bindSafetyStockToolbar(sim, master, () => refreshUI());
  bindProductionPolicyToolbar(sim, master, () => refreshUI());
  showAppShell();
  refreshUI();
}

async function bootFromBundledData() {
  const data = await loadMasterData('./data');
  initApp(data);
}

async function bootFromCsvUpload() {
  const data = await loadMasterDataFromCsvFiles(collectCsvFiles());
  initApp(data);
}

async function syncBundledSampleButton() {
  const sampleButton = document.getElementById('btn-upload-sample');
  if (!sampleButton) return;
  try {
    const res = await fetch('./data/products.json', { method: 'GET' });
    if (!res.ok) sampleButton.classList.add('ui-hidden');
  } catch {
    sampleButton.classList.add('ui-hidden');
  }
}

function bindUploadScreen() {
  const bulkInput = document.getElementById('csv-bulk-files');
  bulkInput?.addEventListener('change', () => {
    bulkCsvFiles = Array.from(bulkInput.files ?? []);
    describeCsvSelection(bulkCsvFiles);
  });

  const dropZone = document.getElementById('csv-drop-zone');
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('is-dragover');
  });
  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('is-dragover');
  });
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    bulkCsvFiles = Array.from(e.dataTransfer?.files ?? []);
    describeCsvSelection(bulkCsvFiles);
  });

  document.getElementById('btn-upload-start')?.addEventListener('click', async () => {
    try {
      setUploadStatus('正在读取 CSV…');
      await bootFromCsvUpload();
      setUploadStatus('CSV 已加载，仿真已启动。刷新页面后数据会清空。', 'is-success');
    } catch (err) {
      console.error(err);
      setUploadStatus(err?.message ?? String(err), 'is-error');
    }
  });

  const sampleButton = document.getElementById('btn-upload-sample');
  sampleButton?.addEventListener('click', async () => {
    try {
      setUploadStatus('正在加载内置样例数据…');
      await bootFromBundledData();
      setUploadStatus('已加载内置样例数据。', 'is-success');
    } catch (err) {
      console.error(err);
      sampleButton.classList.add('ui-hidden');
      setUploadStatus('当前环境未提供内置样例数据，请改用 CSV 上传。', 'is-error');
    }
  });

  syncBundledSampleButton();
}

function showBootError(err) {
  const msg = err?.message ?? String(err);
  const isFile = window.location.protocol === 'file:';
  const hint = isFile
    ? '请勿直接双击 index.html。在终端进入 simulator 目录后运行：python3 -m http.server 8765\n然后浏览器打开 http://localhost:8765'
    : '请关闭标签页后重新打开；若仍失败，在地址栏按回车刷新即可。';
  alert(`加载失败：${msg}\n\n${hint}`);
  const banner = document.createElement('div');
  banner.className = 'boot-error-banner';
  banner.textContent = isFile
    ? `仿真加载失败：浏览器禁止 file:// 读取 JSON 数据。请用本地 HTTP 服务打开（见 alert 说明）。`
    : `仿真加载失败：${msg}。${hint}`;
  document.body.prepend(banner);
}

function bindControls() {
  const btnRun = document.getElementById('btn-run');
  const btnPause = document.getElementById('btn-pause');
  const btnStep = document.getElementById('btn-step');
  const btnStepBack = document.getElementById('btn-step-back');
  const btnReset = document.getElementById('btn-reset');
  const btnJump = document.getElementById('btn-jump');
  const jumpDate = document.getElementById('jump-date');
  const speed = document.getElementById('sim-speed');
  const speedVal = document.getElementById('sim-speed-val');

  speed?.addEventListener('input', () => {
    speedVal.textContent = speed.value;
    if (sim.runState === SimState.RUNNING) startAutoRun();
  });

  btnReset.addEventListener('click', () => {
    stopAutoRun();
    invalidateDashboardProjection(sim);
    resetSimulation(sim, document.getElementById('start-date').value);
    refreshUI();
  });

  btnStep.addEventListener('click', () => {
    stopAutoRun();
    advanceOneStep();
  });

  btnJump.addEventListener('click', () => {
    stopAutoRun();
    jumpToDate(jumpDate.value);
  });

  btnStepBack.addEventListener('click', () => {
    stopAutoRun();
    const modal = document.getElementById('decision-modal');
    if (modal.open) modal.close();
    const result = stepBackSimulation(sim);
    if (!result.ok && result.reason === 'at-start') return;
    invalidateDashboardProjection(sim);
    renderSafetyStockEditors(sim, master);
    renderProductionPolicyEditors(sim, master);
    refreshUI();
  });

  btnRun.addEventListener('click', () => {
    if (sim.runState === SimState.WAITING_USER) return;
    sim.runState = SimState.RUNNING;
    startAutoRun();
    refreshUI();
  });

  btnPause.addEventListener('click', () => {
    stopAutoRun();
    sim.runState = SimState.PAUSED;
    refreshUI();
  });
}

function syncControlButtons() {
  const running = sim?.runState === SimState.RUNNING;
  const waiting = sim?.runState === SimState.WAITING_USER;
  const btnRun = document.getElementById('btn-run');
  const btnPause = document.getElementById('btn-pause');
  if (btnRun) btnRun.disabled = running || waiting;
  if (btnPause) btnPause.disabled = !running;
}

function startAutoRun() {
  if (sim?.timer) {
    clearInterval(sim.timer);
    sim.timer = null;
  }
  const ms = Number(document.getElementById('sim-speed').value);
  sim.timer = setInterval(() => {
    if (!advanceOneStep()) stopAutoRun();
  }, ms);
  syncControlButtons();
}

function stopAutoRun() {
  if (sim?.timer) {
    clearInterval(sim.timer);
    sim.timer = null;
  }
  if (sim && sim.runState === SimState.RUNNING) {
    sim.runState = SimState.PAUSED;
  }
  syncControlButtons();
}

function jumpToDate(targetDateStr) {
  if (!targetDateStr) return;
  const current = formatDate(sim.currentDate);
  if (targetDateStr <= current) {
    alert(`目标日期须晚于当前仿真日期（${current}）`);
    return;
  }

  const result = jumpSimulationTo(sim, targetDateStr);
  invalidateDashboardProjection(sim);
  refreshUI();

  if (result.reason === 'manual') {
    showDecisionModal(sim, master, (actual) => {
      applyManualDecision(sim, actual);
      refreshUI();
      if (formatDate(sim.currentDate) < targetDateStr) jumpToDate(targetDateStr);
    });
    return;
  }

  if (!result.ok && result.reason !== 'already') {
    alert(`跳转未完成：${result.reason ?? '未知原因'}（已步进 ${result.steps} 天，当前 ${result.date}）`);
  }
}

/** @returns {boolean} 是否应继续自动运行 */
function advanceOneStep() {
  invalidateDashboardProjection(sim);
  const result = stepSimulation(sim);

  if (result.reason === 'manual') {
    stopAutoRun();
    refreshUI();
    showDecisionModal(sim, master, (actual) => {
      applyManualDecision(sim, actual);
      refreshUI();
    });
    return false;
  }

  refreshUI();
  return result.advanced;
}

function refreshUI() {
  const snap = getSnapshot(sim);
  cacheSnapshot(sim, snap);
  renderAll(sim, master);
  syncControlButtons();
  const btnBack = document.getElementById('btn-step-back');
  if (btnBack) btnBack.disabled = !snap.canStepBack;
}

bindUploadScreen();
