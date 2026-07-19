const ACTIVE_RUN_STATUSES = new Set(["queued", "claimed", "running"]);

export function refreshDelayForRoute(route, runs = [], { blocked = false } = {}) {
  if (blocked) return 0;
  if (route === "accounts") return 60_000;
  if (route === "runs") {
    return runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ? 3_000 : 30_000;
  }
  return 0;
}
