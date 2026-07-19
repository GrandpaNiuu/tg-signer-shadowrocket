const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "ambiguous", "cancelled"]);

export function rerunnableTaskId(run) {
  if (!run?.current_task_id || !TERMINAL_RUN_STATUSES.has(run.status)) return null;
  return String(run.current_task_id);
}
