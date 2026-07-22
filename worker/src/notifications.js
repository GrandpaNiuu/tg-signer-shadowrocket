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

function skillPresentation(run) {
  const builtIn = ({
    send_text: "发送文字或命令",
    tg_signer: "机器人按钮签到",
    send_media: "发送任意内容",
  })[run?.skill_key];
  return builtIn || String(run?.skill_name || run?.skill_key || "未知任务类型").trim();
}

function userLabel(user, run) {
  return user?.display_name || user?.email || user?.github_login || run.user_id || "未知用户";
}

function telegramAccountLabel(account, run) {
  const name = String(run?.account_name || account?.name || "").trim();
  const username = String(account?.telegram_username || "").trim().replace(/^@/, "");
  const phone = String(account?.phone_masked || "").trim();
  const displayName = String(account?.telegram_display_name || "").trim();
  const identity = username ? `@${username}` : phone || displayName;
  if (name && identity && name !== identity) return `${name}（${identity}）`;
  return name || identity || "未记录";
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

function resultFeedback(run, secrets) {
  const result = run?.result && typeof run.result === "object" && !Array.isArray(run.result) ? run.result : {};
  if (result.content_type) {
    const type = compactAuditText(({
      text: "文字", photo: "图片", video: "视频", document: "文件", audio: "音频",
      voice: "语音", animation: "动图", sticker: "贴纸", video_note: "视频消息",
      poll: "投票", contact: "联系人", location: "位置", venue: "地点",
      game: "游戏", invoice: "账单", story: "故事",
    })[result.content_type] || result.content_type, secrets, 40);
    const preview = compactAuditText(result.content_preview, secrets, 360);
    return preview === "未记录" ? `已发送 ${type}` : `已发送 ${type}：${preview}`;
  }
  if (result.matched_reply) return `机器人回复：${compactAuditText(result.matched_reply, secrets, 360)}`;
  if (result.button_clicked) return result.success_confirmed ? "按钮已点击，且机器人回复已确认成功" : "按钮已点击";
  if (result.delivered || result.sent) return "消息已送达";
  if (result.completed) return "任务流程已完成";
  if (run?.status === "success") return "执行成功";
  return run?.error_message ? "执行失败，详情见下方原因" : "执行结果已记录";
}

export async function sendRunNotification(env, repository, fetchImpl, runId) {
  const [token, chatId, run] = await Promise.all([
    notificationSecret(repository, env, "bot_token"),
    notificationSecret(repository, env, "chat_id"),
    repository.getRun(runId),
  ]);
  if (!token || !chatId || !run) return { sent: false, reason: "not_configured" };

  const [user, account] = await Promise.all([
    run.user_id && typeof repository.getUser === "function"
      ? repository.getUser(run.user_id)
      : null,
    run.account_id && typeof repository.getAccount === "function"
      ? repository.getAccount(run.account_id)
      : null,
  ]);
  const knownSecrets = [token, chatId];
  const presentation = statusPresentation(run.status);
  const actionsUrl = githubActionsUrl(env, run);
  const taskName = compactAuditText(run.task_name || run.task_id || "已删除任务", knownSecrets, 160);
  const target = compactAuditText(run.bot || run.result?.target, knownSecrets, 180);
  const taskMessage = taskMessageAudit(run.result?.task_message || run.command, knownSecrets);
  const accountName = compactAuditText(telegramAccountLabel(account, run), knownSecrets, 180);
  const errorMessage = run.error_message ? redactKnownSecrets(run.error_message, knownSecrets) : null;
  const logTail = run.status === "success" ? null : sanitizedLogTail(run.logs, knownSecrets);
  const attempts = Math.max(0, Number(run.attempt_count || 0));
  const maxAttempts = Math.max(attempts, Number(run.max_attempts || Number(run.retry || 0) + 1));
  const trigger = run.trigger_type === "manual" ? "手动执行" : "定时执行";
  const isSuccess = run.status === "success";
  const skill = compactAuditText(skillPresentation(run), knownSecrets, 120);
  const feedback = compactAuditText(resultFeedback(run, knownSecrets), knownSecrets, 420);
  const owner = compactAuditText(userLabel(user, run), knownSecrets, 180);

  const lines = [
    `${presentation.icon} <b>${presentation.title}</b>`,
    "",
    `<b>任务：</b>${escapeHtml(taskName)}`,
    `<b>类型：</b>${escapeHtml(skill)}`,
    `<b>用户：</b>${escapeHtml(owner)}`,
    `<b>Telegram：</b>${escapeHtml(accountName)}`,
    `<b>目标：</b>${escapeHtml(target)}`,
    `<b>任务消息：</b><code>${escapeHtml(taskMessage.text)}</code>`,
    ...(taskMessage.truncated ? [`<b>消息长度：</b>${taskMessage.length} 字符（已显示首尾）`] : []),
    `<b>执行反馈：</b>${escapeHtml(feedback)}`,
    `<b>执行方式：</b>${trigger}`,
    `<b>耗时：</b>${durationLabel(run.duration_ms)}`,
    `<b>尝试：</b>${attempts} / ${maxAttempts} 次`,
    ...(!isSuccess ? [
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

function realtimePresentation(kind) {
  return ({
    keyword_replied: { icon: "💬", title: "自动回复已发送" },
    message_observed: { icon: "👂", title: "消息监控命中" },
    listener_error: { icon: "❌", title: "实时自动化异常" },
  })[kind] || { icon: "ℹ️", title: "实时自动化事件" };
}

function realtimeKindLabel(kind) {
  return ({
    keyword_reply: "关键词自动回复",
    group_monitor: "消息监控",
  })[kind] || "实时自动化";
}

export async function sendRealtimeNotification(env, repository, fetchImpl, event) {
  const { token, chatId } = await notificationCredentials(repository, env);
  if (!token || !chatId) return { sent: false, reason: "not_configured" };

  const knownSecrets = [token, chatId];
  const presentation = realtimePresentation(event?.event_kind);
  const ruleName = compactAuditText(event?.rule_name || "实时自动化规则", knownSecrets, 160);
  const owner = compactAuditText(event?.user_name || event?.user_id || "未记录", knownSecrets, 160);
  const ruleType = compactAuditText(realtimeKindLabel(event?.rule_kind), knownSecrets, 120);
  const accountName = compactAuditText(event?.account_name || "未记录", knownSecrets, 160);
  const chat = compactAuditText(event?.chat_id || "未记录", knownSecrets, 80);
  const sender = compactAuditText(event?.sender_id || "未记录", knownSecrets, 80);
  const preview = compactAuditText(event?.message_preview || "未记录", knownSecrets, 360);
  const action = compactAuditText(event?.action_summary || "已记录命中事件", knownSecrets, 300);
  const lines = [
    `${presentation.icon} <b>${presentation.title}</b>`,
    "",
    `<b>规则：</b>${escapeHtml(ruleName)}`,
    `<b>类型：</b>${escapeHtml(ruleType)}`,
    `<b>用户：</b>${escapeHtml(owner)}`,
    `<b>Telegram：</b>${escapeHtml(accountName)}`,
    `<b>会话：</b>${escapeHtml(chat)}`,
    `<b>发送者：</b>${escapeHtml(sender)}`,
    `<b>收到：</b><code>${escapeHtml(preview)}</code>`,
    `<b>处理：</b>${escapeHtml(action)}`,
  ];
  const response = await telegramBotRequest(fetchImpl, token, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
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
    text: "✅ <b>通知配置成功</b>\n\n以后所有用户的任务结果都会统一发送到这里，并包含用户、Telegram 账号、任务、目标和任务消息摘要，方便管理员快速识别是哪一个账号执行。消息会先脱敏，超长内容只显示首尾。",
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
  realtimePresentation,
  realtimeKindLabel,
  resultFeedback,
  skillPresentation,
  taskMessageAudit,
  telegramAccountLabel,
};
