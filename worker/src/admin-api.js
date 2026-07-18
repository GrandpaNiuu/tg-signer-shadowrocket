import { encryptSecret } from "./crypto.js";
import { nextCronDate } from "./cron.js";
import { dispatchWorkflow } from "./github.js";
import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { ACTIVE_LOGIN_STATUSES } from "./login-states.js";
import { enqueueAndDispatch } from "./scheduler.js";
import { resolveTelegramApplicationCredentialRefs } from "./telegram-application.js";
import {
  accountInput,
  exactObject,
  idempotencyKey,
  loginStartInput,
  maskPhone,
  secretInput,
  settingsInput,
  taskInput,
  telegramApplicationSettingsInput,
  validateTaskRuntime,
} from "./validation.js";

function iso(now) {
  return now().toISOString();
}

function requireRootKey(env) {
  if (!env.SECRET_ROOT_KEY) {
    throw new HttpError(500, "secret_key_missing", "Worker secret encryption is not configured.");
  }
  return env.SECRET_ROOT_KEY;
}

export async function createSecretRecord({ env, uuid, now, ownerType, ownerId, purpose, value, expiresAt = null }) {
  const encrypted = await encryptSecret(requireRootKey(env), value, {
    purpose,
    ownerId,
    keyVersion: Number(env.SECRET_KEY_VERSION || 1),
  });
  const timestamp = iso(now);
  return {
    id: uuid(),
    owner_type: ownerType,
    owner_id: ownerId,
    purpose,
    ...encrypted,
    expires_at: expiresAt,
    consumed_at: null,
    delivered_to_run_id: null,
    delivered_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function buildSecrets(input, context, ownerType, ownerId, { expiresAt = null } = {}) {
  const purposeMap = {
    phone: "phone",
    api_id: "api_id",
    api_hash: "api_hash",
    session: "telegram_session",
    proxy: "proxy",
  };
  const secrets = [];
  for (const [field, purpose] of Object.entries(purposeMap)) {
    const value = input[field];
    if (value !== undefined && value !== null) {
      secrets.push(await createSecretRecord({
        ...context,
        ownerType,
        ownerId,
        purpose,
        value,
        expiresAt,
      }));
    }
  }
  return secrets;
}

function listOptions(url) {
  const limitSource = url.searchParams.get("limit") || "50";
  const cursorSource = url.searchParams.get("cursor") || "0";
  if (!/^\d+$/.test(limitSource) || !/^\d+$/.test(cursorSource)) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["pagination"] });
  }
  const limit = Number(limitSource);
  const cursor = Number(cursorSource);
  if (limit < 1 || limit > 100 || !Number.isSafeInteger(cursor)) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["pagination"] });
  }
  return { limit, offset: cursor };
}

function page(items, { limit, offset }) {
  const hasMore = items.length > limit;
  return {
    data: items.slice(0, limit),
    pagination: {
      limit,
      next_cursor: hasMore ? String(offset + limit) : null,
    },
  };
}

function accountPath(parts) {
  return parts[0] === "accounts" && parts.length <= 3;
}

async function dispatchLoginFlow(env, context, flowId) {
  const result = await dispatchWorkflow(env, context.fetch, {
    workflow: env.LOGIN_WORKFLOW_FILE || "telegram-login.yml",
    inputs: { flow_id: flowId },
  });
  if (!result.ok) throw new Error(`GitHub dispatch returned HTTP ${result.status}.`);
}

async function startSessionValidation(env, repository, context, accountId) {
  const credentials = await repository.getAccountSecretRefs(accountId);
  if (!credentials) throw new HttpError(404, "account_not_found", "Account was not found.");
  if (!credentials.session_secret_id) {
    throw new HttpError(409, "account_credentials_incomplete", "Import a Session before validating this account.");
  }
  const active = await repository.getActiveLoginFlowForAccount(accountId);
  if (active) return active;
  const flowId = context.uuid();
  const timestamp = iso(context.now);
  const expiresAt = new Date(context.now().getTime() + 10 * 60_000).toISOString();
  const flow = await repository.createSessionValidationFlow(accountId, {
    id: flowId,
    expires_at: expiresAt,
    created_at: timestamp,
    updated_at: timestamp,
  });
  if (!flow) throw new HttpError(409, "account_credentials_incomplete", "Account credentials are incomplete.");
  try {
    await dispatchLoginFlow(env, context, flowId);
  } catch {
    await repository.failSessionValidationDispatch(flowId, iso(context.now));
    throw new HttpError(502, "validation_dispatch_failed", "The Telegram Session validation runner could not be started.");
  }
  return flow;
}

async function accounts(request, env, repository, context, parts, url) {
  if (!accountPath(parts)) return null;
  const id = parts[1];
  const action = parts[2];
  if (!id) {
    if (request.method === "GET") {
      const options = listOptions(url);
      return json(page(await repository.listAccounts({ ...options, limit: options.limit + 1 }), options));
    }
    if (request.method === "POST") {
      const input = accountInput(await readJson(request));
      const id = context.uuid();
      const timestamp = iso(context.now);
      const secrets = await buildSecrets(input, { env, ...context }, "account", id);
      const account = await repository.createAccount({
        account: {
          id,
          name: input.name,
          phone_masked: maskPhone(input.phone),
          status: "disconnected",
          enabled: input.enabled === false ? 0 : 1,
          last_connected_at: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
        secrets,
      });
      return json({ data: account }, 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  if (action === "validate" && parts.length === 3) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    exactObject(await readJson(request), []);
    return json({ data: await startSessionValidation(env, repository, context, id) }, 202);
  }
  if (action) return null;

  if (request.method === "GET") {
    const account = await repository.getAccount(id);
    if (!account) throw new HttpError(404, "account_not_found", "Account was not found.");
    return json({ data: account });
  }
  if (request.method === "PATCH") {
    const input = accountInput(await readJson(request), { patch: true });
    const timestamp = iso(context.now);
    const secrets = await buildSecrets(input, { env, ...context }, "account", id);
    const clearSecrets = Object.entries({
      session: "telegram_session",
      proxy: "proxy",
    }).filter(([field]) => input[field] === null).map(([, purpose]) => purpose);
    const changes = { updated_at: timestamp };
    if (input.name !== undefined) changes.name = input.name;
    if (input.phone !== undefined) changes.phone_masked = maskPhone(input.phone);
    if (input.enabled !== undefined) changes.enabled = input.enabled ? 1 : 0;
    if (["session", "api_id", "api_hash", "proxy"].some((field) => input[field] !== undefined)) {
      changes.status = "disconnected";
      changes.last_connected_at = null;
    }
    const account = await repository.updateAccount(id, { changes, secrets, clearSecrets });
    if (!account) throw new HttpError(404, "account_not_found", "Account was not found.");
    return json({ data: account });
  }
  if (request.method === "DELETE") {
    const outcome = await repository.deleteAccount(id);
    if (outcome.blocked) throw new HttpError(409, "account_in_use", "Delete this account's tasks before deleting the account.");
    if (!outcome.deleted) throw new HttpError(404, "account_not_found", "Account was not found.");
    return new Response(null, { status: 204 });
  }
  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

function booleanQuery(url, name) {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: [name] });
}

async function tasks(request, env, repository, context, parts, url) {
  if (parts[0] !== "tasks") return null;
  const id = parts[1];
  if (id && parts[2] === "runs" && parts.length === 3) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const requestKey = idempotencyKey(request);
    const task = await repository.getTask(id);
    if (!task) throw new HttpError(404, "task_not_found", "Task was not found.");
    const dedupeKey = `manual:${task.id}:${requestKey}`;
    const prior = await repository.getRunByDedupeKey(dedupeKey);
    if (prior) {
      return json({ data: prior }, 202);
    }
    if (!task.enabled) throw new HttpError(409, "task_disabled", "Enable the task before running it.");
    const scheduledFor = iso(context.now);
    const result = await enqueueAndDispatch(task, env, {
      repository,
      fetch: context.fetch,
      uuid: context.uuid,
      now: context.now,
    }, { triggerType: "manual", scheduledFor, nextRunAt: undefined, dedupeKey });
    if (!result.created && result.reason === "not_executable") {
      throw new HttpError(409, "account_unavailable", "The task account must be enabled and connected.");
    }
    return json({ data: {
      id: result.run.id,
      task_id: task.id,
      trigger_type: "manual",
      status: result.run.status || "queued",
      dispatch_status: result.run.dispatch_status || (result.dispatched ? "dispatched" : "pending"),
      scheduled_for: result.run.scheduled_for || scheduledFor,
      created_at: result.run.created_at,
    } }, 202);
  }
  if (parts.length > 2) return null;

  if (!id) {
    if (request.method === "GET") {
      const options = listOptions(url);
      const accountId = url.searchParams.get("account_id") || undefined;
      const enabled = booleanQuery(url, "enabled");
      const items = await repository.listTasks({ ...options, limit: options.limit + 1, accountId, enabled });
      return json(page(items, options));
    }
    if (request.method === "POST") {
      const settings = await repository.getSettings();
      const input = taskInput(await readJson(request, 256_000), { defaultTimezone: settings.default_timezone || "Asia/Shanghai" });
      const account = await repository.getAccount(input.account_id);
      if (!account) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["account_id"] });
      const skill = await repository.getSkillByKey(input.skill_key);
      if (!skill) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["skill_key"] });
      validateTaskRuntime(input);
      const timestamp = iso(context.now);
      const enabled = input.enabled !== false;
      const taskId = context.uuid();
      const signerImportSecret = input.tg_signer_import
        ? await createSecretRecord({
          env,
          ...context,
          ownerType: "task",
          ownerId: taskId,
          purpose: "tg_signer_import",
          value: input.tg_signer_import,
        })
        : null;
      const task = await repository.createTask({
        id: taskId,
        name: input.name,
        account_id: input.account_id,
        skill_id: skill.id,
        bot: input.bot,
        command: input.command,
        cron: input.cron,
        timezone: input.timezone,
        retry: input.retry ?? 0,
        timeout_seconds: input.timeout_seconds ?? 120,
        thread_id: input.thread_id ?? null,
        delete_after_seconds: input.delete_after_seconds ?? null,
        enabled: enabled ? 1 : 0,
        next_run_at: enabled ? nextCronDate(input.cron, input.timezone, context.now()).toISOString() : null,
        created_at: timestamp,
        updated_at: timestamp,
      }, signerImportSecret);
      return json({ data: task }, 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  if (request.method === "GET") {
    const task = await repository.getTask(id);
    if (!task) throw new HttpError(404, "task_not_found", "Task was not found.");
    return json({ data: task });
  }
  if (request.method === "PATCH") {
    const current = await repository.getTask(id);
    if (!current) throw new HttpError(404, "task_not_found", "Task was not found.");
    const input = taskInput(await readJson(request, 256_000), { patch: true, defaultTimezone: current.timezone });
    validateTaskRuntime(input, current);
    const values = { ...input, updated_at: iso(context.now) };
    delete values.skill_key;
    delete values.tg_signer_import;
    if (input.account_id !== undefined && !await repository.getAccount(input.account_id)) {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["account_id"] });
    }
    if (input.skill_key !== undefined) {
      const skill = await repository.getSkillByKey(input.skill_key);
      if (!skill) throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["skill_key"] });
      values.skill_id = skill.id;
    }
    const finalSkillKey = input.skill_key ?? current.skill_key;
    const signerImportSecret = typeof input.tg_signer_import === "string"
      ? await createSecretRecord({
        env,
        ...context,
        ownerType: "task",
        ownerId: id,
        purpose: "tg_signer_import",
        value: input.tg_signer_import,
      })
      : null;
    if (input.enabled !== undefined) values.enabled = input.enabled ? 1 : 0;
    const finalEnabled = input.enabled ?? current.enabled;
    if (!finalEnabled) {
      values.next_run_at = null;
    } else if (input.enabled === true || input.cron !== undefined || input.timezone !== undefined) {
      values.next_run_at = nextCronDate(input.cron || current.cron, input.timezone || current.timezone, context.now()).toISOString();
    }
    const task = await repository.updateTask(id, values, {
      signerImportSecret,
      clearSignerImport: input.tg_signer_import === null || finalSkillKey !== "tg_signer",
    });
    return json({ data: task });
  }
  if (request.method === "DELETE") {
    const outcome = await repository.deleteTask(id, iso(context.now));
    if (outcome.blocked) throw new HttpError(409, "task_running", "Wait for the active task run to finish before deleting this task.");
    if (!outcome.deleted) throw new HttpError(404, "task_not_found", "Task was not found.");
    return new Response(null, { status: 204 });
  }
  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

async function skills(request, repository, parts) {
  if (parts[0] !== "skills" || parts.length !== 1) return null;
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  return json({ data: await repository.listSkills() });
}

function localDayStart(now, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const current = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day), Number(current.hour), Number(current.minute), Number(current.second));
  const offset = localAsUtc - now.getTime();
  return new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day)) - offset).toISOString();
}

async function dashboard(request, repository, context, parts) {
  if (parts[0] !== "dashboard" || parts.length !== 1) return null;
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const settings = await repository.getSettings();
  const start = localDayStart(context.now(), settings.default_timezone || "Asia/Shanghai");
  return json({ data: await repository.dashboard(start) });
}

async function runs(request, repository, parts, url) {
  if (parts[0] !== "task-runs" || parts.length > 2) return null;
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (parts[1]) {
    const run = await repository.getRun(parts[1]);
    if (!run) throw new HttpError(404, "run_not_found", "Task run was not found.");
    return json({ data: run });
  }
  const options = listOptions(url);
  const taskId = url.searchParams.get("task_id") || undefined;
  const status = url.searchParams.get("status") || undefined;
  if (status && !/^(queued|claimed|running|success|failed|cancelled|ambiguous)$/.test(status)) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["status"] });
  }
  const items = await repository.listRuns({ ...options, limit: options.limit + 1, taskId, status });
  return json(page(items, options));
}

function notificationSettingsInput(body) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: ["body"] });
  }
  const allowed = ["bot_token", "chat_id"];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length || Object.keys(body).length === 0) {
    throw new HttpError(422, "validation_failed", "Request validation failed.", {
      fields: (unknown.length ? unknown : ["body"]).sort(),
    });
  }
  const output = {};
  for (const field of allowed) {
    if (body[field] === undefined) continue;
    if (body[field] === null) {
      output[field] = null;
      continue;
    }
    if (typeof body[field] !== "string") {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: [field] });
    }
    const value = body[field].trim();
    const valid = field === "bot_token"
      ? /^\d{5,16}:[A-Za-z0-9_-]{20,128}$/.test(value)
      : /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(value);
    if (!valid) {
      throw new HttpError(422, "validation_failed", "Request validation failed.", { fields: [field] });
    }
    output[field] = value;
  }
  return output;
}

async function settingsSnapshot(repository) {
  const [values, notificationStatus, telegramApplicationStatus] = await Promise.all([
    repository.getSettings(),
    repository.getNotificationSecretStatus(),
    repository.getTelegramApplicationStatus(),
  ]);
  return { ...values, ...notificationStatus, ...telegramApplicationStatus };
}

async function settings(request, env, repository, context, parts) {
  if (parts[0] !== "settings" || parts.length > 2) return null;
  if (parts.length === 2) {
    if (parts[1] === "telegram") {
      if (request.method !== "PATCH") return methodNotAllowed(["PATCH"]);
      if (context.identity?.role !== "admin") {
        throw new HttpError(403, "administrator_required", "??????????? Telegram ?????");
      }
      const input = telegramApplicationSettingsInput(await readJson(request, 16_000));
      const secrets = await Promise.all(Object.entries(input).map(([purpose, value]) => createSecretRecord({
        env,
        ...context,
        ownerType: "setting",
        ownerId: "telegram_application",
        purpose,
        value,
      })));
      return json({ data: await repository.updateTelegramApplicationSecrets(secrets) });
    }
    if (parts[1] !== "notifications") return null;
    if (request.method !== "PATCH") return methodNotAllowed(["PATCH"]);
    if (context.identity?.role !== "admin") {
      throw new HttpError(403, "administrator_required", "????????????????");
    }
    const input = notificationSettingsInput(await readJson(request, 16_000));
    const purposeMap = { bot_token: "bot_token", chat_id: "chat_id" };
    const secrets = [];
    const clearPurposes = [];
    for (const [field, purpose] of Object.entries(purposeMap)) {
      if (input[field] === null) clearPurposes.push(purpose);
      else if (input[field] !== undefined) {
        secrets.push(await createSecretRecord({
          env,
          ...context,
          ownerType: "setting",
          ownerId: "telegram_notification",
          purpose,
          value: input[field],
        }));
      }
    }
    return json({ data: await repository.updateNotificationSecrets({ secrets, clearPurposes }) });
  }
  if (request.method === "GET") return json({ data: await settingsSnapshot(repository) });
  if (request.method === "PATCH") {
    if (context.identity?.role !== "admin") {
      throw new HttpError(403, "administrator_required", "????????????????");
    }
    const values = settingsInput(await readJson(request));
    await repository.updateSettings(values, iso(context.now));
    return json({ data: await settingsSnapshot(repository) });
  }
  return methodNotAllowed(["GET", "PATCH"]);
}

async function loginFlows(request, env, repository, context, parts) {
  if (parts[0] !== "login-flows") return null;
  const id = parts[1];
  const action = parts[2];
  if (!id) {
    if (parts.length !== 1) return null;
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const input = loginStartInput(await readJson(request));
    if (!input.api_id && !await resolveTelegramApplicationCredentialRefs(repository)) {
      throw new HttpError(409, "telegram_application_not_configured", "???? Telegram ????????????", {
        action: "configure_telegram_application",
        settings_path: "#/settings",
        documentation_url: "https://my.telegram.org/apps",
      });
    }
    const accountId = context.uuid();
    const flowId = context.uuid();
    const timestamp = iso(context.now);
    const expiresAt = new Date(context.now().getTime() + 15 * 60_000).toISOString();
    const secrets = await buildSecrets(input, { env, ...context }, "account", accountId);
    let flow = await repository.createLoginFlow({
      account: {
        id: accountId,
        name: input.name,
        phone_masked: maskPhone(input.phone),
        created_at: timestamp,
        updated_at: timestamp,
      },
      secrets,
      flow: { id: flowId, expires_at: expiresAt, created_at: timestamp, updated_at: timestamp },
    });
    try {
      await dispatchLoginFlow(env, context, flowId);
    } catch (error) {
      await repository.deleteProvisionalLoginFlow(flowId, ["created"], iso(context.now));
      throw new HttpError(502, "login_dispatch_failed", "The Telegram login runner could not be started.");
    }
    return json({ data: flow }, 202);
  }
  if (!action && parts.length === 2) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    let flow = await repository.getLoginFlow(id);
    if (!flow) throw new HttpError(404, "login_flow_not_found", "Login flow was not found.");
    if (ACTIVE_LOGIN_STATUSES.includes(flow.status) && flow.expires_at <= iso(context.now)) {
      flow = await repository.expireLoginFlow(id, iso(context.now));
    }
    return json({ data: flow });
  }
  if (parts.length !== 3 || request.method !== "POST") return action ? methodNotAllowed(["POST"]) : null;
  if (action === "cancel") {
    exactObject(await readJson(request), []);
    const flow = await repository.deleteProvisionalLoginFlow(id, ACTIVE_LOGIN_STATUSES, iso(context.now));
    if (!flow) throw new HttpError(409, "login_state_conflict", "Login flow cannot be cancelled in its current state.");
    return json({ data: flow });
  }
  if (action === "resend") {
    exactObject(await readJson(request), []);
    const flow = await repository.requestLoginCodeResend(id, iso(context.now));
    if (!flow) throw new HttpError(409, "login_state_conflict", "Login flow is not waiting for a verification code.");
    return json({ data: flow }, 202);
  }
  if (action === "code" || action === "password") {
    const value = secretInput(await readJson(request), action);
    const timestamp = iso(context.now);
    const current = await repository.getLoginFlow(id);
    if (!current) throw new HttpError(404, "login_flow_not_found", "Login flow was not found.");
    const secret = await createSecretRecord({
      env,
      ...context,
      ownerType: "login_flow",
      ownerId: id,
      purpose: action === "code" ? "login_code" : "two_factor_password",
      value,
      expiresAt: current.expires_at,
    });
    const flow = await repository.submitLoginSecret(
      id,
      secret,
      action === "code" ? "code_required" : "password_required",
      action === "code" ? "code_submitted" : "password_submitted",
      action === "code" ? "code_secret_id" : "password_secret_id",
    );
    if (!flow) throw new HttpError(409, "login_state_conflict", `Login flow is not waiting for ${action}.`);
    return json({ data: flow });
  }
  return null;
}

export async function handleAdminApi(request, env, repository, context) {
  const url = new URL(request.url);
  const prefix = "/api/v1/";
  if (!url.pathname.startsWith(prefix)) return null;
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  for (const handler of [
    () => dashboard(request, repository, context, parts),
    () => accounts(request, env, repository, context, parts, url),
    () => tasks(request, env, repository, context, parts, url),
    () => skills(request, repository, parts),
    () => runs(request, repository, parts, url),
    () => settings(request, env, repository, context, parts),
    () => loginFlows(request, env, repository, context, parts),
  ]) {
    const response = await handler();
    if (response) return response;
  }
  throw new HttpError(404, "not_found", "Route not found.");
}
