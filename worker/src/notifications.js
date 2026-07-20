import { decryptSecret, rootKeyForVersion } from "./crypto.js";
import { sanitizeLogText } from "./redaction.js";

async function notificationSecret(repository, env, purpose) {
  const secret = await repository.getSecretByOwnerPurpose("setting", "telegram_notification", purpose);
  const rootKey = secret && rootKeyForVersion(env, secret.key_version);
  if (!secret || !rootKey) return null;
  return decryptSecret(rootKey, secret, { purpose, ownerId: "telegram_notification" });
}

async function notificationCredentials(repository, env) {
  const [token, chatId] = await Promise.all([
    notificationSecret(repository, env, "bot_token"),
    notificationSecret(repository, env, "chat_id"),
  ]);
  return { token, chatId };
}

async function telegramBotRequest(fetchImpl, token, method, body) {
  return fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function githubActionsUrl(env, run) {
  const owner = String(env.GITHUB_OWNER || "").trim();
  const repo = String(env.GITHUB_REPO || "").trim();
  const runId = String(run.github_run_id || "").trim();
  if (!owner || !repo || !/^\d+$/.test(runId)) return null;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`;
}

function redactKnownSecrets(value, secrets) {
  let text = String(value ?? "");
  for (const secret of secrets.filter((value) => value && value.length >= 6).sort((left, right) => right.length - left.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

function usefulLogMessage(entry) {
  const raw = String(entry?.message || "").trim();
  if (!raw || /TgCrypto is missing/i.test(raw)) return null;
  try {
    const parsed = JSON.parse(raw);
    if (["task_started", "attempt_succeeded"].includes(parsed?.event)) return null;
    if (parsed?.error?.message) return String(parsed.error.message);
    if (parsed?.message) return String(parsed.message);
  } catch {
    // Plain text log entry.
  }
  return raw;
}

function sanitizedLogTail(logs, secrets, limit = 2) {
  const entries = Array.isArray(logs)
    ? logs.map((entry) => ({ ...entry, message: usefulLogMessage(entry) })).filter((entry) => entry.message).slice(-limit)
    : [];
  if (!entries.length) return null;
  const text = entries.map((entry) => sanitizeLogText(
    redactKnownSecrets(String(entry.message).replace(/\r?\n/g, " ↩ "), secrets),
    { maxLines: 1, maxLength: 180 },
  )).filter(Boolean).join("\n");
  return sanitizeLogText(redactKnownSecrets(text, secrets), { maxLines: limit, maxLength: 420 });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function durationLabel(value) {
  const milliseconds = Number(value || 0);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} 毫秒`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function statusPresentation(status) {
  return ({
    success: { icon: "✅", title: "任务执行成功" },
    failed: { icon: "❌", title: "任务执行失败" },
    ambiguous: { icon: "⚠️", title: "任务结果待确认" },
    cancelled: { icon: "⏹", title: "任务已取消" },
  })[status] || { icon: "ℹ️", title: "任务状态已更新" };
}

function userLabel(user, run) {
  return user?.display_name || user?.email || user?.github_login || run.user_id || "未知用户";
}

function compactAuditText(value, secrets, maxLength = 160) {
  const text = sanitizeLogText(redactKnownSecrets(value, secrets), {
    maxLines: 1,
    maxLength,
  }).replace(/\s+/g, " ").trim();
  return text || "未记录";
}

function taskMessageAudit(value, secrets, { headLength = 360, tailLength = 160 } = {}) {
  const sanitized = sanitizeLogText(redactKnownSecrets(value, secrets), {
    maxLines: 20,
    maxLength: 4_000,
  }).replace(/\s*\n\s*/g, " ↩ ").replace(/[\t ]+/g, " ").trim();
  if (!sanitized) return { text: "未记录", length: 0, truncated: false };

  const characters = [...sanitized];
  if (characters.length <= headLength + tailLength) {
    return { text: sanitized, length: characters.length, truncated: false };
  }
  const omitted = characters.length - headLength - tailLength;
  return {
    text: `${characters.slice(0, headLength).join("")} … [省略 ${omitted} 字] … ${characters.slice(-tailLength).join("")}`,
    length: characters.length,
    truncated: true,
  };
}

export async function sendRunNotification(env, repository, fetchImpl, runId) {
  const settings = await repository.getSettings();
  if (settings.notifications_enabled !== true) return { sent: false, reason: "disabled" };
  const [token, chatId, run] = await Promise.all([
    notificationSecret(repository, env, "bot_token"),
    notificationSecret(repository, env, "chat_id"),
    repository.getRun(runId),
  ]);
  if (!token || !chatId || !run) return { sent: false, reason: "not_configured" };

  const user = run.user_id && typeof repository.getUser === "function"
    ? await repository.getUser(run.user_id)
    : null;
  const knownSecrets = [token, chatId];
  const presentation = statusPresentation(run.status);
  const actionsUrl = githubActionsUrl(env, run);
  const taskName = compactAuditText(run.task_name || run.task_id || "已删除任务", knownSecrets, 160);
  const executionId = compactAuditText(run.id || runId, knownSecrets, 128);
  const target = compactAuditText(run.bot, knownSecrets, 180);
  const taskMessage = taskMessageAudit(run.command, knownSecrets);
  const accountName = redactKnownSecrets(run.account_name || "未记录", knownSecrets);
  const errorMessage = run.error_message ? redactKnownSecrets(run.error_message, knownSecrets) : null;
  const logTail = run.status === "success" ? null : sanitizedLogTail(run.logs, knownSecrets);
  const attempts = Number(run.attempt_count || 0);
  const trigger = run.trigger_type === "manual" ? "手动执行" : "定时执行";
  const isSuccess = run.status === "success";

  const lines = [
    `${presentation.icon} <b>${presentation.title}</b>`,
    "",
    `<b>任务：</b>${escapeHtml(taskName)}`,
    `<b>用户：</b>${escapeHtml(userLabel(user, run))}`,
    `<b>执行编号：</b><code>${escapeHtml(executionId)}</code>`,
    `<b>目标：</b>${escapeHtml(target)}`,
    `<b>任务消息：</b><code>${escapeHtml(taskMessage.text)}</code>`,
    ...(taskMessage.truncated ? [`<b>消息长度：</b>${taskMessage.length} 字符（已显示首尾）`] : []),
    `<b>耗时：</b>${durationLabel(run.duration_ms)}`,
    ...(!isSuccess ? [
      `<b>账号：</b>${escapeHtml(accountName)}`,
      `<b>方式：</b>${trigger}`,
      ...(attempts > 1 ? [`<b>尝试：</b>${attempts} 次`] : []),
      ...(errorMessage ? ["", `<b>原因：</b>${escapeHtml(sanitizeLogText(errorMessage, { maxLines: 1, maxLength: 240 }))}`] : []),
      ...(logTail && !errorMessage ? ["", `<b>诊断：</b>${escapeHtml(logTail)}`] : []),
      ...(actionsUrl ? ["", "可点击下方按钮查看完整执行详情。"] : []),
    ] : []),
  ];

  const body = {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(actionsUrl ? {
      reply_markup: {
        inline_keyboard: [[{ text: "查看执行详情", url: actionsUrl }]],
      },
    } : {}),
  };
  const response = await telegramBotRequest(fetchImpl, token, "sendMessage", body);
  return { sent: response.ok, reason: response.ok ? null : `http_${response.status}` };
}

function notificationChatLabel(chat) {
  const title = String(chat?.title || "").trim();
  if (title) return title.slice(0, 96);
  const name = [chat?.first_name, chat?.last_name].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
  const username = String(chat?.username || "").trim().replace(/^@/, "");
  if (name && username) return `${name} (@${username})`.slice(0, 96);
  if (name) return name.slice(0, 96);
  if (username) return `@${username}`.slice(0, 96);
  return `Chat ${String(chat?.id || "")}`;
}

function compareChatIds(left, right) {
  try {
    const a = BigInt(left.id);
    const b = BigInt(right.id);
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return String(left.id).localeCompare(String(right.id));
  }
}

export async function discoverNotificationChats(env, repository, fetchImpl) {
  const token = await notificationSecret(repository, env, "bot_token");
  if (!token) return { ok: false, reason: "not_configured", chats: [] };
  const response = await telegramBotRequest(fetchImpl, token, "getUpdates", {
    limit: 50,
    timeout: 0,
    allowed_updates: ["message", "channel_post", "my_chat_member"],
  });
  if (!response.ok) return { ok: false, reason: `http_${response.status}`, chats: [] };
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response", chats: [] };
  }
  if (payload?.ok !== true || !Array.isArray(payload.result)) {
    return { ok: false, reason: "invalid_response", chats: [] };
  }
  const chats = new Map();
  for (const update of payload.result) {
    const chat = update?.message?.chat || update?.channel_post?.chat || update?.my_chat_member?.chat;
    const id = String(chat?.id || "");
    if (!/^-?\d{1,20}$/.test(id)) continue;
    chats.set(id, {
      id,
      label: notificationChatLabel(chat),
      type: ["private", "group", "supergroup", "channel"].includes(chat?.type) ? chat.type : "chat",
    });
  }
  return { ok: true, reason: null, chats: [...chats.values()].sort(compareChatIds).slice(0, 20) };
}

export async function sendTestNotification(env, repository, fetchImpl) {
  const { token, chatId } = await notificationCredentials(repository, env);
  if (!token || !chatId) return { sent: false, reason: "not_configured" };
  const response = await telegramBotRequest(fetchImpl, token, "sendMessage", {
    chat_id: chatId,
    text: "✅ <b>通知配置成功</b>\n\n以后所有用户的任务结果都会统一发送到这里，并包含用户、任务、目标、任务消息摘要和执行编号，方便管理员审计异常内容。消息会先脱敏，超长内容只显示首尾。",
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  return { sent: response.ok, reason: response.ok ? null : `http_${response.status}` };
}

export const __test = {
  compactAuditText,
  durationLabel,
  githubActionsUrl,
  notificationChatLabel,
  redactKnownSecrets,
  sanitizedLogTail,
  statusPresentation,
  taskMessageAudit,
};
