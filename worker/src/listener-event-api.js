import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { sendRealtimeMediaNotification, sendRealtimeNotification } from "./realtime-notifications.js";
import { sanitizeLogText } from "./redaction.js";
import { verifyListener } from "./realtime-automation.js";

const EVENT_KINDS = new Set(["message_observed", "keyword_replied", "listener_error"]);
const MEDIA_KINDS = new Set(["photo", "video", "document", "audio", "voice", "animation", "sticker", "video_note"]);
const AUTO_REPLY_STATUSES = new Set(["sent", "failed", "skipped", "not_configured", "not_triggered"]);
const MEDIA_FEEDBACK_STATUSES = new Set(["pending", "sent", "failed", "skipped", "not_applicable"]);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const CHAT_TYPE_LABELS = Object.freeze({
  private: "私聊",
  group: "群组",
  supergroup: "超级群组",
  channel: "频道",
});
const MEDIA_LABELS = Object.freeze({
  photo: "图片",
  video: "视频",
  document: "文件",
  audio: "音频",
  voice: "语音",
  animation: "动图",
  sticker: "贴纸",
  video_note: "视频消息",
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

function cleanObservedText(value, maximum = 600) {
  let output = String(value ?? "").trim();
  if (!output) return null;
  output = sanitizeLogText(output, { maxLines: 30, maxLength: 8_000 })
    .replace(/\[\[\d+\]\]\(https?:\/\/[^)\s]+\)/gi, "")
    .replace(/\[\d+\]\(https?:\/\/[^)\s]+\)/gi, "")
    .replace(/\[TRUNCATED\]/gi, "")
    .replace(/\s*↩\s*/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!output) return null;
  return output.length > maximum
    ? `${output.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`
    : output;
}

function optionalIdentifier(value) {
  const output = String(value ?? "").trim();
  return output ? output.slice(0, 40) : null;
}

function safeMessageLink(value) {
  const output = String(value ?? "").trim();
  return /^https?:\/\/t\.me\//i.test(output) ? output.slice(0, 500) : null;
}

function safeEventTime(value) {
  const output = String(value ?? "").trim();
  if (!output) return null;
  const date = new Date(output);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function enumValue(value, allowed, fallback) {
  const output = String(value ?? "").trim().toLowerCase();
  return allowed.has(output) ? output : fallback;
}

function readableChat(body) {
  const label = optionalText(body.chat_label, 220);
  const type = String(body.chat_type ?? "").trim().toLowerCase();
  const typeLabel = CHAT_TYPE_LABELS[type] || "会话";
  if (label && typeLabel && !label.includes(typeLabel)) return `${label} · ${typeLabel}`;
  if (label) return label;
  const title = optionalText(body.chat_title, 160);
  const username = String(body.chat_username ?? "").trim().replace(/^@/, "").slice(0, 64);
  if (title && username) return `${title}（@${username}）`;
  if (title) return title;
  if (username) return `@${username}`;
  return `${typeLabel}（名称未公开）`;
}

function readableSender(body) {
  const label = optionalText(body.sender_label, 220);
  if (label) return label;
  const name = optionalText(body.sender_name, 160);
  const username = String(body.sender_username ?? "").trim().replace(/^@/, "").slice(0, 64);
  const senderType = String(body.sender_type ?? "").trim().toLowerCase();
  let output = name && username ? `${name}（@${username}）` : name || (username ? `@${username}` : "");
  if (!output) {
    output = ({
      bot: "Telegram 机器人（名称未公开）",
      anonymous_admin: "匿名管理员（身份未公开）",
      channel_signature: "频道发送者（身份未公开）",
      chat_identity: "会话身份（名称未公开）",
      user: "Telegram 用户（名称未公开）",
    })[senderType] || "发送者身份未公开";
  }
  if (senderType === "bot" && !output.includes("机器人")) output += "（机器人）";
  return output;
}

function mediaMetadata(body) {
  const kind = String(body.media_kind ?? "").trim().toLowerCase();
  if (!kind) return null;
  if (!MEDIA_KINDS.has(kind)) {
    throw new HttpError(422, "validation_failed", "监听附件类型不受支持。", { fields: ["media_kind"] });
  }
  const size = Number(body.media_size_bytes || 0);
  return {
    media_kind: kind,
    media_label: MEDIA_LABELS[kind],
    media_file_name: optionalText(body.media_file_name, 160),
    media_mime_type: optionalText(body.media_mime_type, 120),
    media_size_bytes: Number.isSafeInteger(size) && size >= 0 ? size : 0,
  };
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
  const media = mediaMetadata(body);
  const originalText = cleanObservedText(body.original_text ?? body.message_preview, 900);
  const preview = originalText
    || (media ? `[${media.media_label}]${media.media_file_name ? ` ${media.media_file_name}` : ""}` : null);
  const analysisText = cleanObservedText(body.analysis_text, 900);
  const action = cleanObservedText(body.action_summary, 400);
  const matchedKeyword = cleanObservedText(body.matched_keyword, 160);
  const matchSource = cleanObservedText(body.match_source, 120);
  const chatTitle = optionalText(body.chat_title, 160);
  const chatUsername = optionalText(String(body.chat_username ?? "").replace(/^@/, ""), 64);
  const chatType = optionalText(body.chat_type, 32);
  const chatLabel = optionalText(body.chat_label, 220);
  const senderName = optionalText(body.sender_name, 160);
  const senderUsername = optionalText(String(body.sender_username ?? "").replace(/^@/, ""), 64);
  const senderType = optionalText(body.sender_type, 32);
  const senderLabel = optionalText(body.sender_label, 220);
  const messageLink = safeMessageLink(body.message_link);
  const messageTime = safeEventTime(body.message_time);
  const messageType = optionalText(body.message_type, 80) || (media ? media.media_label : "文字");
  const autoReplyStatus = enumValue(
    body.auto_reply_status,
    AUTO_REPLY_STATUSES,
    eventKind === "keyword_replied" ? "sent" : "not_configured",
  );
  const mediaFeedbackStatus = enumValue(
    body.media_feedback_status,
    MEDIA_FEEDBACK_STATUSES,
    media ? "pending" : "not_applicable",
  );
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
      chat_label: readableChat(body),
      sender_label: readableSender(body),
      original_text: originalText,
      message_preview: preview,
      analysis_text: analysisText,
      matched_keyword: matchedKeyword,
      match_source: matchSource,
      message_time: messageTime,
      message_type: messageType,
      auto_reply_status: autoReplyStatus,
      media_feedback_status: mediaFeedbackStatus,
      action_summary: action,
      message_link: messageLink,
      ...media,
      created_at: timestamp,
    });
  } catch {
    notification = { sent: false, reason: "notification_failed", message_id: null };
  }
  return json({ data: { accepted: true, notification } }, 202);
}

function multipartText(form, name, maximum, fallback = "") {
  const value = String(form.get(name) ?? fallback).trim();
  if (value.length > maximum) {
    throw new HttpError(422, "validation_failed", "监听附件信息过长。", { fields: [name] });
  }
  return value;
}

async function recordListenerMedia(request, repository, env, context) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size < 1) {
    throw new HttpError(422, "validation_failed", "监听附件为空。", { fields: ["file"] });
  }
  if (file.size > MAX_MEDIA_BYTES) {
    throw new HttpError(413, "listener_media_too_large", "监听附件超过 20 MB，已保留文字回执但不转发文件。" );
  }
  const mediaKind = multipartText(form, "media_kind", 40).toLowerCase();
  if (!MEDIA_KINDS.has(mediaKind)) {
    throw new HttpError(422, "validation_failed", "监听附件类型不受支持。", { fields: ["media_kind"] });
  }
  const receiptMessageId = Number(form.get("receipt_message_id") || 0);
  const result = await sendRealtimeMediaNotification(env, repository, context.fetch, {
    receipt_message_id: Number.isSafeInteger(receiptMessageId) ? receiptMessageId : null,
    media_kind: mediaKind,
    media_file_name: multipartText(form, "media_file_name", 160, "telegram-media.bin"),
    account_name: multipartText(form, "account_name", 180, "未记录账号"),
    chat_label: multipartText(form, "chat_label", 220, "会话名称未公开"),
    sender_label: multipartText(form, "sender_label", 220, "发送者身份未公开"),
    original_text: multipartText(form, "caption", 900, "无文字说明"),
  }, file);
  return json({ data: { accepted: true, notification: result } }, result.sent ? 202 : 502);
}

export async function handleListenerEventApi(request, env, repository, context = {}) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/listener/v1/events") return null;
  await verifyListener(request, env);
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) {
    return recordListenerMedia(request, repository, env, { fetch: context.fetch || globalThis.fetch });
  }
  return recordListenerEvent(request, repository, env, {
    fetch: context.fetch || globalThis.fetch,
  });
}

export const __test = {
  MAX_MEDIA_BYTES,
  cleanObservedText,
  mediaMetadata,
  readableChat,
  readableSender,
  safeEventTime,
  safeMessageLink,
};
