import { dispatchWorkflow } from "./github.js";
import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { exactObject } from "./validation.js";

const ACCOUNT_STATUSES = new Set(["disconnected", "login_pending", "connected", "error"]);
const ACTIVE_VALIDATION_STATUSES = new Set(["created", "starting", "code_submitted", "password_submitted"]);

function iso(now) {
  return now().toISOString();
}

function listOptions(url) {
  const limitSource = url.searchParams.get("limit") || "100";
  const cursorSource = url.searchParams.get("cursor") || "0";
  if (!/^\d+$/.test(limitSource) || !/^\d+$/.test(cursorSource)) {
    throw new HttpError(422, "validation_failed", "分页参数无效。", { fields: ["pagination"] });
  }
  const limit = Number(limitSource);
  const offset = Number(cursorSource);
  if (limit < 1 || limit > 100 || !Number.isSafeInteger(offset)) {
    throw new HttpError(422, "validation_failed", "分页参数无效。", { fields: ["pagination"] });
  }
  return { limit, offset };
}

function mapHealthRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    owner_display_name: row.owner_display_name || "未命名用户",
    owner_login: row.owner_email || (row.owner_github_login ? `@${row.owner_github_login}` : "—"),
    owner_status: row.owner_status || "unknown",
    account_name: row.account_name,
    phone_masked: row.phone_masked,
    telegram_username: row.telegram_username || null,
    telegram_display_name: row.telegram_display_name || null,
    status: row.status,
    enabled: Boolean(row.enabled),
    session_configured: Boolean(row.session_configured),
    last_error: String(row.last_error || "").slice(0, 500) || null,
    last_connected_at: row.last_connected_at || null,
    last_checked_at: row.last_checked_at || null,
    validation_status: row.validation_status || null,
    validation_error: String(row.validation_error || "").slice(0, 500) || null,
    validation_started_at: row.validation_started_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function flowSummary(flow) {
  return {
    id: flow?.id || null,
    account_id: flow?.account_id || null,
    status: flow?.status || "starting",
    expires_at: flow?.expires_at || null,
    created_at: flow?.created_at || null,
  };
}

async function listPlatformAccounts(db, url) {
  const { limit, offset } = listOptions(url);
  const status = String(url.searchParams.get("status") || "").trim();
  const search = String(url.searchParams.get("search") || "").trim().toLowerCase().slice(0, 120);
  if (status && !ACCOUNT_STATUSES.has(status)) {
    throw new HttpError(422, "validation_failed", "账号状态筛选无效。", { fields: ["status"] });
  }

  const conditions = [];
  const bindings = [];
  if (status) {
    conditions.push("a.status = ?");
    bindings.push(status);
  }
  if (search) {
    conditions.push(`LOWER(COALESCE(u.display_name, '') || ' ' || COALESCE(u.email, '') || ' ' ||
      COALESCE(u.github_login, '') || ' ' || COALESCE(a.name, '') || ' ' ||
      COALESCE(a.phone_masked, '') || ' ' || COALESCE(a.telegram_username, '') || ' ' ||
      COALESCE(a.telegram_display_name, '')) LIKE ?`);
    bindings.push(`%${search}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT
      a.id,
      a.user_id,
      a.name AS account_name,
      a.phone_masked,
      a.telegram_username,
      a.telegram_display_name,
      a.status,
      a.enabled,
      a.last_error,
      a.last_connected_at,
      a.last_checked_at,
      a.created_at,
      a.updated_at,
      CASE WHEN a.session_secret_id IS NOT NULL THEN 1 ELSE 0 END AS session_configured,
      u.display_name AS owner_display_name,
      u.email AS owner_email,
      u.github_login AS owner_github_login,
      u.status AS owner_status,
      (SELECT lf.status FROM login_flows lf WHERE lf.account_id = a.id ORDER BY lf.created_at DESC LIMIT 1) AS validation_status,
      (SELECT lf.last_error FROM login_flows lf WHERE lf.account_id = a.id ORDER BY lf.created_at DESC LIMIT 1) AS validation_error,
      (SELECT lf.created_at FROM login_flows lf WHERE lf.account_id = a.id ORDER BY lf.created_at DESC LIMIT 1) AS validation_started_at
    FROM accounts a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY
      CASE a.status WHEN 'error' THEN 0 WHEN 'disconnected' THEN 1 WHEN 'login_pending' THEN 2 ELSE 3 END,
      COALESCE(a.last_checked_at, a.updated_at) ASC,
      a.id ASC
    LIMIT ? OFFSET ?`;
  const result = await db.prepare(sql).bind(...bindings, limit + 1, offset).all();
  const rows = result?.results || [];
  const hasMore = rows.length > limit;
  return {
    data: rows.slice(0, limit).map(mapHealthRow),
    pagination: {
      limit,
      next_cursor: hasMore ? String(offset + limit) : null,
    },
  };
}

async function getPlatformAccount(db, id) {
  return db.prepare(`SELECT a.id, a.user_id, a.name AS account_name, a.phone_masked,
      a.status, a.enabled, CASE WHEN a.session_secret_id IS NOT NULL THEN 1 ELSE 0 END AS session_configured,
      u.display_name AS owner_display_name, u.email AS owner_email, u.github_login AS owner_github_login,
      u.status AS owner_status
    FROM accounts a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?`).bind(id).first();
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
  if (!credentials) throw new HttpError(404, "account_not_found", "账号不存在。 ");
  if (!credentials.session_secret_id) {
    throw new HttpError(409, "account_credentials_incomplete", "该账号尚未保存 Telegram Session。 ");
  }
  const active = await repository.getActiveLoginFlowForAccount(accountId);
  if (active && ACTIVE_VALIDATION_STATUSES.has(active.status)) return active;

  const flowId = context.uuid();
  const timestamp = iso(context.now);
  const expiresAt = new Date(context.now().getTime() + 10 * 60_000).toISOString();
  const flow = await repository.createSessionValidationFlow(accountId, {
    id: flowId,
    expires_at: expiresAt,
    created_at: timestamp,
    updated_at: timestamp,
  });
  if (!flow) throw new HttpError(409, "account_credentials_incomplete", "账号凭据不完整，无法检测。 ");
  try {
    await dispatchLoginFlow(env, context, flowId);
  } catch {
    await repository.failSessionValidationDispatch(flowId, iso(context.now));
    throw new HttpError(502, "validation_dispatch_failed", "账号检测执行器启动失败。 ");
  }
  return flow;
}

function batchAccountIds(body) {
  exactObject(body, ["account_ids"], ["account_ids"]);
  if (!Array.isArray(body.account_ids) || body.account_ids.length < 1 || body.account_ids.length > 20) {
    throw new HttpError(422, "validation_failed", "每次请选择 1 至 20 个账号。", { fields: ["account_ids"] });
  }
  const ids = [...new Set(body.account_ids.map((value) => String(value || "").trim()))];
  if (ids.length < 1 || ids.some((id) => !id || id.length > 128)) {
    throw new HttpError(422, "validation_failed", "账号列表无效。", { fields: ["account_ids"] });
  }
  return ids;
}

export async function handlePlatformAccountHealthApi(request, env, repository, context) {
  const url = new URL(request.url);
  const prefix = "/api/v1/admin/account-health";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  if (context.identity?.role !== "admin") {
    throw new HttpError(403, "administrator_required", "只有平台管理员可以查看全平台账号健康状态。 ");
  }
  if (!env.DB) throw new HttpError(503, "database_unavailable", "账号健康中心数据库不可用。 ");

  const suffix = url.pathname.slice(prefix.length);
  const parts = suffix.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return json(await listPlatformAccounts(env.DB, url));
  }

  if (parts.length === 1 && parts[0] === "validate-batch") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const ids = batchAccountIds(await readJson(request, 16_000));
    const flows = [];
    const failures = [];
    for (const accountId of ids) {
      const account = await getPlatformAccount(env.DB, accountId);
      if (!account) {
        failures.push({ account_id: accountId, code: "account_not_found" });
        continue;
      }
      try {
        flows.push(flowSummary(await startSessionValidation(env, repository, context, accountId)));
      } catch (error) {
        failures.push({
          account_id: accountId,
          code: error instanceof HttpError ? error.code : "account_validation_failed",
        });
      }
    }
    return json({ data: { requested: ids.length, started: flows.length, flows, failures } }, 202);
  }

  if (parts.length === 2 && parts[1] === "validate") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    exactObject(await readJson(request, 1_000), []);
    const account = await getPlatformAccount(env.DB, parts[0]);
    if (!account) throw new HttpError(404, "account_not_found", "账号不存在。 ");
    return json({ data: flowSummary(await startSessionValidation(env, repository, context, parts[0])) }, 202);
  }

  throw new HttpError(404, "not_found", "账号健康中心接口不存在。 ");
}

export const __test = { listOptions, mapHealthRow, flowSummary, batchAccountIds };
