const ACTIVE_RUN_STATUSES = new Set(["queued", "claimed", "running"]);

export function refreshDelayForRoute(route, runs = [], { blocked = false } = {}) {
  if (blocked) return 0;
  if (route === "accounts") return 60_000;
  // Scheduled executions are created by the Worker while the browser can sit on
  // the dashboard for hours. Keep both run surfaces polling even when no run was
  // active during the previous response, otherwise only manual actions (which
  // trigger an explicit route refresh) become visible without a page reload.
  if (route === "dashboard") return 20_000;
  if (route === "runs") {
    return runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ? 3_000 : 20_000;
  }
  return 0;
}
