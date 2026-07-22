import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { sendRealtimeNotification } from "./notifications.js";
import { sanitizeLogText } from "./redaction.js";
import { verifyListener } from "./realtime-automation.js";

const EVENT_KINDS = new Set(["message_observed", "keyword_replied", "listener_error"]);
const CHAT_TYPE_LABELS = Object.freeze({
  private: "私聊",
  group: "群组",
  supergroup: "超级群组",
  channel: "频道",
});

function objectBody(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "请求内容格式不正确。", { fields: ["body"] });
  }
  return value;
}

function requiredText(value, field, maximum) {
  const output = String(value ?? "").trim();
  if (!output || output.length > maximum) {
    throw new HttpError(422, "validation_failed", "请检查填写内容。", { fields: [field] });
  }
  return output;
}

function optionalText(value, maximum, { lines = 1 } = {}) {
  const output = String(value ?? "").trim();
  if (!output) return null;
  return sanitizeLogText(output, { maxLines: lines, maxLength: maximum }) || null;
}

function optionalIdentifier(value) {
  const output = String(value ?? "").trim();
  return output ? output.slice(0, 40) : null;
}

function safeMessageLink(value) {
  const output = String(value ?? "").trim();
  return /^https?:\/\/t\.me\//i.test(output) ? output.slice(0, 500) : null;
}

function readableChat(body) {
  const label = optionalText(body.chat_label, 220);
  const type = String(body.chat_type ?? "").trim().toLowerCase();
  const typeLabel = CHAT_TYPE_LABELS[type] || "";
  if (label && typeLabel && !label.includes(typeLabel)) return `${label} · ${typeLabel}`;
  if (label) return label;
  const title = optionalText(body.chat_title, 160);
  const username = String(body.chat_username ?? "").trim().replace(/^@/, "").slice(0, 64);
  if (title && username) return `${title}（@${username}）`;
  if (title) return title;
  if (username) return `@${username}`;
  return optionalIdentifier(body.chat_id) || "会话信息未公开";
}

function readableSender(body) {
  const label = optionalText(body.sender_label, 220);
  if (label) return label;
  const name = optionalText(body.sender_name, 160);
  const username = String(body.sender_username ?? "").trim().replace(/^@/, "").slice(0, 64);
  const senderType = String(body.sender_type ?? "").trim().toLowerCase();
  let output = name && username ? `${name}（@${username}）` : name || (username ? `@${username}` : "");
  if (!output) output = optionalIdentifier(body.sender_id) || "发送者身份未公开";
  if (senderType === "bot" && !output.includes("机器人")) output += "（机器人）";
  return output;
}

async function notificationContextForEvent(repository, body) {
  if (body.rule_id) {
    return repository.db.prepare(`SELECT r.name AS rule_name, r.kind AS rule_kind, r.notify_on_match,
      r.user_id, a.name AS account_name, u.display_name AS user_display_name,
      u.email AS user_email, u.github_login AS user_github_login FROM realtime_rules r
      LEFT JOIN accounts a ON a.id = r.account_id
      LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`)
      .bind(body.rule_id).first();
  }
  if (body.account_id) {
    const account = await repository.db.prepare(`SELECT a.name AS account_name, a.user_id,
      u.display_name AS user_display_name, u.email AS user_email,
      u.github_login AS user_github_login FROM accounts a
      LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?`)
      .bind(body.account_id).first();
    return { ...account, notify_on_match: 1 };
  }
  return { notify_on_match: 1 };
}

async function recordListenerEvent(request, repository, env, context) {
  const body = objectBody(await readJson(request, 48_000));
  const eventKind = requiredText(body.event_kind, "event_kind", 40);
  if (!EVENT_KINDS.has(eventKind)) {
    throw new HttpError(422, "validation_failed", "Invalid listener event kind.", { fields: ["event_kind"] });
  }

  const timestamp = new Date().toISOString();
  const preview = optionalText(body.message_preview, 600, { lines: 3 });
  const action = optionalText(body.action_summary, 300, { lines: 2 });
  const chatTitle = optionalText(body.chat_title, 160);
  const chatUsername = optionalText(String(body.chat_username ?? "").replace(/^@/, ""), 64);
  const chatType = optionalText(body.chat_type, 32);
  const chatLabel = optionalText(body.chat_label, 220);
  const senderName = optionalText(body.sender_name, 160);
  const senderUsername = optionalText(String(body.sender_username ?? "").replace(/^@/, ""), 64);
  const senderType = optionalText(body.sender_type, 32);
  const senderLabel = optionalText(body.sender_label, 220);
  const messageLink = safeMessageLink(body.message_link);
  const notificationContext = await notificationContextForEvent(repository, body);

  await repository.db.batch([
    repository.db.prepare(`INSERT INTO listener_events
      (rule_id, account_id, event_kind, chat_id, sender_id, message_id, message_preview, action_summary, created_at,
       chat_title, chat_username, chat_type, chat_label, sender_name, sender_username, sender_type, sender_label, message_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(body.rule_id || null, body.account_id || null, eventKind,
        optionalIdentifier(body.chat_id), optionalIdentifier(body.sender_id), optionalIdentifier(body.message_id),
        preview, action, timestamp, chatTitle, chatUsername, chatType, chatLabel,
        senderName, senderUsername, senderType, senderLabel, messageLink),
    body.rule_id
      ? repository.db.prepare("UPDATE realtime_rules SET last_event_at = ?, updated_at = updated_at WHERE id = ?")
        .bind(timestamp, body.rule_id)
      : repository.db.prepare("SELECT 1"),
  ]);

  let notification;
  try {
    notification = await sendRealtimeNotification(env, repository, context.fetch, {
      event_kind: eventKind,
      rule_name: notificationContext?.rule_name,
      rule_kind: notificationContext?.rule_kind,
      user_id: notificationContext?.user_id,
      user_name: notificationContext?.user_display_name
        || notificationContext?.user_email
        || notificationContext?.user_github_login,
      account_name: notificationContext?.account_name,
      chat_id: readableChat(body),
      sender_id: readableSender(body),
      message_preview: preview,
      action_summary: action,
      created_at: timestamp,
    });
  } catch {
    notification = { sent: false, reason: "notification_failed" };
  }
  return json({ data: { accepted: true, notification } }, 202);
}

export async function handleListenerEventApi(request, env, repository, context = {}) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/listener/v1/events") return null;
  await verifyListener(request, env);
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  return recordListenerEvent(request, repository, env, {
    fetch: context.fetch || globalThis.fetch,
  });
}

export const __test = {
  readableChat,
  readableSender,
  safeMessageLink,
};
