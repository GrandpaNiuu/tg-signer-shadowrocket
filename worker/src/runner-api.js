import { createSecretRecord } from "./admin-api.js";
import { decryptSecret, rootKeyForVersion } from "./crypto.js";
import { nextCronDate } from "./cron.js";
import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { TERMINAL_LOGIN_STATUSES } from "./login-states.js";
import { sendRunNotification } from "./notifications.js";
import { resolveTelegramApplicationCredentialRefs } from "./telegram-application.js";
import { redact, sanitizeLogText } from "./redaction.js";
import { dispatchNextForAccount } from "./scheduler.js";
import { exactObject, maskPhone, validateTaskRuntime } from "./validation.js";

const TERMINAL_RUNS = new Set(["success", "failed", "cancelled", "ambiguous"]);
const TERMINAL_LOGINS = new Set(TERMINAL_LOGIN_STATUSES);

function timestamp(value, fallback, field) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: [field] });
  }
  return new Date(value).toISOString();
}

function integer(value, field, minimum, maximum, fallback = undefined) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: [field] });
  }
  return value;
}

function errorFields(value) {
  if (value === undefined || value === null) return { code: null, message: null };
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["error"] });
  }
  return {
    code: sanitizeLogText(String(value.code || "runner_error"), { maxLines: 1, maxLength: 100 }),
    message: sanitizeLogText(String(value.message || "Runner failed."), { maxLines: 20, maxLength: 2_000 }),
  };
}

function normalizedLogs(value, context, attemptId = null, dedupePrefix = null) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["logs"] });
  }
  return value.slice(-100).map((entry, index) => {
    const object = entry && typeof entry === "object" && !Array.isArray(entry) ? redact(entry) : entry;
    const requestedLevel = object && typeof object === "object" ? String(object.level || "info").toLowerCase() : "info";
    const level = ["debug", "info", "warning", "error"].includes(requestedLevel) ? requestedLevel : "info";
    const message = typeof object === "string"
      ? object
      : JSON.stringify(object);
    return {
      attempt_id: attemptId,
      dedupe_key: dedupePrefix ? `${dedupePrefix}:${index}` : null,
      level,
      message: sanitizeLogText(message, { maxLines: 20, maxLength: 4_000 }),
      created_at: object && typeof object === "object"
        ? timestamp(object.timestamp, context.now().toISOString(), "logs.timestamp")
        : context.now().toISOString(),
    };
  });
}

export function executionLeaseSeconds(execution) {
  const retries = Math.max(0, Math.min(10, Number(execution.retry || 0)));
  const timeout = Math.max(5, Math.min(900, Number(execution.timeout_seconds || 120)));
  let backoff = 0;
  for (let index = 0; index < retries; index += 1) backoff += Math.min(60, 2 * (2 ** index));
  return timeout * (retries + 1) + backoff + 300;
}

async function plaintext(repository, env, secretId, purpose, ownerId, { required = false } = {}) {
  if (!secretId) {
    if (required) throw new HttpError(409, "account_secret_missing", `Account ${purpose} is missing.`);
    return null;
  }
  const secret = await repository.getSecret(secretId);
  if (!secret || secret.owner_id !== ownerId || secret.purpose !== purpose) {
    if (required) throw new HttpError(409, "account_secret_missing", `Account ${purpose} is missing.`);
    return null;
  }
  const rootKey = rootKeyForVersion(env, secret.key_version);
  if (!rootKey) throw new HttpError(500, "secret_key_missing", "Worker secret encryption is not configured.");
  return decryptSecret(rootKey, secret, { purpose, ownerId });
}

async function claimTask(runId, env, repository, context, claims) {
  const now = context.now();
  const pending = await repository.getExecution(runId);
  if (!pending) throw new HttpError(409, "run_not_claimable", "Task run is expired, busy, or already claimed.");
  const leaseUntil = new Date(now.getTime() + executionLeaseSeconds(pending) * 1_000).toISOString();
  const execution = await repository.claimRun(runId, String(claims.run_id), now.toISOString(), leaseUntil);
  if (!execution) throw new HttpError(409, "run_not_claimable", "Task run is expired, busy, or already claimed.");
  const ownerId = execution.account_id;
  const session = await plaintext(repository, env, execution.session_secret_id, "telegram_session", ownerId, { required: true });
  const application = await resolveTelegramApplicationCredentialRefs(repository, execution);
  const apiId = await plaintext(repository, env, application?.apiIdSecretId, "api_id", application?.ownerId);
  const apiHash = await plaintext(repository, env, application?.apiHashSecretId, "api_hash", application?.ownerId);
  const proxy = await plaintext(repository, env, execution.proxy_secret_id, "proxy", ownerId);
  let signerImport = null;
  if (execution.skill_key === "tg_signer" && execution.tg_signer_import_secret_id) {
    signerImport = await plaintext(
      repository,
      env,
      execution.tg_signer_import_secret_id,
      "tg_signer_import",
      execution.task_id,
    );
  } else if (execution.skill_key === "tg_signer") {
    // Compatibility for an early D1 migration build that stored this value on the account.
    const legacyImport = await repository.getSecretByOwnerPurpose("account", ownerId, "tg_signer_import_base64");
    signerImport = legacyImport
      ? await decryptSecret(rootKeyForVersion(env, legacyImport.key_version), legacyImport, { purpose: "tg_signer_import_base64", ownerId })
      : null;
  }
  const params = execution.skill_key === "tg_signer"
    ? {
      task_name: execution.command,
      ...(signerImport ? { import_blob: signerImport, import_encoding: "auto" } : {}),
      num_of_dialogs: 50,
    }
    : {
      target: execution.bot,
      text: execution.command,
      message_thread_id: execution.thread_id,
      delete_after: execution.delete_after_seconds,
    };
  return json({
    run: { id: execution.id, scheduled_for: execution.scheduled_for, trigger: execution.trigger_type === "schedule" ? "cron" : execution.trigger_type },
    task: {
      id: execution.task_id,
      name: execution.task_name,
      skill: execution.skill_key,
      params,
      retry: execution.retry,
      retry_delay_seconds: 2,
      timeout_seconds: Math.min(execution.timeout_seconds, 900),
    },
    account: {
      id: ownerId,
      name: execution.account_name,
      secrets: {
        session_string: session,
        ...(apiId ? { api_id: Number(apiId) } : {}),
        ...(apiHash ? { api_hash: apiHash } : {}),
        ...(proxy ? { proxy } : {}),
      },
    },
  });
}

async function attempt(runId, request, repository, context, claims) {
  const body = await readJson(request, 128_000);
  exactObject(body, ["attempt", "status", "started_at", "finished_at", "duration_ms", "error", "logs"], ["attempt", "status"]);
  const attemptNumber = integer(body.attempt, "attempt", 1, 11);
  if (!/^(running|success|failed|ambiguous)$/.test(String(body.status))) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["status"] });
  }
  const now = context.now().toISOString();
  const error = errorFields(body.error);
  const attemptId = `${runId}:attempt:${attemptNumber}`;
  const value = {
    id: attemptId,
    attempt: attemptNumber,
    status: body.status,
    started_at: timestamp(body.started_at, now, "started_at"),
    finished_at: body.status === "running" ? null : timestamp(body.finished_at, now, "finished_at"),
    duration_ms: body.duration_ms === undefined ? null : integer(body.duration_ms, "duration_ms", 0, 86_400_000),
    error_code: error.code,
    error_message: error.message,
    created_at: now,
    updated_at: now,
  };
  if (!await repository.recordAttempt(runId, String(claims.run_id), value)) {
    throw new HttpError(409, "run_state_conflict", "Task run cannot accept this attempt.");
  }
  await repository.appendLogs(runId, normalizedLogs(body.logs, context, attemptId, `attempt:${attemptNumber}`));
  return json({ ok: true });
}

async function completeTask(runId, request, env, repository, context, claims) {
  const body = await readJson(request, 256_000);
  exactObject(body, ["run_id", "status", "started_at", "finished_at", "duration_ms", "attempts", "error", "result", "logs", "callback_pending"], ["status", "duration_ms"]);
  if (body.run_id !== undefined && String(body.run_id) !== runId) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["run_id"] });
  }
  if (!TERMINAL_RUNS.has(String(body.status))) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["status"] });
  }
  const now = context.now().toISOString();
  const error = errorFields(body.error);
  const completion = {
    status: body.status,
    started_at: timestamp(body.started_at, now, "started_at"),
    finished_at: timestamp(body.finished_at, now, "finished_at"),
    duration_ms: integer(body.duration_ms, "duration_ms", 0, 86_400_000),
    attempts: integer(body.attempts, "attempts", 0, 11, 0),
    error_code: error.code,
    error_message: error.message,
    result_json: JSON.stringify(redact(body.result ?? {})).slice(0, 32_000),
    updated_at: now,
  };
  const execution = await repository.getExecution(runId);
  const completionLogs = normalizedLogs(body.logs, context, null, "completion");
  const completed = await repository.completeRun(runId, String(claims.run_id), completion);
  if (!completed) {
    const existing = await repository.getExecution(runId);
    if (existing && existing.github_run_id === String(claims.run_id) && TERMINAL_RUNS.has(existing.status)) {
      await repository.appendLogs(runId, completionLogs);
      return json({ ok: true, status: existing.status, idempotent: true });
    }
    throw new HttpError(409, "run_state_conflict", "Task run cannot be completed in its current state.");
  }
  await repository.appendLogs(runId, completionLogs);
  try {
    const notification = await sendRunNotification(env, repository, context.fetch, runId);
    if (!notification.sent && !["disabled", "not_configured"].includes(notification.reason)) {
      await repository.appendLogs(runId, [{
        attempt_id: null,
        level: "warning",
        message: `Run notification failed (${notification.reason}).`,
        created_at: context.now().toISOString(),
      }]);
    }
  } catch {
    await repository.appendLogs(runId, [{
      attempt_id: null,
      level: "warning",
      message: "Run notification failed.",
      created_at: context.now().toISOString(),
    }]);
  }
  if (execution?.account_id) {
    try {
      await dispatchNextForAccount(execution.account_id, env, {
        repository,
        fetch: context.fetch,
        now: context.now,
      });
    } catch {
      // The scheduled reconciler will retry this pending dispatch.
    }
  }
  return json({ ok: true, status: body.status });
}

async function taskRoutes(request, env, repository, context, claims, parts) {
  if (parts[0] !== "runs" || parts.length !== 3) return null;
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const runId = parts[1];
  if (parts[2] === "claim") {
    exactObject(await readJson(request), []);
    return claimTask(runId, env, repository, context, claims);
  }
  if (parts[2] === "attempts") return attempt(runId, request, repository, context, claims);
  if (parts[2] === "complete") return completeTask(runId, request, env, repository, context, claims);
  return null;
}

async function claimLogin(flowId, env, repository, context, claims) {
  const now = context.now();
  const execution = await repository.claimLoginFlow(flowId, String(claims.run_id), now.toISOString());
  if (!execution) throw new HttpError(409, "login_not_claimable", "Login flow is expired or already claimed.");
  const ownerId = execution.account_id;
  const validationMode = execution.mode === "session_validation";
  const phone = validationMode
    ? null
    : await plaintext(repository, env, execution.phone_secret_id, "phone", ownerId, { required: true });
  const application = await resolveTelegramApplicationCredentialRefs(repository, execution);
  const apiId = await plaintext(
    repository,
    env,
    application?.apiIdSecretId,
    "api_id",
    application?.ownerId,
    { required: !validationMode },
  );
  const apiHash = await plaintext(
    repository,
    env,
    application?.apiHashSecretId,
    "api_hash",
    application?.ownerId,
    { required: !validationMode },
  );
  const session = validationMode
    ? await plaintext(repository, env, execution.session_secret_id, "telegram_session", ownerId, { required: true })
    : null;
  const proxy = await plaintext(repository, env, execution.proxy_secret_id, "proxy", ownerId);
  return json({
    flow: {
      id: flowId,
      mode: validationMode ? "session_validation" : "interactive_login",
      expires_at: execution.expires_at,
      timeout_seconds: Math.max(60, Math.min(900, Math.floor((Date.parse(execution.expires_at) - now.getTime()) / 1_000))),
    },
    account: {
      id: ownerId,
      name: execution.account_name,
      ...(phone ? { phone } : {}),
      ...(apiId ? { api_id: Number(apiId) } : {}),
      ...(apiHash ? { api_hash: apiHash } : {}),
      ...(session ? { session_string: session } : {}),
      ...(proxy ? { proxy } : {}),
    },
  });
}

async function loginEvent(flowId, request, repository, context, claims) {
  const body = await readJson(request);
  exactObject(body, ["state", "error"], ["state"]);
  const rules = {
    starting: { expected: ["starting"], next: "starting" },
    code_required: { expected: ["starting", "code_submitted", "code_required"], next: "code_required" },
    password_required: { expected: ["code_submitted", "password_submitted", "password_required"], next: "password_required" },
  };
  const rule = rules[body.state];
  if (!rule) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["state"] });
  const execution = await repository.getLoginExecution(flowId, String(claims.run_id));
  if (!execution) throw new HttpError(404, "login_flow_not_found", "Login flow was not found.");
  const error = errorFields(body.error);
  if (execution.status === rule.next && !error.message && !execution.last_error) {
    return json({ ok: true, status: execution.status, idempotent: true });
  }
  const flow = await repository.updateLoginStatus(
    flowId,
    rule.expected,
    rule.next,
    context.now().toISOString(),
    error.message,
  );
  if (!flow) throw new HttpError(409, "login_state_conflict", "Login flow cannot accept this event.");
  return json({ ok: true, status: flow.status });
}

async function claimLoginInput(flowId, request, env, repository, context, claims) {
  const body = await readJson(request);
  exactObject(body, ["expected"], ["expected"]);
  if (!/^(code|password|resend)$/.test(String(body.expected))) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["expected"] });
  }
  const execution = await repository.getLoginExecution(flowId, String(claims.run_id));
  if (!execution) throw new HttpError(404, "login_flow_not_found", "Login flow was not found.");
  if (body.expected === "resend") {
    const requested = await repository.consumeLoginCodeResend(
      flowId,
      String(claims.run_id),
      context.now().toISOString(),
    );
    return requested ? json({ kind: "resend", value: "requested" }) : json({ status: "waiting" });
  }
  const secret = await repository.consumeLoginInput(flowId, String(claims.run_id), body.expected, context.now().toISOString());
  if (!secret) return json({ status: "waiting" });
  const purpose = body.expected === "code" ? "login_code" : "two_factor_password";
  const rootKey = rootKeyForVersion(env, secret.key_version);
  if (!rootKey) throw new HttpError(500, "secret_key_missing", "Worker secret encryption is not configured.");
  const value = await decryptSecret(rootKey, secret, { purpose, ownerId: flowId });
  return json({ kind: body.expected, value });
}

async function completeLogin(flowId, request, env, repository, context, claims) {
  const body = await readJson(request, 64_000);
  exactObject(body, ["status", "session_string", "error"], ["status"]);
  if (!/^(connected|failed)$/.test(String(body.status))) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["status"] });
  }
  const execution = await repository.getLoginExecution(flowId, String(claims.run_id));
  if (!execution) throw new HttpError(404, "login_flow_not_found", "Login flow was not found.");
  if (TERMINAL_LOGINS.has(execution.status)) {
    await repository.cleanupLoginFlowSecrets(flowId);
    return json({ ok: true, status: execution.status, idempotent: true });
  }
  const now = context.now().toISOString();
  const error = errorFields(body.error);
  let sessionSecret = null;
  if (body.status === "connected") {
    if (execution.mode === "session_validation") {
      if (body.session_string !== undefined) {
        throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["session_string"] });
      }
    } else {
      if (typeof body.session_string !== "string" || body.session_string.length < 20 || body.session_string.length > 16_384) {
        throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["session_string"] });
      }
      sessionSecret = await createSecretRecord({
        env,
        ...context,
        ownerType: "account",
        ownerId: execution.account_id,
        purpose: "telegram_session",
        value: body.session_string,
      });
    }
  }
  const flow = await repository.completeLoginFlow(flowId, String(claims.run_id), {
    status: body.status,
    error: error.message,
    sessionSecret,
    updated_at: now,
  });
  if (!flow) throw new HttpError(409, "login_state_conflict", "Login flow cannot be completed.");
  return json({ ok: true, status: flow.status });
}

async function loginRoutes(request, env, repository, context, claims, parts) {
  if (parts[0] !== "login-flows" || parts.length < 3) return null;
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const flowId = parts[1];
  if (parts.length === 3 && parts[2] === "claim") {
    exactObject(await readJson(request), []);
    return claimLogin(flowId, env, repository, context, claims);
  }
  if (parts.length === 3 && parts[2] === "events") return loginEvent(flowId, request, repository, context, claims);
  if (parts.length === 4 && parts[2] === "input" && parts[3] === "claim") return claimLoginInput(flowId, request, env, repository, context, claims);
  if (parts.length === 3 && parts[2] === "complete") return completeLogin(flowId, request, env, repository, context, claims);
  return null;
}

async function migrateLegacy(request, env, repository, context, claims) {
  const body = await readJson(request, 256_000);
  exactObject(body, ["schema_version", "dry_run", "activate_scheduler", "source", "presence", "accounts", "tasks", "notification"], ["schema_version", "dry_run"]);
  if (body.schema_version !== 1 || typeof body.dry_run !== "boolean") {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["schema_version", "dry_run"] });
  }
  if (body.activate_scheduler !== undefined && body.activate_scheduler !== false) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["activate_scheduler"] });
  }
  if (body.source?.repository && body.source.repository !== claims.repository) {
    throw new HttpError(403, "migration_source_mismatch", "Migration source does not match the authenticated workflow.");
  }
  if (body.dry_run) {
    return json({
      ok: true,
      dry_run: true,
      accounts_planned: Number(Boolean(body.presence?.primary_account)) + Number(Boolean(body.presence?.secondary_account)),
      tasks_planned: Number(Boolean(body.presence?.primary_account)) + Number(Boolean(body.presence?.secondary_account)),
      presence: redact(body.presence || {}),
    });
  }
  if (!Array.isArray(body.accounts) || !Array.isArray(body.tasks) || body.accounts.length < 1 || body.accounts.length > 2 || body.tasks.length > 2) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["accounts", "tasks"] });
  }
  const now = context.now();
  for (const source of body.accounts) {
    exactObject(source, ["legacy_id", "name", "session_string", "api_id", "api_hash", "account", "proxy", "enabled"], ["legacy_id", "name", "session_string"]);
    if (!/^(legacy-primary|legacy-secondary)$/.test(String(source.legacy_id)) || typeof source.session_string !== "string" || source.session_string.length < 20) {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["accounts"] });
    }
    const apiId = source.api_id === undefined || source.api_id === null || source.api_id === ""
      ? null
      : String(source.api_id).trim();
    const apiHash = source.api_hash === undefined || source.api_hash === null || source.api_hash === ""
      ? null
      : String(source.api_hash).trim();
    if (Boolean(apiId) !== Boolean(apiHash)
      || (apiId && !/^\d{4,12}$/.test(apiId))
      || (apiHash && !/^[a-fA-F0-9]{32,64}$/.test(apiHash))) {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["accounts"] });
    }
    const id = source.legacy_id;
    const secretInputs = {
      session: source.session_string,
      ...(apiId ? { api_id: apiId, api_hash: apiHash } : {}),
      ...(source.proxy ? { proxy: String(source.proxy) } : {}),
    };
    const secrets = [];
    for (const [field, purpose] of [["session", "telegram_session"], ["api_id", "api_id"], ["api_hash", "api_hash"], ["proxy", "proxy"]]) {
      if (secretInputs[field]) secrets.push(await createSecretRecord({ env, ...context, ownerType: "account", ownerId: id, purpose, value: secretInputs[field] }));
    }
    const existing = await repository.getAccount(id);
    const account = String(source.account || "");
    const masked = /^\+[1-9]\d{6,14}$/.test(account) ? maskPhone(account) : "legacy account";
    if (existing) {
      await repository.updateAccount(id, {
        changes: { name: String(source.name).slice(0, 80), phone_masked: masked, status: "connected", enabled: source.enabled === false ? 0 : 1, last_connected_at: now.toISOString(), last_error: null, updated_at: now.toISOString() },
        secrets,
        clearSecrets: [],
      });
    } else {
      await repository.createAccount({ account: {
        id, name: String(source.name).slice(0, 80), phone_masked: masked, status: "connected",
        enabled: source.enabled === false ? 0 : 1, last_connected_at: now.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(),
      }, secrets });
    }
  }
  for (const source of body.tasks) {
    exactObject(source, ["legacy_id", "account_legacy_id", "name", "skill", "target", "command", "signer_task_name", "signer_import_base64", "cron", "timezone", "retry", "timeout_seconds", "thread", "delete_after", "enabled"], ["legacy_id", "account_legacy_id", "name", "skill", "cron", "timezone"]);
    const skillKey = String(source.skill).replace("-", "_") === "task" ? "tg_signer" : String(source.skill).replace("-", "_");
    if (!/^(send_text|tg_signer)$/.test(skillKey)
      || !/^(legacy-primary|legacy-secondary)-task$/.test(String(source.legacy_id))
      || !/^(legacy-primary|legacy-secondary)$/.test(String(source.account_legacy_id))) {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["tasks"] });
    }
    const skill = await repository.getSkillByKey(skillKey);
    const taskId = source.legacy_id;
    const command = skillKey === "tg_signer" ? String(source.signer_task_name || source.command || "legacy_sign") : String(source.command || "/checkin");
    const task = {
      id: taskId, name: String(source.name).slice(0, 100), account_id: source.account_legacy_id, skill_id: skill.id,
      bot: String(source.target || (skillKey === "tg_signer" ? "tg_signer" : "@legacy_bot")), command,
      cron: String(source.cron), timezone: String(source.timezone), retry: integer(source.retry ?? 0, "retry", 0, 10),
      timeout_seconds: Math.min(integer(source.timeout_seconds ?? 120, "timeout_seconds", 5, 900), 900),
      thread_id: source.thread === undefined || source.thread === null ? null : integer(source.thread, "thread", 1, Number.MAX_SAFE_INTEGER),
      delete_after_seconds: source.delete_after === undefined || source.delete_after === null
        ? null
        : integer(source.delete_after, "delete_after", 0, 86_400),
      enabled: source.enabled === false ? 0 : 1,
      next_run_at: source.enabled === false ? null : nextCronDate(String(source.cron), String(source.timezone), now).toISOString(),
      created_at: now.toISOString(), updated_at: now.toISOString(),
    };
    validateTaskRuntime({ ...task, skill_key: skillKey });
    const signerImportValue = source.signer_import_base64 === undefined || source.signer_import_base64 === null
      ? null
      : String(source.signer_import_base64);
    if (signerImportValue && signerImportValue.length > 200_000) {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["tasks.signer_import_base64"] });
    }
    const signerImportSecret = skillKey === "tg_signer" && signerImportValue
      ? await createSecretRecord({
        env, ...context, ownerType: "task", ownerId: taskId,
        purpose: "tg_signer_import", value: signerImportValue,
      })
      : null;
    if (await repository.getTask(taskId)) {
      await repository.updateTask(taskId, task, {
        signerImportSecret,
        clearSignerImport: skillKey !== "tg_signer",
      });
    } else {
      await repository.createTask(task, signerImportSecret);
    }
  }
  if (body.notification?.enabled && body.notification.bot_token && body.notification.chat_id) {
    for (const [purpose, value] of [["bot_token", body.notification.bot_token], ["chat_id", body.notification.chat_id]]) {
      await repository.replaceOwnerSecret(await createSecretRecord({
        env, ...context, ownerType: "setting", ownerId: "telegram_notification", purpose, value: String(value),
      }));
    }
    await repository.updateSettings({ notifications_enabled: true }, now.toISOString());
  }
  return json({ ok: true, dry_run: false, accounts_planned: body.accounts.length, tasks_planned: body.tasks.length });
}

export async function handleRunnerApi(request, env, repository, context, claims) {
  const url = new URL(request.url);
  const prefix = "/api/runner/";
  if (!url.pathname.startsWith(prefix)) return null;
  if (url.pathname === "/api/runner/migrations/legacy") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return migrateLegacy(request, env, repository, context, claims);
  }
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  return await taskRoutes(request, env, repository, context, claims, parts)
    || await loginRoutes(request, env, repository, context, claims, parts)
    || (() => { throw new HttpError(404, "not_found", "Route not found."); })();
}
