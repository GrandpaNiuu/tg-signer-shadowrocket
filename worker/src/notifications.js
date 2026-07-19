import { decryptSecret, rootKeyForVersion } from "./crypto.js";
import { sanitizeLogText } from "./redaction.js";

async function notificationSecret(repository, env, purpose) {
  const secret = await repository.getSecretByOwnerPurpose("setting", "telegram_notification", purpose);
  const rootKey = secret && rootKeyForVersion(env, secret.key_version);
  if (!secret || !rootKey) return null;
  return decryptSecret(rootKey, secret, { purpose, ownerId: "telegram_notification" });
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
  const response = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return { sent: response.ok, reason: response.ok ? null : `http_${response.status}` };
}

export const __test = { githubActionsUrl, redactKnownSecrets, sanitizedLogTail };
