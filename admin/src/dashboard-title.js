const DASHBOARD_HASH = "#/dashboard";
const DASHBOARD_TITLE = "消息自动化控制台";
const RUNS_PAGE_SIZE = 100;
const MAX_RUN_PAGES = 20;

function isDashboard() {
  return location.hash.startsWith(DASHBOARD_HASH);
}

function syncDashboardTitle() {
  if (!isDashboard()) return;
  const title = document.querySelector("#view .page-head h1");
  if (title && title.textContent !== DASHBOARD_TITLE) {
    title.textContent = DASHBOARD_TITLE;
  }
}

async function requestJson(path) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
  return payload;
}

function dateKey(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function executionTime(run) {
  return run?.started_at || run?.scheduled_for || run?.finished_at || run?.created_at || null;
}

async function loadAllRuns() {
  const runs = [];
  let cursor = "0";
  for (let page = 0; page < MAX_RUN_PAGES && cursor !== null; page += 1) {
    const payload = await requestJson(`/api/v1/task-runs?limit=${RUNS_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    runs.push(...items);
    cursor = payload?.pagination?.next_cursor ?? null;
  }
  return runs;
}

function unifiedCounts(runs, timezone, now = new Date()) {
  const today = dateKey(now, timezone);
  const matching = runs.filter((run) => dateKey(executionTime(run), timezone) === today);
  return {
    total: matching.length,
    success: matching.filter((run) => run.status === "success").length,
    failed: matching.filter((run) => ["failed", "ambiguous"].includes(run.status)).length,
    running: matching.filter((run) => ["queued", "claimed", "running"].includes(run.status)).length,
    manual: matching.filter((run) => run.trigger_type === "manual").length,
    automatic: matching.filter((run) => run.trigger_type !== "manual").length,
  };
}

function setCard(card, value, meta) {
  const valueElement = card?.querySelector(".stat-value");
  const metaElement = card?.querySelector(".stat-meta");
  if (valueElement) valueElement.textContent = String(value);
  if (metaElement && meta) metaElement.textContent = meta;
}

function applyUnifiedCounts(grid, counts) {
  const cards = [...grid.querySelectorAll(".stat-card")];
  if (cards.length < 4) return;
  setCard(cards[0], counts.total, `手动 ${counts.manual} · 自动 ${counts.automatic}`);
  setCard(cards[1], counts.success, "手动与自动任务统一统计");
  setCard(cards[2], counts.failed, "包含失败与结果不确定");
  setCard(cards[3], counts.running, "排队、领取和执行中的任务");
}

async function syncUnifiedTodayStats(grid) {
  try {
    const [settingsPayload, runs] = await Promise.all([
      requestJson("/api/v1/settings"),
      loadAllRuns(),
    ]);
    if (!grid.isConnected || !isDashboard()) return;
    const settings = settingsPayload?.data || settingsPayload || {};
    const timezone = settings.default_timezone || "Asia/Shanghai";
    applyUnifiedCounts(grid, unifiedCounts(runs, timezone));
    grid.dataset.unifiedTodayStats = "ready";
  } catch {
    if (grid.isConnected) grid.dataset.unifiedTodayStats = "failed";
  }
}

function syncDashboard() {
  if (!isDashboard()) return;
  syncDashboardTitle();
  const grid = document.querySelector("#view .stats-grid");
  if (!grid || grid.dataset.unifiedTodayStats) return;
  grid.dataset.unifiedTodayStats = "loading";
  syncUnifiedTodayStats(grid);
}

function scheduleDashboardSync() {
  queueMicrotask(syncDashboard);
  requestAnimationFrame(syncDashboard);
  setTimeout(syncDashboard, 120);
}

window.addEventListener("hashchange", scheduleDashboardSync);
window.addEventListener("pageshow", scheduleDashboardSync);

const view = document.querySelector("#view");
if (view) {
  new MutationObserver(scheduleDashboardSync).observe(view, {
    childList: true,
    subtree: true,
  });
}

scheduleDashboardSync();
