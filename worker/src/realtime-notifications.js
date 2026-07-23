import { decryptSecret, rootKeyForVersion } from "./crypto.js";
import { sanitizeLogText } from "./redaction.js";

const MEDIA_METHODS = Object.freeze({
  photo: { method: "sendPhoto", field: "photo", label: "图片" },
  video: { method: "sendVideo", field: "video", label: "视频" },
  audio: { method: "sendAudio", field: "audio", label: "音频" },
  voice: { method: "sendVoice", field: "voice", label: "语音" },
  animation: { method: "sendAnimation", field: "animation", label: "动图" },
  document: { method: "sendDocument", field: "document", label: "文件" },
  sticker: { method: "sendDocument", field: "document", label: "贴纸" },
  video_note: { method: "sendDocument", field: "document", label: "视频消息" },
});

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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function removeGenerationArtifacts(value) {
  return String(value ?? "")
    .replace(/\[\[\d+\]\]\(https?:\/\/[^)\s]+\)/gi, "")
    .replace(/\[\d+\]\(https?:\/\/[^)\s]+\)/gi, "")
    .replace(/\[TRUNCATED\]/gi, "")
    .replace(/\s*↩\s*/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanDisplayText(value, secrets, maximum = 500, fallback = "未记录") {
  let output = String(value ?? "");
  for (const secret of secrets.filter((item) => item && String(item).length >= 6)) {
    output = output.split(String(secret)).join("[REDACTED]");
  }
  output = sanitizeLogText(output, { maxLines: 30, maxLength: 8_000 });
  output = removeGenerationArtifacts(output);
  if (output.length > maximum) output = `${output.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
  return output || fallback;
}

function compact(value, secrets, maximum = 320, fallback = "未记录") {
  return cleanDisplayText(value, secrets, maximum, fallback)
    .replace(/\s*\n\s*/g, " · ")
    .replace(/[\t ]+/g, " ")
    .trim() || fallback;
}

function formattedTime(value) {
  const source = String(value ?? "").trim();
  if (!source) return "未记录";
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return source.slice(0, 80);
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

async function telegramJsonRequest(fetchImpl, token, method, body) {
  return fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function telegramMultipartRequest(fetchImpl, token, method, form) {
  return fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: "POST",
    body: form,
  });
}

async function botResult(response) {
  if (!response?.ok) return { sent: false, reason: `http_${Number(response?.status || 0)}`, message_id: null };
  try {
    const payload = await response.json();
    if (payload?.ok !== true) return { sent: false, reason: "invalid_response", message_id: null };
    const messageId = Number(payload?.result?.message_id);
    return {
      sent: true,
      reason: null,
      message_id: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null,
    };
  } catch {
    // Older tests and compatible Bot API proxies may return an empty successful response.
    return { sent: true, reason: null, message_id: null };
  }
}

function realtimePresentation(kind) {
  return ({
    keyword_replied: { icon: "💬", title: "自动回复已发送" },
    message_observed: { icon: "👂", title: "监听到新消息" },
    listener_error: { icon: "❌", title: "实时自动化异常" },
  })[kind] || { icon: "ℹ️", title: "实时自动化事件" };
}

function realtimeKindLabel(kind) {
  return ({
    keyword_reply: "关键词自动回复",
    group_monitor: "消息监听",
  })[kind] || "实时自动化";
}

function autoReplyLabel(event) {
  const explicit = String(event?.auto_reply_status || "").toLowerCase();
  if (explicit === "sent") return "已发送";
  if (explicit === "failed") return "发送失败";
  if (explicit === "skipped") return "已跳过";
  if (explicit === "not_configured") return "未配置";
  if (event?.event_kind === "keyword_replied") return "已发送";
  return event?.rule_kind === "keyword_reply" ? "未触发" : "未配置";
}

function mediaFeedbackLabel(event, mediaLabel) {
  if (!mediaLabel) return "无附件";
  const explicit = String(event?.media_feedback_status || "").toLowerCase();
  if (explicit === "sent") return "成功";
  if (explicit === "failed") return "失败";
  if (explicit === "skipped") return "已跳过";
  return "处理中，原文件将回复在本回执下方";
}

function explicitOriginalText(event, fallbackKey = "message_preview") {
  if (event && Object.prototype.hasOwnProperty.call(event, "original_text")) return event.original_text;
  return event?.[fallbackKey];
}

function notificationLines(event, secrets) {
  const presentation = realtimePresentation(event?.event_kind);
  const ruleName = compact(event?.rule_name, secrets, 160, "实时自动化规则");
  const owner = compact(event?.user_name || event?.user_id, secrets, 160, "未记录");
  const accountName = compact(event?.account_name, secrets, 180, "未记录");
  const chat = compact(event?.chat_label || event?.chat_id, secrets, 220, "会话名称未公开");
  const sender = compact(event?.sender_label || event?.sender_id, secrets, 220, "发送者身份未公开");
  const mediaLabel = event?.media_label ? compact(event.media_label, secrets, 100) : null;
  const originalText = cleanDisplayText(
    explicitOriginalText(event),
    secrets,
    700,
    mediaLabel ? "无文字说明" : "未记录",
  );
  const analysis = event?.analysis_text
    ? cleanDisplayText(event.analysis_text, secrets, 700, "")
    : "";
  const matchedKeyword = event?.matched_keyword
    ? compact(event.matched_keyword, secrets, 160, "")
    : "";
  const matchSource = compact(
    event?.match_source,
    secrets,
    120,
    matchedKeyword ? "消息文字" : "规则范围",
  );
  const action = compact(event?.action_summary, secrets, 360, "规则已命中");
  const messageType = mediaLabel || compact(event?.message_type, secrets, 80, "文字");
  const time = formattedTime(event?.message_time || event?.created_at);

  if (event?.event_kind === "listener_error") {
    return [
      `${presentation.icon} <b>${presentation.title}</b>`,
      "",
      `<b>监听账号：</b>${escapeHtml(accountName)}`,
      ...(event?.chat_label ? [`<b>来源会话：</b>${escapeHtml(chat)}`] : []),
      ...(event?.sender_label ? [`<b>发送者：</b>${escapeHtml(sender)}`] : []),
      `<b>发生时间：</b>${escapeHtml(time)}`,
      "",
      `<b>异常说明：</b>${escapeHtml(action)}`,
    ];
  }

  return [
    `${presentation.icon} <b>${presentation.title}</b>`,
    "",
    `<b>监听账号：</b>${escapeHtml(accountName)}`,
    `<b>来源会话：</b>${escapeHtml(chat)}`,
    `<b>发送者：</b>${escapeHtml(sender)}`,
    `<b>收到时间：</b>${escapeHtml(time)}`,
    `<b>平台用户：</b>${escapeHtml(owner)}`,
    "",
    `<b>消息类型：</b>${escapeHtml(messageType)}`,
    `<b>原始文字：</b><code>${escapeHtml(originalText)}</code>`,
    ...(mediaLabel ? [`<b>附件：</b>${escapeHtml(mediaLabel)} 1 个`] : []),
    ...(analysis ? ["", `<b>AI 分析：</b>${escapeHtml(analysis)}`] : []),
    "",
    `<b>命中规则：</b>${escapeHtml(ruleName)}`,
    ...(matchedKeyword ? [`<b>命中关键词：</b>${escapeHtml(matchedKeyword)}`] : []),
    `<b>命中位置：</b>${escapeHtml(matchSource)}`,
    "",
    "<b>处理状态：</b>",
    "• 监听结果：规则已命中",
    `• 自动回复：${escapeHtml(autoReplyLabel(event))}`,
    "• 通知回传：成功",
    `• 媒体回传：${escapeHtml(mediaFeedbackLabel(event, mediaLabel))}`,
    ...(event?.event_kind === "keyword_replied" ? [`<b>处理说明：</b>${escapeHtml(action)}`] : []),
  ];
}

export async function sendRealtimeNotification(env, repository, fetchImpl, event) {
  const { token, chatId } = await notificationCredentials(repository, env);
  if (!token || !chatId) return { sent: false, reason: "not_configured", message_id: null };
  const secrets = [token, chatId];
  const messageLink = /^https?:\/\/t\.me\//i.test(String(event?.message_link || ""))
    ? String(event.message_link).slice(0, 500)
    : null;
  const response = await telegramJsonRequest(fetchImpl, token, "sendMessage", {
    chat_id: chatId,
    text: notificationLines(event, secrets).join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(messageLink ? {
      reply_markup: { inline_keyboard: [[{ text: "打开 Telegram 原消息", url: messageLink }]] },
    } : {}),
  });
  return botResult(response);
}

export async function sendRealtimeMediaNotification(env, repository, fetchImpl, event, file) {
  const { token, chatId } = await notificationCredentials(repository, env);
  if (!token || !chatId) return { sent: false, reason: "not_configured", message_id: null };
  const media = MEDIA_METHODS[String(event?.media_kind || "")] || MEDIA_METHODS.document;
  if (!(file instanceof Blob) || file.size < 1) {
    return { sent: false, reason: "empty_file", message_id: null };
  }
  const secrets = [token, chatId];
  const account = compact(event?.account_name, secrets, 100, "未记录账号");
  const chat = compact(event?.chat_label, secrets, 120, "会话名称未公开");
  const sender = compact(event?.sender_label, secrets, 120, "发送者身份未公开");
  const originalText = cleanDisplayText(
    explicitOriginalText(event, "caption") ?? event?.message_preview,
    secrets,
    380,
    "无文字说明",
  );
  const caption = [
    `<b>${escapeHtml(media.label)} · 媒体回传成功</b>`,
    `<b>来源会话：</b>${escapeHtml(chat)}`,
    `<b>发送者：</b>${escapeHtml(sender)}`,
    `<b>原始文字：</b>${escapeHtml(originalText)}`,
    `<b>监听账号：</b>${escapeHtml(account)}`,
  ].join("\n");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("parse_mode", "HTML");
  form.set("caption", caption.slice(0, 1_024));
  const fileName = String(event?.media_file_name || "telegram-media.bin").slice(0, 160);
  form.set(media.field, file, fileName);
  const receiptMessageId = Number(event?.receipt_message_id);
  if (Number.isSafeInteger(receiptMessageId) && receiptMessageId > 0) {
    form.set("reply_parameters", JSON.stringify({
      message_id: receiptMessageId,
      allow_sending_without_reply: true,
    }));
  }
  const response = await telegramMultipartRequest(fetchImpl, token, media.method, form);
  return botResult(response);
}

export const __test = {
  MEDIA_METHODS,
  autoReplyLabel,
  cleanDisplayText,
  compact,
  explicitOriginalText,
  formattedTime,
  mediaFeedbackLabel,
  notificationLines,
  realtimeKindLabel,
  realtimePresentation,
  removeGenerationArtifacts,
};
