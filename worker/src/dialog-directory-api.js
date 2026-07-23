import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { listenerAccount, verifyListener } from "./realtime-automation.js";
import { sanitizeLogText } from "./redaction.js";

const PEER_TYPES = new Set(["private", "bot", "group", "supergroup", "channel"]);
const TARGET_PATTERN = /^(?:@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{1,20})$/;
const SYNC_TTL_MS = 5 * 60_000;
const MAX_DIALOGS = 500;

function rows(result) {
  return result?.results || [];
}

function objectBody(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "请求内容格式不正确。", { fields: ["body"] });
  }
  return value;
}

function text(value, field, maximum, { required = true } = {}) {
  const output = String(value ?? "").trim();
  if ((required && !output) || output.length > maximum) {
    throw new HttpError(422, "validation_failed", "请检查填写内容。", { fields: [field] });
  }
  return output;
}

function mapSync(row) {
  if (!row) return null;
  return {
    id: row.id,
    account_id: row.account_id,
    status: row.status,
    dialog_count: Number(row.dialog_count || 0),
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

function mapDialog(row) {
  return {
    peer_id: String(row.peer_id),
    target: row.target,
    peer_type: row.peer_type,
    title: row.title,
    username: row.username,
    label: row.label,
    is_writable: Boolean(row.is_writable),
    last_message_at: row.last_message_at,
    synced_at: row.synced_at,
  };
}

function accountIdFromUrl(url) {
  return text(url.searchParams.get("account_id"), "account_id", 160);
}

async function ownedAccount(repository, accountId) {
  const account = await repository.getAccount(accountId);
  if (!account) {
    throw new HttpError(404, "account_not_found", "没有找到这个 Telegram 账号。" );
  }
  return account;
}

async function latestSync(repository, accountId) {
  return repository.db.prepare(`SELECT * FROM account_dialog_syncs
    WHERE user_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(repository.userId || "legacy-admin", accountId).first();
}

async function listWorkspaceDialogs(request, repository, url) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const accountId = accountIdFromUrl(url);
  await ownedAccount(repository, accountId);
  const result = await repository.db.prepare(`SELECT peer_id, target, peer_type, title, username,
    label, is_writable, last_message_at, synced_at FROM account_dialogs
    WHERE user_id = ? AND account_id = ?
    ORDER BY is_writable DESC,
      CASE peer_type WHEN 'private' THEN 0 WHEN 'bot' THEN 1 WHEN 'group' THEN 2
        WHEN 'supergroup' THEN 3 ELSE 4 END,
      label COLLATE NOCASE LIMIT ?`)
    .bind(repository.userId || "legacy-admin", accountId, MAX_DIALOGS).all();
  const sync = await latestSync(repository, accountId);
  return json({
    data: {
      account_id: accountId,
      dialogs: rows(result).map(mapDialog),
      sync: mapSync(sync),
    },
  });
}

async function refreshWorkspaceDialogs(request, env, repository, context) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (String(env.LISTENER_API_TOKEN || "").trim().length < 32) {
    throw new HttpError(503, "listener_not_configured", "联系人与群组同步尚未启用，请联系管理员部署常驻 Listener。" );
  }
  const body = objectBody(await readJson(request, 4_000));
  const accountId = text(body.account_id, "account_id", 160);
  const account = await ownedAccount(repository, accountId);
  if (!account.enabled || account.status !== "connected") {
    throw new HttpError(409, "account_unavailable", "请先完成该 Telegram 账号的登录和连接检测。" );
  }
  const now = context.now();
  const timestamp = now.toISOString();
  await repository.db.prepare(`UPDATE account_dialog_syncs SET status = 'expired', finished_at = ?, updated_at = ?
    WHERE user_id = ? AND account_id = ? AND status IN ('queued', 'running') AND expires_at <= ?`)
    .bind(timestamp, timestamp, repository.userId || "legacy-admin", accountId, timestamp).run();
  const active = await repository.db.prepare(`SELECT * FROM account_dialog_syncs
    WHERE user_id = ? AND account_id = ? AND status IN ('queued', 'running') AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`)
    .bind(repository.userId || "legacy-admin", accountId, timestamp).first();
  if (active) return json({ data: mapSync(active) }, 202);

  const dayStart = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const recent = await repository.db.prepare(`SELECT COUNT(*) AS total FROM account_dialog_syncs
    WHERE user_id = ? AND account_id = ? AND created_at >= ?`)
    .bind(repository.userId || "legacy-admin", accountId, dayStart).first();
  if (Number(recent?.total || 0) >= 20) {
    throw new HttpError(429, "dialog_sync_rate_limited", "每个账号每天最多刷新 20 次，请稍后再试。" );
  }

  const id = context.uuid();
  const expiresAt = new Date(now.getTime() + SYNC_TTL_MS).toISOString();
  await repository.db.prepare(`INSERT INTO account_dialog_syncs
    (id, user_id, account_id, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', ?, ?, ?)`)
    .bind(id, repository.userId || "legacy-admin", accountId, expiresAt, timestamp, timestamp).run();
  return json({ data: mapSync(await latestSync(repository, accountId)) }, 202);
}

export async function handleWorkspaceDialogDirectoryApi(request, env, repository, context = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/account-dialogs") {
    return listWorkspaceDialogs(request, repository, url);
  }
  if (url.pathname === "/api/v1/account-dialogs/refresh") {
    return refreshWorkspaceDialogs(request, env, repository, context);
  }
  return null;
}

function listenerInstance(body) {
  return text(body.instance_id, "instance_id", 160);
}

async function claimDialogSync(request, env, repository) {
  const body = objectBody(await readJson(request, 4_000));
  const instanceId = listenerInstance(body);
  const timestamp = new Date().toISOString();
  await repository.db.prepare(`UPDATE account_dialog_syncs SET status = 'expired', finished_at = ?, updated_at = ?
    WHERE status IN ('queued', 'running') AND expires_at <= ?`)
    .bind(timestamp, timestamp, timestamp).run();
  const sync = await repository.db.prepare(`UPDATE account_dialog_syncs SET status = 'running',
    claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = (
      SELECT s.id FROM account_dialog_syncs s JOIN accounts a ON a.id = s.account_id
      WHERE s.status = 'queued' AND s.expires_at > ? AND a.enabled = 1 AND a.status = 'connected'
      ORDER BY s.created_at LIMIT 1
    ) AND status = 'queued' RETURNING *`)
    .bind(instanceId, timestamp, timestamp, timestamp).first();
  if (!sync) return json({ data: null });
  try {
    const account = await listenerAccount(repository, env, sync.account_id);
    return json({ data: { sync: mapSync(sync), account } });
  } catch {
    await repository.db.prepare(`UPDATE account_dialog_syncs SET status = 'failed', finished_at = ?,
      error_code = 'account_credentials_unavailable', error_message = ?, updated_at = ? WHERE id = ?`)
      .bind(timestamp, "账号凭据不可用，请重新登录 Telegram 账号。", timestamp, sync.id).run();
    return json({ data: null });
  }
}

function dialogInput(value, index) {
  const input = objectBody(value);
  const peerId = text(input.peer_id, `dialogs.${index}.peer_id`, 40);
  const target = text(input.target, `dialogs.${index}.target`, 128);
  if (!TARGET_PATTERN.test(target)) {
    throw new HttpError(422, "validation_failed", "会话目标格式不正确。", { fields: [`dialogs.${index}.target`] });
  }
  const peerType = text(input.peer_type, `dialogs.${index}.peer_type`, 20);
  if (!PEER_TYPES.has(peerType)) {
    throw new HttpError(422, "validation_failed", "会话类型不受支持。", { fields: [`dialogs.${index}.peer_type`] });
  }
  const username = text(input.username, `dialogs.${index}.username`, 64, { required: false }).replace(/^@/, "") || null;
  return {
    peer_id: peerId,
    target,
    peer_type: peerType,
    title: text(input.title, `dialogs.${index}.title`, 160),
    username,
    label: text(input.label, `dialogs.${index}.label`, 240),
    is_writable: input.is_writable !== false ? 1 : 0,
    last_message_at: text(input.last_message_at, `dialogs.${index}.last_message_at`, 40, { required: false }) || null,
  };
}

async function completeDialogSync(request, repository, syncId) {
  const body = objectBody(await readJson(request, 512_000));
  const instanceId = listenerInstance(body);
  const status = text(body.status, "status", 20);
  if (!new Set(["success", "failed"]).has(status)) {
    throw new HttpError(422, "validation_failed", "同步状态无效。", { fields: ["status"] });
  }
  const current = await repository.db.prepare(`SELECT * FROM account_dialog_syncs
    WHERE id = ? AND status = 'running' AND claimed_by = ?`).bind(syncId, instanceId).first();
  if (!current) {
    throw new HttpError(409, "dialog_sync_state_conflict", "会话目录同步任务已经失效或被其他 Listener 处理。" );
  }
  const timestamp = new Date().toISOString();
  if (status === "failed") {
    const errorCode = text(body.error_code || "dialog_sync_failed", "error_code", 100);
    const errorMessage = sanitizeLogText(String(body.error_message || "联系人与群组同步失败。"), {
      maxLines: 3,
      maxLength: 500,
    });
    await repository.db.prepare(`UPDATE account_dialog_syncs SET status = 'failed', finished_at = ?,
      error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .bind(timestamp, errorCode, errorMessage, timestamp, syncId).run();
    return json({ data: { accepted: true } });
  }

  if (!Array.isArray(body.dialogs) || body.dialogs.length > MAX_DIALOGS) {
    throw new HttpError(422, "validation_failed", `会话目录最多包含 ${MAX_DIALOGS} 项。`, { fields: ["dialogs"] });
  }
  const unique = new Map();
  body.dialogs.forEach((item, index) => {
    const dialog = dialogInput(item, index);
    unique.set(dialog.peer_id, dialog);
  });
  const statements = [
    repository.db.prepare("DELETE FROM account_dialogs WHERE user_id = ? AND account_id = ?")
      .bind(current.user_id, current.account_id),
  ];
  for (const dialog of unique.values()) {
    statements.push(repository.db.prepare(`INSERT INTO account_dialogs
      (user_id, account_id, peer_id, target, peer_type, title, username, label,
       is_writable, last_message_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(current.user_id, current.account_id, dialog.peer_id, dialog.target, dialog.peer_type,
        dialog.title, dialog.username, dialog.label, dialog.is_writable, dialog.last_message_at, timestamp));
  }
  statements.push(repository.db.prepare(`UPDATE account_dialog_syncs SET status = 'success', finished_at = ?,
    dialog_count = ?, error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND status = 'running' AND claimed_by = ?`)
    .bind(timestamp, unique.size, timestamp, syncId, instanceId));
  await repository.db.batch(statements);
  return json({ data: { accepted: true, dialog_count: unique.size } });
}

export async function handleListenerDialogDirectoryApi(request, env, repository) {
  const url = new URL(request.url);
  const prefix = "/api/listener/v1/dialog-syncs";
  if (!url.pathname.startsWith(prefix)) return null;
  await verifyListener(request, env);
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) {
    throw new HttpError(404, "not_found", "Listener dialog route not found." );
  }
  if (parts[0] === "claim" && parts.length === 1) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return claimDialogSync(request, env, repository);
  }
  if (parts.length === 2 && parts[1] === "complete") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return completeDialogSync(request, repository, parts[0]);
  }
  throw new HttpError(404, "not_found", "Listener dialog route not found." );
}

export const __test = {
  MAX_DIALOGS,
  dialogInput,
  mapDialog,
  mapSync,
};
