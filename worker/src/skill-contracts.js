import { HttpError } from "./http.js";

const TARGET = /^(?:@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,20}|me|self)$/i;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const SKILLS = new Set(["send_text", "tg_signer", "send_media"]);
const CONTENT_KINDS = new Set(["photo", "video", "audio", "voice", "animation", "video_note", "sticker", "document"]);

function fail(fields) {
  throw new HttpError(422, "validation_failed", "Request validation failed.", {
    fields: [...new Set(fields)].sort(),
  });
}

function object(value, field) {
  if (!value || Array.isArray(value) || typeof value !== "object") fail([field]);
  return value;
}

function exact(value, allowed, field) {
  const input = object(value, field);
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(unknown.map((key) => `${field}.${key}`));
  return input;
}

function text(value, field, { required = true, max = 4096 } = {}) {
  const output = String(value ?? "").trim();
  if ((required && !output) || output.length > max) fail([field]);
  return output;
}

function integer(value, field, { min, max, fallback, nullable = false } = {}) {
  if ((value === undefined || value === "") && fallback !== undefined) return fallback;
  if ((value === undefined || value === null || value === "") && nullable) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail([field]);
  return value;
}

function legacyJson(value, field) {
  const source = String(value ?? "").trim();
  if (!source) return {};
  try {
    return object(JSON.parse(source), field);
  } catch {
    fail([field]);
  }
}

function target(value, field = "params.target") {
  const output = text(value, field, { max: 128 });
  if (!TARGET.test(output)) fail([field]);
  return output;
}

export function normalizeSkillParams(skillKey, rawParams = {}, legacy = {}) {
  if (!SKILLS.has(skillKey)) fail(["skill_key"]);
  const params = rawParams === undefined || rawParams === null ? {} : object(rawParams, "params");
  if (skillKey === "send_text") {
    const input = exact(params, ["target", "text", "message_thread_id", "delete_after"], "params");
    return {
      target: target(input.target ?? legacy.bot),
      text: text(input.text ?? legacy.command, "params.text", { max: 4096 }),
      message_thread_id: integer(input.message_thread_id ?? legacy.thread_id, "params.message_thread_id", { min: 1, max: Number.MAX_SAFE_INTEGER, nullable: true }),
      delete_after: integer(input.delete_after ?? legacy.delete_after_seconds, "params.delete_after", { min: 0, max: 86400, nullable: true }),
    };
  }
  if (skillKey === "tg_signer") {
    const input = exact(params, ["task_name", "num_of_dialogs"], "params");
    return {
      task_name: text(input.task_name ?? legacy.command, "params.task_name", { max: 128 }),
      num_of_dialogs: integer(input.num_of_dialogs, "params.num_of_dialogs", { min: 1, max: 500, fallback: 50 }),
    };
  }
  const source = Object.keys(params).length ? params : legacyJson(legacy.command, "command");
  const input = exact(source, [
    "target", "source_chat_id", "source_message_id", "file_id", "media_type",
    "caption", "message_thread_id", "delete_after", "source_name", "source_content_type",
    "source_size_bytes", "source_kind", "source_upload_id",
  ], "params");
  const directSource = input.source_chat_id !== undefined || input.source_message_id !== undefined;
  const common = {
    target: target(input.target ?? legacy.bot),
    caption: input.caption === undefined || input.caption === null
      ? null
      : text(input.caption, "params.caption", { required: false, max: 1024 }),
    message_thread_id: integer(input.message_thread_id ?? legacy.thread_id, "params.message_thread_id", { min: 1, max: Number.MAX_SAFE_INTEGER, nullable: true }),
    delete_after: integer(input.delete_after ?? legacy.delete_after_seconds, "params.delete_after", { min: 0, max: 86400, nullable: true }),
  };
  if (directSource) {
    const direct = {
      ...common,
      source_chat_id: target(input.source_chat_id, "params.source_chat_id"),
      source_message_id: integer(input.source_message_id, "params.source_message_id", { min: 1, max: Number.MAX_SAFE_INTEGER }),
    };
    if (input.source_name !== undefined) direct.source_name = text(input.source_name, "params.source_name", { max: 160 });
    if (input.source_content_type !== undefined) direct.source_content_type = text(input.source_content_type, "params.source_content_type", { max: 120 });
    if (input.source_size_bytes !== undefined) direct.source_size_bytes = integer(input.source_size_bytes, "params.source_size_bytes", { min: 1, max: 20 * 1024 * 1024 });
    if (input.source_kind !== undefined) {
      const contentKind = text(input.source_kind, "params.source_kind", { max: 20 });
      if (!CONTENT_KINDS.has(contentKind)) fail(["params.source_kind"]);
      direct.source_kind = contentKind;
    }
    if (input.source_upload_id !== undefined) direct.source_upload_id = text(input.source_upload_id, "params.source_upload_id", { max: 160 });
    return direct;
  }
  const fileId = text(input.file_id, "params.file_id", { max: 160 });
  if (!ASSET_ID.test(fileId)) fail(["params.file_id"]);
  const mediaType = text(input.media_type, "params.media_type", { max: 20 });
  if (!["photo", "document", "video"].includes(mediaType)) fail(["params.media_type"]);
  return {
    ...common,
    file_id: fileId,
    media_type: mediaType,
  };
}

export function taskPresentation(skillKey, params) {
  if (skillKey === "send_text") return { bot: String(params.target), command: params.text, thread_id: params.message_thread_id, delete_after_seconds: params.delete_after };
  if (skillKey === "tg_signer") return { bot: "", command: params.task_name, thread_id: null, delete_after_seconds: null };
  if (skillKey === "send_media") {
    const source = params.source_chat_id !== undefined
      ? params.source_name || `${params.source_chat_id} / 消息 ${params.source_message_id}`
      : `旧媒体 ${params.file_id}`;
    const caption = params.caption === null ? "" : params.caption === "" ? " · 移除原说明" : ` · ${params.caption}`;
    return {
      bot: String(params.target),
      command: `[任意内容] ${source}${caption}`.slice(0, 2000),
      thread_id: params.message_thread_id,
      delete_after_seconds: params.delete_after,
    };
  }
  fail(["skill_key"]);
}

export function paramsJson(params) {
  return JSON.stringify(params);
}

export const __test = { SKILLS, TARGET, ASSET_ID };
