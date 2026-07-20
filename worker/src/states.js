export const ACCOUNT_STATUSES = Object.freeze({
  DISCONNECTED: "disconnected",
  LOGIN_PENDING: "login_pending",
  CONNECTED: "connected",
  RECONNECT_REQUIRED: "reconnect_required",
  ERROR: "error",
});

export const RUN_STATUSES = Object.freeze({
  QUEUED: "queued",
  CLAIMED: "claimed",
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed",
  CANCELLED: "cancelled",
  AMBIGUOUS: "ambiguous",
});

export const ACTIVE_RUN_STATUSES = Object.freeze([
  RUN_STATUSES.QUEUED,
  RUN_STATUSES.CLAIMED,
  RUN_STATUSES.RUNNING,
]);

export const TERMINAL_RUN_STATUSES = Object.freeze([
  RUN_STATUSES.SUCCESS,
  RUN_STATUSES.FAILED,
  RUN_STATUSES.CANCELLED,
  RUN_STATUSES.AMBIGUOUS,
]);

export const DISPATCH_STATUSES = Object.freeze({
  PENDING: "pending",
  DISPATCHING: "dispatching",
  DISPATCHED: "dispatched",
});

export function isAccountStatus(value) {
  return Object.values(ACCOUNT_STATUSES).includes(value);
}

export function isRunStatus(value) {
  return Object.values(RUN_STATUSES).includes(value);
}

export function isTerminalRunStatus(value) {
  return TERMINAL_RUN_STATUSES.includes(value);
}

export function isDispatchStatus(value) {
  return Object.values(DISPATCH_STATUSES).includes(value);
}
