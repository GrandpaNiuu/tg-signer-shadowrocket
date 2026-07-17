export const LOGIN_STATUSES = Object.freeze({
  CREATED: "created",
  STARTING: "starting",
  CODE_REQUIRED: "code_required",
  CODE_SUBMITTED: "code_submitted",
  PASSWORD_REQUIRED: "password_required",
  PASSWORD_SUBMITTED: "password_submitted",
  CONNECTED: "connected",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
});

export const ACTIVE_LOGIN_STATUSES = Object.freeze([
  LOGIN_STATUSES.CREATED,
  LOGIN_STATUSES.STARTING,
  LOGIN_STATUSES.CODE_REQUIRED,
  LOGIN_STATUSES.CODE_SUBMITTED,
  LOGIN_STATUSES.PASSWORD_REQUIRED,
  LOGIN_STATUSES.PASSWORD_SUBMITTED,
]);

export const TERMINAL_LOGIN_STATUSES = Object.freeze([
  LOGIN_STATUSES.CONNECTED,
  LOGIN_STATUSES.FAILED,
  LOGIN_STATUSES.CANCELLED,
  LOGIN_STATUSES.EXPIRED,
]);

export function isTerminalLoginStatus(status) {
  return TERMINAL_LOGIN_STATUSES.includes(status);
}
