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
  const response = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
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

function sanitizedLogTail(logs, secrets, limit = 5) {
  const entries = Array.isArray(logs) ? logs.slice(-limit) : [];
  if (!entries.length) return null;
  const text = entries.map((entry) => {
    const level = String(entry?.level || "info").toUpperCase();
    const message = sanitizeLogText(
      redactKnownSecrets(String(entry?.message || "").replace(/\r?\n/g, " ↩ "), secrets),
      { maxLines: 1, maxLength: 180 },
    );
    return `[${level}] ${message}`;
  }).join("\n");
  return sanitizeLogText(redactKnownSecrets(text, secrets), { maxLines: limit, maxLength: 1_000 });
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
  const knownSecrets = [token, chatId];
  const icon = run.status === "success" ? "✅" : run.status === "ambiguous" ? "⚠️" : "❌";
  const actionsUrl = githubActionsUrl(env, run);
  const logTail = sanitizedLogTail(run.logs, knownSecrets);
  const taskName = redactKnownSecrets(run.task_name || run.task_id || "已删除任务", knownSecrets);
  const errorMessage = run.error_message ? redactKnownSecrets(run.error_message, knownSecrets) : null;
  const text = sanitizeLogText([
    `${icon} Telegram 自动消息：${run.status}`,
    `任务：${taskName}`,
    `耗时：${run.duration_ms ?? 0} ms`,
    ...(errorMessage ? [`错误：${errorMessage}`] : []),
    ...(actionsUrl ? [`GitHub Actions：${actionsUrl}`] : []),
    ...(logTail ? ["日志尾部：", logTail] : []),
  ].join("\n"), { maxLines: 18, maxLength: 3_500 });
  const response = await telegramBotRequest(fetchImpl, token, "sendMessage", {
    chat_id: chatId,
    text,
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
    text: "✅ Telegram 自动消息：测试通知\n通知通道配置成功。后续任务完成后，执行结果会发送到这里。",
    disable_web_page_preview: true,
  });
  return { sent: response.ok, reason: response.ok ? null : `http_${response.status}` };
}

export const __test = { githubActionsUrl, redactKnownSecrets, sanitizedLogTail, notificationChatLabel };
