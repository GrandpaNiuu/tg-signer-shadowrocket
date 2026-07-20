const STATUS_TEXT = {
  connected: "已连接",
  disconnected: "未连接",
  login_pending: "登录中",
  reconnect_required: "需要重新登录",
  // Compatibility for early builds that exposed the pre-audit name.
  needs_reauth: "需要重新登录",
  pending: "待连接",
  error: "异常",
  deleted: "已删除",
  queued: "排队中",
  dispatched: "已派发",
  running: "执行中",
  succeeded: "成功",
  success: "成功",
  failed: "失败",
  timed_out: "超时",
  cancelled: "已取消",
  claimed: "Runner 已领取",
  ambiguous: "结果不确定",
  expired: "已过期",
  created: "正在创建",
  starting: "正在发送验证码",
  code_required: "等待验证码",
  code_submitted: "正在验证",
  password_required: "等待二步验证",
  password_submitted: "正在验证二步密码",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

export function statusText(status) { return STATUS_TEXT[status] || status || "未知"; }

export function statusBadge(status) {
  const safe = escapeHtml(status || "unknown");
  return `<span class="badge ${safe}">${escapeHtml(statusText(status))}</span>`;
}

export function formatDate(value, { dateOnly = false } = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", dateOnly
    ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
  ).format(date);
}

export function formatDuration(value) {
  if (value === null || value === undefined || value === "") return "—";
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.round((milliseconds % 60000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function shortId(id) {
  if (!id) return "—";
  const text = String(id);
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

export function textOrDash(value) { return value === null || value === undefined || value === "" ? "—" : escapeHtml(value); }

export function initials(email) {
  const value = String(email || "A").trim();
  return (value[0] || "A").toLocaleUpperCase("zh-CN");
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}
