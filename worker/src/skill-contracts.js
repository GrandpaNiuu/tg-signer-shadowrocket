import { HttpError } from "./http.js";

const TARGET = /^(?:@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,20})$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const SKILLS = new Set(["send_text", "tg_signer", "bot_flow", "send_media", "chat_snapshot"]);
const FLOW_ACTIONS = new Set(["send", "wait_message", "read_buttons", "click_button"]);

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
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return { steps: parsed };
    return object(parsed, field);
  } catch {
    fail([field]);
  }
}

function target(value, field = "params.target") {
  const output = text(value, field, { max: 128 });
  if (!TARGET.test(output)) fail([field]);
  return output;
}

function normalizeFlowStep(raw, index) {
  const field = `params.steps.${index}`;
  const input = object(raw, field);
  const action = text(input.action, `${field}.action`, { max: 40 });
  if (!FLOW_ACTIONS.has(action)) fail([`${field}.action`]);
  const allowed = {
    send: ["action", "text", "timeout"],
    wait_message: ["action", "match", "match_any", "timeout"],
    read_buttons: ["action", "timeout"],
    click_button: ["action", "button", "timeout"],
  }[action];
  exact(input, allowed, field);
  const timeout = integer(input.timeout, `${field}.timeout`, { min: 1, max: 120 });
  const output = { action, timeout };
  if (action === "send") output.text = text(input.text, `${field}.text`, { max: 4000 });
  if (action === "click_button") output.button = text(input.button, `${field}.button`, { max: 128 });
  if (action === "wait_message") {
    const match = text(input.match, `${field}.match`, { required: false, max: 200 });
    const matchAny = input.match_any ?? [];
    if (!Array.isArray(matchAny) || matchAny.length > 20) fail([`${field}.match_any`]);
    const values = matchAny.map((item, itemIndex) => text(item, `${field}.match_any.${itemIndex}`, { max: 200 }));
    if (!match && !values.length) fail([`${field}.match`, `${field}.match_any`]);
    if (match) output.match = match;
    if (values.length) output.match_any = values;
  }
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
  if (skillKey === "bot_flow") {
    const source = Object.keys(params).length ? params : legacyJson(legacy.command, "command");
    const input = exact(source, ["target", "steps", "message_thread_id"], "params");
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20) fail(["params.steps"]);
    const steps = input.steps.map(normalizeFlowStep);
    if (steps.reduce((total, step) => total + step.timeout, 0) > 600) fail(["params.steps"]);
    return {
      target: target(input.target ?? legacy.bot),
      steps,
      message_thread_id: integer(input.message_thread_id ?? legacy.thread_id, "params.message_thread_id", { min: 1, max: Number.MAX_SAFE_INTEGER, nullable: true }),
    };
  }
  if (skillKey === "send_media") {
    const source = Object.keys(params).length ? params : legacyJson(legacy.command, "command");
    const input = exact(source, ["target", "file_id", "media_type", "caption", "message_thread_id", "delete_after"], "params");
    const fileId = text(input.file_id, "params.file_id", { max: 160 });
    if (!ASSET_ID.test(fileId)) fail(["params.file_id"]);
    const mediaType = text(input.media_type, "params.media_type", { max: 20 });
    if (!["photo", "document", "video"].includes(mediaType)) fail(["params.media_type"]);
    return {
      target: target(input.target ?? legacy.bot),
      file_id: fileId,
      media_type: mediaType,
      caption: input.caption === undefined || input.caption === null || input.caption === "" ? null : text(input.caption, "params.caption", { max: 1024 }),
      message_thread_id: integer(input.message_thread_id ?? legacy.thread_id, "params.message_thread_id", { min: 1, max: Number.MAX_SAFE_INTEGER, nullable: true }),
      delete_after: integer(input.delete_after ?? legacy.delete_after_seconds, "params.delete_after", { min: 0, max: 86400, nullable: true }),
    };
  }
  if (skillKey === "chat_snapshot") {
    let source = params;
    if (!Object.keys(params).length) {
      const command = String(legacy.command ?? "").trim();
      source = command.startsWith("{") ? legacyJson(command, "command") : { keyword: command || null };
    }
    const input = exact(source, ["target", "limit", "keyword"], "params");
    return {
      target: target(input.target ?? legacy.bot),
      limit: integer(input.limit, "params.limit", { min: 1, max: 50, fallback: 20 }),
      keyword: input.keyword === undefined || input.keyword === null || input.keyword === "" ? null : text(input.keyword, "params.keyword", { max: 200 }),
    };
  }
  fail(["skill_key"]);
}

export function taskPresentation(skillKey, params) {
  if (skillKey === "send_text") return { bot: String(params.target), command: params.text, thread_id: params.message_thread_id, delete_after_seconds: params.delete_after };
  if (skillKey === "tg_signer") return { bot: "", command: params.task_name, thread_id: null, delete_after_seconds: null };
  if (skillKey === "bot_flow") return { bot: String(params.target), command: `通用机器人流程 · ${params.steps.length} 步`, thread_id: params.message_thread_id, delete_after_seconds: null };
  if (skillKey === "send_media") return { bot: String(params.target), command: `[${params.media_type}] ${params.file_id}${params.caption ? ` · ${params.caption}` : ""}`.slice(0, 2000), thread_id: params.message_thread_id, delete_after_seconds: params.delete_after };
  if (skillKey === "chat_snapshot") return { bot: String(params.target), command: params.keyword ? `采集最近 ${params.limit} 条 · 关键词：${params.keyword}` : `采集最近 ${params.limit} 条消息`, thread_id: null, delete_after_seconds: null };
  fail(["skill_key"]);
}

export function paramsJson(params) {
  return JSON.stringify(params);
}

export const __test = { FLOW_ACTIONS, SKILLS, TARGET, ASSET_ID };
