import { decryptSecret, rootKeyForVersion } from "./crypto.js";
import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { sanitizeLogText } from "./redaction.js";
import { sendRealtimeNotification } from "./notifications.js";
import { assertRealtimeTransitionAllowed } from "./realtime-repository.js";
import { resolveTelegramApplicationCredentialRefs } from "./telegram-application.js";

const INSPECTION_STATUSES = new Set(["queued", "running", "success", "failed", "expired", "cancelled"]);
const RULE_KINDS = new Set(["keyword_reply", "group_monitor"]);
const REPLY_TRIGGER_MODES = new Set(["keyword", "reply_to_own", "keyword_or_reply_to_own"]);
const LISTENER_STATUSES = new Set(["starting", "online", "degraded", "stopping", "offline"]);
const TARGET_PATTERN = /^(?:\*|@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{1,20})$/;

function rows(result) {
  return result?.results || [];
}

function nowIso(context) {
  return context.now().toISOString();
}

function objectBody(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "请求内容格式不正确。", { fields: ["body"] });
  }
  return value;
}

function text(value, field, { required = true, maximum = 500 } = {}) {
  const output = String(value ?? "").trim();
  if (required && !output) {
    throw new HttpError(422, "validation_failed", "请检查填写内容。", { fields: [field] });
  }
  if (output.length > maximum) {
    throw new HttpError(422, "validation_failed", "填写内容过长。", { fields: [field] });
  }
  return output;
}

function booleanValue(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

function integer(value, field, minimum, maximum, fallback) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(422, "validation_failed", "请检查填写内容。", { fields: [field] });
  }
  return parsed;
}

function requireAdministrator(context) {
  if (context.identity?.role !== "admin") {
    throw new HttpError(403, "administrator_required", "只有平台管理员可以使用实时监听功能。");
  }
}

export function normalizeTelegramTarget(value, field = "target", { allowWildcard = false } = {}) {
  const target = text(value, field, { maximum: 128 });
  if ((!allowWildcard && target === "*") || !TARGET_PATTERN.test(target)) {
    throw new HttpError(422, "validation_failed", "请输入 @用户名、数字 Chat ID。管理员监听范围也可以填写 *。", { fields: [field] });
  }
  return target;
}

function mapInspection(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  return {
    id: row.id,
    account_id: row.account_id,
    target: row.target,
    start_command: row.start_command,
    wait_seconds: row.wait_seconds,
    status: row.status,
    result,
    error_code: row.error_code,
    error_message: row.error_message,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    kind: row.kind,
    name: row.name,
    chat_selector: row.chat_selector,
    keyword: row.keyword,
    response_text: row.response_text,
    trigger_mode: row.trigger_mode || "keyword",
    case_sensitive: Boolean(row.case_sensitive),
    notify_on_match: row.notify_on_match === undefined ? true : Boolean(row.notify_on_match),
    enabled: Boolean(row.enabled),
    last_event_at: row.last_event_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function ownedConnectedAccount(repository, userId, accountId) {
  return repository.db.prepare(`SELECT id, user_id, name, status, enabled, session_secret_id,
    api_id_secret_id, api_hash_secret_id, proxy_secret_id
    FROM accounts WHERE id = ? AND user_id = ? AND enabled = 1 AND status = 'connected'`)
    .bind(accountId, userId).first();
}

async function createInspection(request, repository, context) {
  const body = objectBody(await readJson(request, 16_000));
  const accountId = text(body.account_id, "account_id", { maximum: 160 });
  const target = normalizeTelegramTarget(body.target);
  const startCommand = text(body.start_command ?? "/start", "start_command", { maximum: 2_000 });
  const waitSeconds = integer(body.wait_seconds, "wait_seconds", 5, 60, 30);
  const userId = context.identity?.user_id || repository.userId;
  const account = await ownedConnectedAccount(repository, userId, accountId);
  if (!account) {
    throw new HttpError(422, "account_unavailable", "请选择当前工作区中已连接并启用的 Telegram 账号。", { fields: ["account_id"] });
  }

  const timestamp = nowIso(context);
  const active = await repository.db.prepare(`SELECT id FROM bot_inspections
    WHERE account_id = ? AND user_id = ? AND status IN ('queued', 'running') AND expires_at > ? LIMIT 1`)
    .bind(accountId, userId, timestamp).first();
  if (active) {
    throw new HttpError(409, "inspection_already_active", "这个账号已有一项识别任务正在进行，请等待结果。", { inspection_id: active.id });
  }
  const dayStart = new Date(context.now().getTime() - 24 * 60 * 60_000).toISOString();
  const recent = await repository.db.prepare(`SELECT COUNT(*) AS total FROM bot_inspections
    WHERE user_id = ? AND created_at >= ?`).bind(userId, dayStart).first();
  if (Number(recent?.total || 0) >= 20) {
    throw new HttpError(429, "inspection_rate_limited", "每天最多识别 20 次机器人操作，请稍后再试。" );
  }

  const id = context.uuid();
  const expiresAt = new Date(context.now().getTime() + 5 * 60_000).toISOString();
  await repository.db.prepare(`INSERT INTO bot_inspections
    (id, user_id, account_id, target, start_command, wait_seconds, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
    .bind(id, userId, accountId, target, startCommand, waitSeconds, expiresAt, timestamp, timestamp).run();
  return json({ data: mapInspection(await repository.db.prepare(
    "SELECT * FROM bot_inspections WHERE id = ? AND user_id = ?",
  ).bind(id, userId).first()) }, 202);
}

async function inspections(request, repository, context, parts, url) {
  if (parts[0] !== "bot-inspections") return null;
  const userId = context.identity?.user_id || repository.userId;
  const id = parts[1];
  if (!id) {
    if (request.method === "POST") return createInspection(request, repository, context);
    if (request.method !== "GET") return methodNotAllowed(["GET", "POST"]);
    const limit = integer(url.searchParams.get("limit") || 20, "limit", 1, 50, 20);
    const result = await repository.db.prepare(`SELECT * FROM bot_inspections
      WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).bind(userId, limit).all();
    return json({ data: rows(result).map(mapInspection) });
  }
  if (parts.length !== 2) return null;
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const row = await repository.db.prepare("SELECT * FROM bot_inspections WHERE id = ? AND user_id = ?")
    .bind(id, userId).first();
  if (!row) throw new HttpError(404, "inspection_not_found", "没有找到这次机器人识别记录。" );
  return json({ data: mapInspection(row) });
}

function ruleInput(body, { patch = false } = {}) {
  const value = objectBody(body);
  const output = {};
  if (!patch || value.account_id !== undefined) output.account_id = text(value.account_id, "account_id", { maximum: 160 });
  if (!patch || value.kind !== undefined) {
    output.kind = text(value.kind, "kind", { maximum: 40 });
    if (!RULE_KINDS.has(output.kind)) {
      throw new HttpError(422, "validation_failed", "实时规则类型不受支持。", { fields: ["kind"] });
    }
  }
  if (!patch || value.name !== undefined) output.name = text(value.name, "name", { maximum: 100 });
  if (!patch || value.chat_selector !== undefined) {
    output.chat_selector = normalizeTelegramTarget(value.chat_selector ?? "*", "chat_selector", { allowWildcard: true });
  }
  if (!patch || value.keyword !== undefined) output.keyword = text(value.keyword ?? "", "keyword", { required: false, maximum: 200 });
  if (!patch || value.response_text !== undefined) {
    output.response_text = value.response_text === null
      ? null
      : text(value.response_text ?? "", "response_text", { required: false, maximum: 2_000 });
  }
  if (!patch || value.trigger_mode !== undefined) {
    output.trigger_mode = text(value.trigger_mode ?? "keyword", "trigger_mode", { maximum: 40 });
    if (!REPLY_TRIGGER_MODES.has(output.trigger_mode)) {
      throw new HttpError(422, "validation_failed", "自动回复触发方式不受支持。", { fields: ["trigger_mode"] });
    }
  }
  if (!patch || value.case_sensitive !== undefined) output.case_sensitive = booleanValue(value.case_sensitive, false);
  if (!patch || value.notify_on_match !== undefined) output.notify_on_match = booleanValue(value.notify_on_match, true);
  if (!patch || value.enabled !== undefined) output.enabled = booleanValue(value.enabled, true);
  const finalKind = output.kind ?? value.kind;
  if (finalKind === "keyword_reply") {
    const triggerMode = output.trigger_mode ?? value.trigger_mode ?? "keyword";
    if (["keyword", "keyword_or_reply_to_own"].includes(triggerMode) && !output.keyword && !patch) {
      throw new HttpError(422, "validation_failed", "关键词自动回复必须填写关键词。", { fields: ["keyword"] });
    }
    if (!output.response_text && !patch) {
      throw new HttpError(422, "validation_failed", "关键词自动回复必须填写回复内容。", { fields: ["response_text"] });
    }
  } else if (output.trigger_mode && output.trigger_mode !== "keyword") {
    throw new HttpError(422, "validation_failed", "消息监控只能使用关键词匹配。", { fields: ["trigger_mode"] });
  }
  return output;
}

async function ensureRealtimeAdminAccountAvailable(repository, context, accountId) {
  const userId = context.identity?.user_id;
  const account = await ownedConnectedAccount(repository, userId, accountId);
  if (!account) {
    throw new HttpError(422, "account_unavailable", "请选择管理员工作区中已连接并启用的 Telegram 账号。", { fields: ["account_id"] });
  }
  await assertRealtimeTransitionAllowed(repository, accountId);
  return account;
}

async function realtimeRules(request, repository, context, parts) {
  if (parts[0] !== "admin" || parts[1] !== "realtime-rules") return null;
  requireAdministrator(context);
  const id = parts[2];
  const userId = context.identity.user_id;
  if (!id) {
    if (request.method === "GET") {
      const result = await repository.db.prepare(`SELECT r.*, a.name AS account_name FROM realtime_rules r
        JOIN accounts a ON a.id = r.account_id WHERE r.user_id = ? ORDER BY r.created_at DESC`)
        .bind(userId).all();
      return json({ data: rows(result).map(mapRule) });
    }
    if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
    const input = ruleInput(await readJson(request, 32_000));
    await ensureRealtimeAdminAccountAvailable(repository, context, input.account_id);
    const timestamp = nowIso(context);
    const rule = {
      id: context.uuid(),
      ...input,
      response_text: input.kind === "keyword_reply" ? input.response_text : input.response_text || null,
      trigger_mode: input.kind === "keyword_reply" ? input.trigger_mode : "keyword",
    };
    await repository.db.prepare(`INSERT INTO realtime_rules
      (id, user_id, account_id, kind, name, chat_selector, keyword, response_text, trigger_mode, case_sensitive, notify_on_match, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(rule.id, userId, rule.account_id, rule.kind, rule.name, rule.chat_selector, rule.keyword,
        rule.response_text, rule.trigger_mode, rule.case_sensitive ? 1 : 0, rule.notify_on_match ? 1 : 0,
        rule.enabled ? 1 : 0, timestamp, timestamp).run();
    const created = await repository.db.prepare(`SELECT r.*, a.name AS account_name FROM realtime_rules r
      JOIN accounts a ON a.id = r.account_id WHERE r.id = ? AND r.user_id = ?`).bind(rule.id, userId).first();
    return json({ data: mapRule(created) }, 201);
  }
  if (parts.length !== 3) return null;
  const current = await repository.db.prepare("SELECT * FROM realtime_rules WHERE id = ? AND user_id = ?")
    .bind(id, userId).first();
  if (!current) throw new HttpError(404, "realtime_rule_not_found", "没有找到这条实时规则。" );
  if (request.method === "DELETE") {
    await repository.db.prepare("DELETE FROM realtime_rules WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return new Response(null, { status: 204 });
  }
  if (request.method !== "PATCH") return methodNotAllowed(["PATCH", "DELETE"]);
  const input = ruleInput(await readJson(request, 32_000), { patch: true });
  const finalAccountId = input.account_id ?? current.account_id;
  await ensureRealtimeAdminAccountAvailable(repository, context, finalAccountId);
  const finalKind = input.kind ?? current.kind;
  const finalTriggerMode = finalKind === "keyword_reply"
    ? input.trigger_mode ?? current.trigger_mode ?? "keyword"
    : "keyword";
  const finalKeyword = input.keyword ?? current.keyword;
  const finalResponse = input.response_text === undefined ? current.response_text : input.response_text;
  if (finalKind === "keyword_reply" && !finalResponse) {
    throw new HttpError(422, "validation_failed", "自动回复必须填写回复内容。", { fields: ["response_text"] });
  }
  if (finalKind === "keyword_reply"
    && ["keyword", "keyword_or_reply_to_own"].includes(finalTriggerMode)
    && !finalKeyword) {
    throw new HttpError(422, "validation_failed", "这个触发方式必须填写关键词。", { fields: ["keyword"] });
  }
  const merged = {
    account_id: finalAccountId,
    kind: finalKind,
    name: input.name ?? current.name,
    chat_selector: input.chat_selector ?? current.chat_selector,
    keyword: finalKeyword,
    response_text: finalResponse,
    trigger_mode: finalTriggerMode,
    case_sensitive: input.case_sensitive ?? Boolean(current.case_sensitive),
    notify_on_match: input.notify_on_match ?? (current.notify_on_match === undefined ? true : Boolean(current.notify_on_match)),
    enabled: input.enabled ?? Boolean(current.enabled),
  };
  const timestamp = nowIso(context);
  await repository.db.prepare(`UPDATE realtime_rules SET account_id = ?, kind = ?, name = ?, chat_selector = ?,
    keyword = ?, response_text = ?, trigger_mode = ?, case_sensitive = ?, notify_on_match = ?, enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .bind(merged.account_id, merged.kind, merged.name, merged.chat_selector, merged.keyword, merged.response_text,
      merged.trigger_mode, merged.case_sensitive ? 1 : 0, merged.notify_on_match ? 1 : 0,
      merged.enabled ? 1 : 0, timestamp, id, userId).run();
  const updated = await repository.db.prepare(`SELECT r.*, a.name AS account_name FROM realtime_rules r
    JOIN accounts a ON a.id = r.account_id WHERE r.id = ? AND r.user_id = ?`).bind(id, userId).first();
  return json({ data: mapRule(updated) });
}

async function listenerAdminStatus(request, repository, context, parts) {
  if (parts[0] !== "admin" || !["listener-status", "listener-events"].includes(parts[1])) return null;
  requireAdministrator(context);
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (parts[1] === "listener-events") {
    const result = await repository.db.prepare(`SELECT e.*, r.name AS rule_name, a.name AS account_name
      FROM listener_events e LEFT JOIN realtime_rules r ON r.id = e.rule_id
      LEFT JOIN accounts a ON a.id = e.account_id ORDER BY e.created_at DESC LIMIT 100`).all();
    return json({ data: rows(result) });
  }
  const instance = await repository.db.prepare("SELECT * FROM listener_instances ORDER BY last_heartbeat_at DESC LIMIT 1").first();
  const counts = await repository.db.prepare(`SELECT
    (SELECT COUNT(*) FROM realtime_rules WHERE user_id = ? AND enabled = 1) AS active_rules,
    (SELECT COUNT(DISTINCT account_id) FROM realtime_rules WHERE user_id = ? AND enabled = 1) AS active_accounts`)
    .bind(context.identity.user_id, context.identity.user_id).first();
  const online = Boolean(instance?.last_heartbeat_at)
    && context.now().getTime() - Date.parse(instance.last_heartbeat_at) < 150_000;
  return json({ data: {
    configured: String(context.env?.LISTENER_API_TOKEN || "").length >= 32,
    online,
    instance: instance ? { ...instance, online } : null,
    active_rules: Number(counts?.active_rules || 0),
    active_accounts: Number(counts?.active_accounts || 0),
  } });
}

export async function handleWorkspaceRealtimeApi(request, env, repository, context) {
  const url = new URL(request.url);
  const prefix = "/api/v1/";
  if (!url.pathname.startsWith(prefix)) return null;
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  const localContext = { ...context, env };
  for (const handler of [
    () => inspections(request, repository, localContext, parts, url),
    () => realtimeRules(request, repository, localContext, parts),
    () => listenerAdminStatus(request, repository, localContext, parts),
  ]) {
    const response = await handler();
    if (response) return response;
  }
  if (context.identity?.role !== "admin"
    && parts[0] === "accounts"
    && ((parts[1] === "validate-all" && parts.length === 2) || (parts[2] === "validate" && parts.length === 3))) {
    throw new HttpError(403, "administrator_required", "只有平台管理员可以运行账号连接检测。" );
  }
  return null;
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function secureEqual(left, right) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  if (a.length !== b.length) return false;
  let different = 0;
  for (let index = 0; index < a.length; index += 1) different |= a[index] ^ b[index];
  return different === 0;
}

async function verifyListener(request, env) {
  const configured = String(env.LISTENER_API_TOKEN || "").trim();
  if (configured.length < 32) {
    throw new HttpError(503, "listener_not_configured", "常驻 Listener 尚未配置。" );
  }
  const header = String(request.headers.get("authorization") || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!supplied || !await secureEqual(supplied, configured)) {
    throw new HttpError(401, "listener_unauthorized", "Listener authentication failed." );
  }
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

async function listenerAccount(repository, env, accountId) {
  const account = await repository.db.prepare(`SELECT id, user_id, name, status, enabled, session_secret_id,
    api_id_secret_id, api_hash_secret_id, proxy_secret_id FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!account || account.status !== "connected" || !account.enabled) {
    throw new HttpError(409, "account_unavailable", "Listener account is unavailable." );
  }
  const application = await resolveTelegramApplicationCredentialRefs(repository, account);
  const session = await plaintext(repository, env, account.session_secret_id, "telegram_session", account.id, { required: true });
  const apiId = await plaintext(repository, env, application?.apiIdSecretId, "api_id", application?.ownerId, { required: true });
  const apiHash = await plaintext(repository, env, application?.apiHashSecretId, "api_hash", application?.ownerId, { required: true });
  const proxy = await plaintext(repository, env, account.proxy_secret_id, "proxy", account.id);
  return {
    id: account.id,
    name: account.name,
    session_string: session,
    api_id: Number(apiId),
    api_hash: apiHash,
    ...(proxy ? { proxy } : {}),
  };
}

async function listenerConfig(repository, env) {
  const result = await repository.db.prepare(`SELECT r.*, a.name AS account_name FROM realtime_rules r
    JOIN users u ON u.id = r.user_id AND u.role = 'admin' AND u.status = 'active'
    JOIN accounts a ON a.id = r.account_id AND a.user_id = r.user_id
    WHERE r.enabled = 1 AND a.enabled = 1 AND a.status = 'connected'
    ORDER BY r.account_id, r.created_at`).all();
  const rules = rows(result).map(mapRule);
  const accounts = [];
  for (const accountId of [...new Set(rules.map((rule) => rule.account_id))]) {
    accounts.push(await listenerAccount(repository, env, accountId));
  }
  return json({ data: { accounts, rules, generated_at: new Date().toISOString() } });
}

async function listenerHeartbeat(request, repository) {
  const body = objectBody(await readJson(request, 16_000));
  const id = text(body.instance_id, "instance_id", { maximum: 160 });
  const label = text(body.label || id, "label", { maximum: 100 });
  const version = text(body.version || "unknown", "version", { maximum: 60 });
  const status = text(body.status || "online", "status", { maximum: 20 });
  if (!LISTENER_STATUSES.has(status)) {
    throw new HttpError(422, "validation_failed", "Invalid listener status.", { fields: ["status"] });
  }
  const timestamp = new Date().toISOString();
  const lastError = body.last_error
    ? sanitizeLogText(String(body.last_error), { maxLines: 2, maxLength: 500 })
    : null;
  const activeAccounts = integer(body.active_accounts, "active_accounts", 0, 10_000, 0);
  const activeRules = integer(body.active_rules, "active_rules", 0, 100_000, 0);
  await repository.db.prepare(`INSERT INTO listener_instances
    (id, label, version, status, active_accounts, active_rules, last_error, started_at, last_heartbeat_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, version = excluded.version, status = excluded.status,
      active_accounts = excluded.active_accounts, active_rules = excluded.active_rules,
      last_error = excluded.last_error, last_heartbeat_at = excluded.last_heartbeat_at, updated_at = excluded.updated_at`)
    .bind(id, label, version, status, activeAccounts, activeRules, lastError,
      body.started_at || timestamp, timestamp, timestamp).run();
  return json({ data: { accepted: true, heartbeat_at: timestamp } });
}

async function claimInspection(request, repository, env) {
  const body = objectBody(await readJson(request, 4_000));
  const instanceId = text(body.instance_id, "instance_id", { maximum: 160 });
  const timestamp = new Date().toISOString();
  await repository.db.prepare(`UPDATE bot_inspections SET status = 'expired', finished_at = ?, updated_at = ?
    WHERE status IN ('queued', 'running') AND expires_at <= ?`).bind(timestamp, timestamp, timestamp).run();
  const inspection = await repository.db.prepare(`UPDATE bot_inspections SET status = 'running', claimed_by = ?,
    claimed_at = ?, updated_at = ? WHERE id = (
      SELECT i.id FROM bot_inspections i JOIN accounts a ON a.id = i.account_id
      WHERE i.status = 'queued' AND i.expires_at > ? AND a.enabled = 1 AND a.status = 'connected'
        AND NOT EXISTS (SELECT 1 FROM account_leases l WHERE l.account_id = i.account_id AND l.leased_until > ?)
      ORDER BY i.created_at LIMIT 1
    ) AND status = 'queued' RETURNING *`)
    .bind(instanceId, timestamp, timestamp, timestamp, timestamp).first();
  if (!inspection) return json({ data: null });
  try {
    const account = await listenerAccount(repository, env, inspection.account_id);
    return json({ data: { inspection: mapInspection(inspection), account } });
  } catch (error) {
    await repository.db.prepare(`UPDATE bot_inspections SET status = 'failed', finished_at = ?,
      error_code = 'account_credentials_unavailable', error_message = ?, updated_at = ? WHERE id = ?`)
      .bind(timestamp, "账号凭据不可用，请重新登录 Telegram 账号。", timestamp, inspection.id).run();
    return json({ data: null });
  }
}

async function completeInspection(request, repository, id) {
  const body = objectBody(await readJson(request, 64_000));
  const instanceId = text(body.instance_id, "instance_id", { maximum: 160 });
  const status = text(body.status, "status", { maximum: 20 });
  if (!["success", "failed"].includes(status)) {
    throw new HttpError(422, "validation_failed", "Invalid inspection status.", { fields: ["status"] });
  }
  const result = body.result && typeof body.result === "object" && !Array.isArray(body.result)
    ? JSON.stringify(body.result).slice(0, 32_000)
    : null;
  const errorCode = status === "failed" ? text(body.error_code || "inspection_failed", "error_code", { maximum: 100 }) : null;
  const errorMessage = status === "failed"
    ? sanitizeLogText(String(body.error_message || "机器人操作识别失败。"), { maxLines: 4, maxLength: 1_000 })
    : null;
  const timestamp = new Date().toISOString();
  const updated = await repository.db.prepare(`UPDATE bot_inspections SET status = ?, result_json = ?,
    error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND claimed_by = ? RETURNING account_id`)
    .bind(status, result, errorCode, errorMessage, timestamp, timestamp, id, instanceId).first();
  if (!updated) throw new HttpError(409, "inspection_state_conflict", "Inspection cannot be completed." );
  await repository.db.prepare(`INSERT INTO listener_events
    (account_id, event_kind, action_summary, created_at) VALUES (?, 'inspection_completed', ?, ?)`)
    .bind(updated.account_id, status === "success" ? "机器人操作识别完成" : "机器人操作识别失败", timestamp).run();
  return json({ data: { accepted: true } });
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
  const body = objectBody(await readJson(request, 32_000));
  const eventKind = text(body.event_kind, "event_kind", { maximum: 40 });
  if (!["message_observed", "keyword_replied", "listener_error"].includes(eventKind)) {
    throw new HttpError(422, "validation_failed", "Invalid listener event kind.", { fields: ["event_kind"] });
  }
  const timestamp = new Date().toISOString();
  const preview = body.message_preview
    ? sanitizeLogText(String(body.message_preview), { maxLines: 3, maxLength: 600 })
    : null;
  const action = body.action_summary
    ? sanitizeLogText(String(body.action_summary), { maxLines: 2, maxLength: 300 })
    : null;
  const notificationContext = await notificationContextForEvent(repository, body);
  await repository.db.batch([
    repository.db.prepare(`INSERT INTO listener_events
      (rule_id, account_id, event_kind, chat_id, sender_id, message_id, message_preview, action_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(body.rule_id || null, body.account_id || null, eventKind,
        body.chat_id ? String(body.chat_id).slice(0, 40) : null,
        body.sender_id ? String(body.sender_id).slice(0, 40) : null,
        body.message_id ? String(body.message_id).slice(0, 40) : null,
        preview, action, timestamp),
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
      chat_id: body.chat_id,
      sender_id: body.sender_id,
      message_preview: preview,
      action_summary: action,
      created_at: timestamp,
    });
  } catch {
    notification = { sent: false, reason: "notification_failed" };
  }
  return json({ data: { accepted: true, notification } }, 202);
}

export async function handleListenerApi(request, env, repository, context = {}) {
  const url = new URL(request.url);
  const prefix = "/api/listener/v1/";
  if (!url.pathname.startsWith(prefix)) return null;
  await verifyListener(request, env);
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "config" && parts.length === 1) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return listenerConfig(repository, env);
  }
  if (parts[0] === "heartbeat" && parts.length === 1) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return listenerHeartbeat(request, repository);
  }
  if (parts[0] === "events" && parts.length === 1) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return recordListenerEvent(request, repository, env, {
      fetch: context.fetch || globalThis.fetch,
    });
  }
  if (parts[0] === "inspections" && parts[1] === "claim" && parts.length === 2) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return claimInspection(request, repository, env);
  }
  if (parts[0] === "inspections" && parts[2] === "complete" && parts.length === 3) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return completeInspection(request, repository, parts[1]);
  }
  throw new HttpError(404, "not_found", "Listener route not found." );
}

export const __test = {
  ensureRealtimeAdminAccountAvailable,
  normalizeTelegramTarget,
  recordListenerEvent,
  ruleInput,
  secureEqual,
};
