import { createSecretRecord } from "./admin-api.js";
import { nextCronDate } from "./cron.js";
import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { normalizeSkillParams, paramsJson, taskPresentation } from "./skill-contracts.js";
import { taskInput, validateTaskRuntime } from "./validation.js";

const MEDIA_TYPES = new Set(["photo", "document", "video"]);
const TARGET = /^(?:@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,20})$/;

function iso(now) { return now().toISOString(); }
function rows(result) { return result?.results || []; }

function listOptions(url) {
  const limitSource = url.searchParams.get("limit") || "50";
  const cursorSource = url.searchParams.get("cursor") || "0";
  if (!/^\d+$/.test(limitSource) || !/^\d+$/.test(cursorSource)) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["pagination"] });
  }
  const limit = Number(limitSource);
  const offset = Number(cursorSource);
  if (limit < 1 || limit > 100 || !Number.isSafeInteger(offset)) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["pagination"] });
  }
  return { limit, offset };
}

function page(items, { limit, offset }) {
  const hasMore = items.length > limit;
  return {
    data: items.slice(0, limit),
    pagination: { limit, next_cursor: hasMore ? String(offset + limit) : null },
  };
}

function safeParams(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsedCommand(value) {
  const source = String(value ?? "").trim();
  if (!source) return {};
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return { steps: parsed };
    if (!parsed || typeof parsed !== "object") throw new Error("invalid command object");
    return parsed;
  } catch {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["command"] });
  }
}

function legacyParams(task) {
  try {
    return normalizeSkillParams(task.skill_key, {}, {
      bot: task.bot,
      command: task.command,
      thread_id: task.thread_id,
      delete_after_seconds: task.delete_after_seconds,
    });
  } catch {
    return {};
  }
}

async function attachParams(repository, tasks) {
  if (!tasks.length) return tasks;
  const placeholders = tasks.map(() => "?").join(",");
  const result = await repository.db.prepare(`SELECT id, params_json FROM tasks
    WHERE id IN (${placeholders}) ${repository.userId ? "AND user_id = ?" : ""}`)
    .bind(...tasks.map((task) => task.id), ...(repository.userId ? [repository.userId] : [])).all();
  const paramsById = new Map(rows(result).map((row) => [row.id, safeParams(row.params_json)]));
  return tasks.map((task) => {
    const stored = paramsById.get(task.id) || {};
    return { ...task, params: Object.keys(stored).length ? stored : legacyParams(task) };
  });
}

function mergedLegacyParams(skillKey, current, input) {
  if (input.params !== undefined) return input.params;
  const params = { ...(current?.params || {}) };
  if (skillKey === "send_text") {
    if (input.bot !== undefined) params.target = input.bot;
    if (input.command !== undefined) params.text = input.command;
    if (input.thread_id !== undefined) params.message_thread_id = input.thread_id;
    if (input.delete_after_seconds !== undefined) params.delete_after = input.delete_after_seconds;
    return params;
  }
  if (skillKey === "tg_signer") {
    if (input.command !== undefined) params.task_name = input.command;
    return params;
  }
  if (skillKey === "account_audit") return {};

  if (input.bot !== undefined) params.target = input.bot;
  if (input.thread_id !== undefined && skillKey === "bot_flow") {
    params.message_thread_id = input.thread_id;
  }
  if (input.delete_after_seconds !== undefined && skillKey === "send_media") {
    params.delete_after = input.delete_after_seconds;
  }
  if (input.command !== undefined && (!current || input.command !== current.command)) {
    const parsed = parsedCommand(input.command);
    Object.assign(params, parsed);
  }
  return params;
}

async function validateMediaAsset(repository, params) {
  if (!params?.file_id) return null;
  const row = await repository.db.prepare(`SELECT id, media_type, source_chat_id, source_message_id
    FROM media_assets WHERE id = ? ${repository.userId ? "AND user_id = ?" : ""}`)
    .bind(params.file_id, ...(repository.userId ? [repository.userId] : [])).first();
  if (!row || row.media_type !== params.media_type) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["params.file_id", "params.media_type"] });
  }
  return row;
}

async function storeParams(repository, taskId, params, timestamp) {
  const result = await repository.db.prepare(`UPDATE tasks SET params_json = ?, updated_at = ? WHERE id = ?
    ${repository.userId ? "AND user_id = ?" : ""}`)
    .bind(paramsJson(params), timestamp, taskId, ...(repository.userId ? [repository.userId] : [])).run();
  if (!Number(result?.meta?.changes || 0)) {
    throw new HttpError(404, "task_not_found", "Task was not found.");
  }
}

async function taskCollection(request, env, repository, context, url) {
  if (request.method === "GET") {
    const options = listOptions(url);
    const accountId = url.searchParams.get("account_id") || undefined;
    const enabledText = url.searchParams.get("enabled");
    const enabled = enabledText === null ? undefined : enabledText === "true" ? true : enabledText === "false" ? false : (() => {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["enabled"] });
    })();
    const items = await repository.listTasks({ ...options, limit: options.limit + 1, accountId, enabled });
    return json(page(await attachParams(repository, items), options));
  }
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const settings = await repository.getSettings();
  const input = taskInput(await readJson(request, 256_000), { defaultTimezone: settings.default_timezone || "Asia/Shanghai" });
  const account = await repository.getAccount(input.account_id);
  if (!account) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["account_id"] });
  const skill = await repository.getSkillByKey(input.skill_key);
  if (!skill) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["skill_key"] });
  const params = normalizeSkillParams(input.skill_key, input.params || {}, input);
  if (input.skill_key === "send_media") await validateMediaAsset(repository, params);
  const presentation = {
    ...taskPresentation(input.skill_key, params),
    ...(input.skill_key === "tg_signer" ? { bot: input.bot, command: input.command } : {}),
  };
  validateTaskRuntime({ ...input, ...presentation });
  const timestamp = iso(context.now);
  const taskId = context.uuid();
  const signerImportSecret = input.tg_signer_import
    ? await createSecretRecord({ env, ...context, ownerType: "task", ownerId: taskId, purpose: "tg_signer_import", value: input.tg_signer_import })
    : null;
  const requestedEnabled = input.enabled !== false;
  await repository.createTask({
    id: taskId,
    name: input.name,
    account_id: input.account_id,
    skill_id: skill.id,
    ...presentation,
    cron: input.cron,
    timezone: input.timezone,
    retry: input.retry ?? 0,
    timeout_seconds: input.timeout_seconds ?? 120,
    enabled: 0,
    next_run_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  }, signerImportSecret);
  await storeParams(repository, taskId, params, timestamp);
  if (requestedEnabled) {
    await repository.updateTask(taskId, {
      enabled: 1,
      next_run_at: nextCronDate(input.cron, input.timezone, context.now()).toISOString(),
      updated_at: timestamp,
    });
  }
  const [created] = await attachParams(repository, [await repository.getTask(taskId)]);
  return json({ data: created }, 201);
}

async function taskItem(request, env, repository, context, id) {
  const [current] = await attachParams(repository, [await repository.getTask(id)].filter(Boolean));
  if (!current) throw new HttpError(404, "task_not_found", "Task was not found.");
  if (request.method === "GET") return json({ data: current });
  if (request.method === "DELETE") {
    const outcome = await repository.deleteTask(id, iso(context.now));
    if (outcome.blocked) throw new HttpError(409, "task_running", "Wait for the active task run to finish before deleting this task.");
    if (!outcome.deleted) throw new HttpError(404, "task_not_found", "Task was not found.");
    return new Response(null, { status: 204 });
  }
  if (request.method !== "PATCH") return methodNotAllowed(["GET", "PATCH", "DELETE"]);
  const input = taskInput(await readJson(request, 256_000), { patch: true, defaultTimezone: current.timezone });
  const finalSkillKey = input.skill_key ?? current.skill_key;
  if (input.account_id !== undefined && !await repository.getAccount(input.account_id)) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["account_id"] });
  }
  let skillId;
  if (input.skill_key !== undefined) {
    const skill = await repository.getSkillByKey(input.skill_key);
    if (!skill) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["skill_key"] });
    skillId = skill.id;
  }
  const rawParams = mergedLegacyParams(finalSkillKey, finalSkillKey === current.skill_key ? current : null, input);
  const params = normalizeSkillParams(finalSkillKey, rawParams, {
    bot: input.bot ?? current.bot,
    command: input.command ?? current.command,
    thread_id: input.thread_id ?? current.thread_id,
    delete_after_seconds: input.delete_after_seconds ?? current.delete_after_seconds,
  });
  if (finalSkillKey === "send_media") await validateMediaAsset(repository, params);
  const presentation = {
    ...taskPresentation(finalSkillKey, params),
    ...(finalSkillKey === "tg_signer" ? {
      bot: input.bot ?? current.bot,
      command: input.command ?? current.command,
    } : {}),
  };
  validateTaskRuntime({ ...input, skill_key: finalSkillKey, ...presentation }, current);
  const timestamp = iso(context.now);
  const values = { ...input, ...presentation, updated_at: timestamp };
  delete values.skill_key;
  delete values.params;
  delete values.tg_signer_import;
  if (skillId) values.skill_id = skillId;
  if (input.enabled !== undefined) values.enabled = input.enabled ? 1 : 0;
  const finalEnabled = input.enabled ?? current.enabled;
  const finalCron = input.cron ?? current.cron;
  const finalTimezone = input.timezone ?? current.timezone;
  if (!finalEnabled) values.next_run_at = null;
  else if (input.enabled === true || input.cron !== undefined || input.timezone !== undefined) {
    values.next_run_at = nextCronDate(finalCron, finalTimezone, context.now()).toISOString();
  }
  const signerImportSecret = typeof input.tg_signer_import === "string"
    ? await createSecretRecord({ env, ...context, ownerType: "task", ownerId: id, purpose: "tg_signer_import", value: input.tg_signer_import })
    : null;
  const updated = await repository.updateTask(id, values, {
    signerImportSecret,
    clearSignerImport: input.tg_signer_import === null || finalSkillKey !== "tg_signer",
  });
  if (!updated) throw new HttpError(404, "task_not_found", "Task was not found.");
  await storeParams(repository, id, params, timestamp);
  const [result] = await attachParams(repository, [await repository.getTask(id)]);
  return json({ data: result });
}

function mediaAssetInput(body) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["body"] });
  }
  const unknown = Object.keys(body).filter((key) => !["name", "media_type", "source_chat_id", "source_message_id"].includes(key));
  if (unknown.length) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: unknown });
  const name = String(body.name || "").trim();
  const mediaType = String(body.media_type || "").trim();
  const sourceChatId = String(body.source_chat_id || "").trim();
  const sourceMessageId = body.source_message_id;
  const fields = [];
  if (!name || name.length > 100) fields.push("name");
  if (!MEDIA_TYPES.has(mediaType)) fields.push("media_type");
  if (!TARGET.test(sourceChatId)) fields.push("source_chat_id");
  if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId < 1) fields.push("source_message_id");
  if (fields.length) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields });
  return { name, media_type: mediaType, source_chat_id: sourceChatId, source_message_id: sourceMessageId };
}

async function mediaAssets(request, repository, context, parts, url) {
  if (parts[0] !== "media-assets") return null;
  const id = parts[1];
  if (!id) {
    if (request.method === "GET") {
      const options = listOptions(url);
      const result = await repository.db.prepare(`SELECT id, name, media_type, source_chat_id, source_message_id, created_at, updated_at
        FROM media_assets WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .bind(repository.userId || "legacy-admin", options.limit + 1, options.offset).all();
      return json(page(rows(result), options));
    }
    if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
    const input = mediaAssetInput(await readJson(request, 32_000));
    const timestamp = iso(context.now);
    const asset = { id: context.uuid(), ...input, created_at: timestamp, updated_at: timestamp };
    try {
      await repository.db.prepare(`INSERT INTO media_assets
        (id, user_id, name, media_type, source_chat_id, source_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(asset.id, repository.userId || "legacy-admin", asset.name, asset.media_type, asset.source_chat_id, asset.source_message_id, timestamp, timestamp).run();
    } catch {
      throw new HttpError(409, "media_asset_exists", "This Telegram source message is already registered.");
    }
    return json({ data: asset }, 201);
  }
  if (parts.length !== 2) return null;
  const asset = await repository.db.prepare(`SELECT id FROM media_assets WHERE id = ? AND user_id = ?`)
    .bind(id, repository.userId || "legacy-admin").first();
  if (!asset) throw new HttpError(404, "media_asset_not_found", "Media asset was not found.");
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  const usage = await repository.db.prepare(`SELECT COUNT(*) AS total FROM tasks
    WHERE user_id = ? AND json_extract(params_json, '$.file_id') = ?`).bind(repository.userId || "legacy-admin", id).first();
  if (Number(usage?.total || 0) > 0) throw new HttpError(409, "media_asset_in_use", "Delete or edit tasks that use this media asset first.");
  await repository.db.prepare("DELETE FROM media_assets WHERE id = ? AND user_id = ?")
    .bind(id, repository.userId || "legacy-admin").run();
  return new Response(null, { status: 204 });
}

export async function handleSkillTaskApi(request, env, repository, context = {}) {
  const url = new URL(request.url);
  const prefix = "/api/v1/";
  if (!url.pathname.startsWith(prefix)) return null;
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  const mediaResponse = await mediaAssets(request, repository, context, parts, url);
  if (mediaResponse) return mediaResponse;
  if (parts[0] !== "tasks") return null;
  if (parts.length === 1) return taskCollection(request, env, repository, context, url);
  if (parts.length === 2) return taskItem(request, env, repository, context, parts[1]);
  // Keep the existing manual-run endpoint in admin-api.js.
  return null;
}

export const __test = { attachParams, legacyParams, mediaAssetInput, mergedLegacyParams, safeParams, validateMediaAsset };
