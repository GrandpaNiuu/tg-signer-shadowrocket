const DASHBOARD_HASH = "#/dashboard";
const DASHBOARD_TITLE = "消息自动化控制台";

function syncDashboardTitle() {
  if (!location.hash.startsWith(DASHBOARD_HASH)) return;
  const title = document.querySelector("#view .page-head h1");
  if (title && title.textContent !== DASHBOARD_TITLE) {
    title.textContent = DASHBOARD_TITLE;
  }
}

function scheduleDashboardTitleSync() {
  queueMicrotask(syncDashboardTitle);
  requestAnimationFrame(syncDashboardTitle);
}

window.addEventListener("hashchange", scheduleDashboardTitleSync);
window.addEventListener("pageshow", scheduleDashboardTitleSync);

const view = document.querySelector("#view");
if (view) {
  new MutationObserver(scheduleDashboardTitleSync).observe(view, {
    childList: true,
    subtree: true,
  });
}

scheduleDashboardTitleSync();
