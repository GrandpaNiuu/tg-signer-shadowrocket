import { assertCron } from "./cron.js";
import { HttpError } from "./http.js";

function fail(fields) {
  throw new HttpError(422, "validation_failed", "Request validation failed.", {
    fields: [...new Set(fields)].sort(),
  });
}

export function exactObject(value, allowed, required = []) {
  if (!value || Array.isArray(value) || typeof value !== "object") fail(["body"]);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(unknown);
  const missing = required.filter((key) => value[key] === undefined);
  if (missing.length) fail(missing);
  return value;
}

function stringField(value, field, { min = 1, max = 255, pattern, optional = false, nullable = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== "string") fail([field]);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || (pattern && !pattern.test(trimmed))) fail([field]);
  return trimmed;
}

function booleanField(value, field, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "boolean") fail([field]);
  return value;
}

function integerField(value, field, { min, max, optional = false, nullable = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail([field]);
  return value;
}

export function maskPhone(phone) {
  const normalized = stringField(phone, "phone", { min: 8, max: 16, pattern: /^\+[1-9]\d{6,14}$/ });
  const visiblePrefix = normalized.slice(0, Math.min(3, normalized.length - 4));
  return `${visiblePrefix}${"*".repeat(Math.max(3, normalized.length - visiblePrefix.length - 4))}${normalized.slice(-4)}`;
}

function proxyField(value, optional = true) {
  if (value === undefined && optional) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const proxy = stringField(value, "proxy", { min: 6, max: 2_048 });
    let url;
    try {
      url = new URL(proxy);
    } catch {
      fail(["proxy"]);
    }
    if (!["http:", "https:", "socks4:", "socks5:", "socks5h:"].includes(url.protocol)) fail(["proxy"]);
    return proxy;
  }
  exactObject(value, ["protocol", "host", "port", "username", "password"], ["protocol", "host", "port"]);
  const normalized = {
    protocol: stringField(value.protocol, "proxy.protocol", { pattern: /^(http|https|socks4|socks5|socks5h)$/ }),
    host: stringField(value.host, "proxy.host", { max: 253, pattern: /^[A-Za-z0-9._:-]+$/ }),
    port: integerField(value.port, "proxy.port", { min: 1, max: 65_535 }),
  };
  const username = stringField(value.username, "proxy.username", { max: 255, optional: true });
  const password = stringField(value.password, "proxy.password", { max: 1_024, optional: true });
  if (username !== undefined) normalized.username = username;
  if (password !== undefined) normalized.password = password;
  return JSON.stringify(normalized);
}

export function accountInput(body, { patch = false, sessionOptional = patch } = {}) {
  const allowed = ["name", "phone", "api_id", "api_hash", "session", "proxy", "enabled"];
  exactObject(body, allowed, patch ? [] : ["name", "phone"]);
  if (patch && Object.keys(body).length === 0) fail(["body"]);
  const output = {};
  const optional = patch;
  const name = stringField(body.name, "name", { max: 80, optional });
  const phone = stringField(body.phone, "phone", { min: 8, max: 16, pattern: /^\+[1-9]\d{6,14}$/, optional });
  const apiId = body.api_id === undefined ? undefined : stringField(String(body.api_id), "api_id", { min: 4, max: 12, pattern: /^\d+$/ });
  const apiHash = stringField(body.api_hash, "api_hash", { min: 32, max: 64, pattern: /^[a-fA-F0-9]+$/, optional: true });
  if (!patch && (apiId === undefined) !== (apiHash === undefined)) fail([apiId === undefined ? "api_id" : "api_hash"]);
  const session = stringField(body.session, "session", { min: 20, max: 16_384, optional: sessionOptional, nullable: true });
  const proxy = proxyField(body.proxy, true);
  const enabled = booleanField(body.enabled, "enabled", true);
  if (name !== undefined) output.name = name;
  if (phone !== undefined) output.phone = phone;
  if (apiId !== undefined) output.api_id = apiId;
  if (apiHash !== undefined) output.api_hash = apiHash;
  if (session !== undefined) output.session = session;
  if (proxy !== undefined) output.proxy = proxy;
  if (enabled !== undefined) output.enabled = enabled;
  return output;
}

export function taskInput(body, { patch = false, defaultTimezone = "Asia/Shanghai" } = {}) {
  const allowed = ["name", "account_id", "skill_key", "bot", "command", "cron", "timezone", "retry", "timeout_seconds", "thread_id", "delete_after_seconds", "enabled", "tg_signer_import"];
  exactObject(body, allowed, patch ? [] : ["name", "account_id", "skill_key", "bot", "command", "cron"]);
  if (patch && Object.keys(body).length === 0) fail(["body"]);
  const output = {};
  const optional = patch;
  for (const field of ["name", "account_id", "skill_key", "bot", "command"]) {
    const max = field === "command" ? 2_000 : field === "name" ? 100 : 128;
    const pattern = field === "skill_key" ? /^[a-z][a-z0-9_]{1,63}$/ : undefined;
    const value = stringField(body[field], field, { max, pattern, optional });
    if (value !== undefined) output[field] = value;
  }
  const timezone = stringField(body.timezone, "timezone", { max: 64, optional: true }) ?? (patch ? undefined : defaultTimezone);
  const cron = stringField(body.cron, "cron", { max: 100, optional });
  if (cron !== undefined || timezone !== undefined) {
    try {
      assertCron(cron ?? "* * * * *", timezone ?? defaultTimezone);
    } catch {
      fail([cron === undefined ? "timezone" : "cron"]);
    }
  }
  if (cron !== undefined) output.cron = cron;
  if (timezone !== undefined) output.timezone = timezone;
  const retry = integerField(body.retry, "retry", { min: 0, max: 10, optional: true });
  const timeout = integerField(body.timeout_seconds, "timeout_seconds", { min: 5, max: 900, optional: true });
  const thread = integerField(body.thread_id, "thread_id", { min: 1, max: Number.MAX_SAFE_INTEGER, optional: true, nullable: true });
  const deleteAfter = integerField(body.delete_after_seconds, "delete_after_seconds", { min: 0, max: 86_400, optional: true, nullable: true });
  const enabled = booleanField(body.enabled, "enabled", true);
  const signerImport = stringField(body.tg_signer_import, "tg_signer_import", {
    min: 1,
    max: 200_000,
    optional: true,
    nullable: true,
  });
  if (retry !== undefined) output.retry = retry;
  if (timeout !== undefined) output.timeout_seconds = timeout;
  if (thread !== undefined) output.thread_id = thread;
  if (deleteAfter !== undefined) output.delete_after_seconds = deleteAfter;
  if (enabled !== undefined) output.enabled = enabled;
  if (signerImport !== undefined) output.tg_signer_import = signerImport;
  return output;
}

export function validateTaskRuntime(input, current = {}) {
  const skillKey = input.skill_key ?? current.skill_key;
  const timeout = input.timeout_seconds ?? current.timeout_seconds ?? 120;
  const retry = input.retry ?? current.retry ?? 0;
  let retryBackoff = 0;
  for (let index = 0; index < retry; index += 1) retryBackoff += Math.min(60, 2 * (2 ** index));
  if (timeout * (retry + 1) + retryBackoff > 900) {
    fail(["retry", "timeout_seconds"]);
  }
  const deleteAfter = input.delete_after_seconds !== undefined
    ? input.delete_after_seconds
    : current.delete_after_seconds;
  if (skillKey === "send_text" && deleteAfter !== null && deleteAfter !== undefined
    && deleteAfter >= timeout - 10) {
    fail(["delete_after_seconds"]);
  }
  if (skillKey !== "tg_signer" && input.tg_signer_import !== undefined && input.tg_signer_import !== null) {
    fail(["tg_signer_import"]);
  }
}

export function settingsInput(body) {
  exactObject(body, ["values"], ["values"]);
  exactObject(body.values, ["scheduler_mode", "default_timezone", "notifications_enabled"]);
  if (Object.keys(body.values).length === 0) fail(["values"]);
  const values = {};
  if (body.values.scheduler_mode !== undefined) {
    values.scheduler_mode = stringField(body.values.scheduler_mode, "values.scheduler_mode", { pattern: /^d1$/ });
  }
  if (body.values.default_timezone !== undefined) {
    const timezone = stringField(body.values.default_timezone, "values.default_timezone", { max: 64 });
    try { assertCron("0 0 * * *", timezone); } catch { fail(["values.default_timezone"]); }
    values.default_timezone = timezone;
  }
  if (body.values.notifications_enabled !== undefined) {
    values.notifications_enabled = booleanField(body.values.notifications_enabled, "values.notifications_enabled");
  }
  return values;
}

export function telegramApplicationSettingsInput(body) {
  exactObject(body, ["api_id", "api_hash"], ["api_id", "api_hash"]);
  return {
    api_id: stringField(String(body.api_id ?? ""), "api_id", { min: 4, max: 12, pattern: /^\d+$/ }),
    api_hash: stringField(body.api_hash, "api_hash", { min: 32, max: 64, pattern: /^[a-fA-F0-9]+$/ }),
  };
}

export function loginStartInput(body) {
  exactObject(body, ["name", "phone", "api_id", "api_hash", "proxy"], ["phone"]);
  const phone = stringField(body.phone, "phone", { min: 8, max: 16, pattern: /^\+[1-9]\d{6,14}$/ });
  const name = stringField(body.name, "name", { max: 80, optional: true });
  const apiId = body.api_id === undefined
    ? undefined
    : stringField(String(body.api_id), "api_id", { min: 4, max: 12, pattern: /^\d+$/ });
  const apiHash = stringField(body.api_hash, "api_hash", {
    min: 32, max: 64, pattern: /^[a-fA-F0-9]+$/, optional: true,
  });
  if ((apiId === undefined) !== (apiHash === undefined)) fail([apiId === undefined ? "api_id" : "api_hash"]);
  const proxy = proxyField(body.proxy, true);
  return {
    name: name ?? `Telegram ••••${phone.slice(-4)}`,
    phone,
    ...(apiId === undefined ? {} : { api_id: apiId, api_hash: apiHash }),
    ...(proxy === undefined ? {} : { proxy }),
  };
}

export function secretInput(body, field) {
  exactObject(body, [field], [field]);
  return stringField(body[field], field, { min: field === "code" ? 3 : 1, max: field === "code" ? 16 : 1_024 });
}

export function idempotencyKey(request) {
  const value = request.headers.get("idempotency-key");
  if (typeof value !== "string" || value.length < 8 || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    fail(["Idempotency-Key"]);
  }
  return value;
}

export function runAttemptInput(body) {
  exactObject(body, ["attempt", "status", "duration_ms", "error_code", "error_message", "logs"], ["attempt", "status"]);
  return {
    attempt: integerField(body.attempt, "attempt", { min: 1, max: 11 }),
    status: stringField(body.status, "status", { pattern: /^(running|success|failed|ambiguous)$/ }),
    duration_ms: integerField(body.duration_ms, "duration_ms", { min: 0, max: 86_400_000, optional: true }),
    error_code: stringField(body.error_code, "error_code", { max: 100, optional: true }),
    error_message: stringField(body.error_message, "error_message", { max: 8_000, optional: true }),
    logs: body.logs,
  };
}

export function runCompleteInput(body) {
  exactObject(body, ["status", "duration_ms", "error_code", "error_message", "result", "logs"], ["status", "duration_ms"]);
  return {
    status: stringField(body.status, "status", { pattern: /^(success|failed|ambiguous|cancelled)$/ }),
    duration_ms: integerField(body.duration_ms, "duration_ms", { min: 0, max: 86_400_000 }),
    error_code: stringField(body.error_code, "error_code", { max: 100, optional: true }),
    error_message: stringField(body.error_message, "error_message", { max: 8_000, optional: true }),
    result: body.result,
    logs: body.logs,
  };
}
