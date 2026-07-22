import { decryptBytes, encryptBytes, rootKeyForVersion } from "./crypto.js";
import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { listenerAccount, verifyListener } from "./realtime-automation.js";

export const MEDIA_CHUNK_BYTES = 512 * 1024;
export const MEDIA_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const MEDIA_LEASE_MS = 15 * 60 * 1000;
const MAX_ACTIVE_UPLOADS_PER_USER = 2;
const MAX_ACTIVE_UPLOAD_BYTES_PER_USER = 32 * 1024 * 1024;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const CONTENT_KINDS = new Set([
  "auto", "photo", "video", "audio", "voice", "animation", "video_note", "sticker", "document",
]);

function timestamp(context) {
  return context.now().toISOString();
}

function object(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "请检查上传内容。", { fields: ["body"] });
  }
  return value;
}

function boundedText(value, field, maximum, { required = true } = {}) {
  const output = String(value ?? "").trim();
  if ((required && !output) || output.length > maximum) {
    throw new HttpError(422, "validation_failed", "请检查上传内容。", { fields: [field] });
  }
  return output;
}

function safeFileName(value) {
  const leaf = String(value ?? "").replaceAll("\\", "/").split("/").at(-1) || "";
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean) return "telegram-content.bin";
  return [...clean].slice(0, 160).join("");
}

function normalizedContentType(value) {
  const output = String(value || "application/octet-stream").trim().toLowerCase();
  if (output.length > 120 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(output)) {
    return "application/octet-stream";
  }
  return output;
}

export function resolveContentKind(requested, contentType, fileName = "") {
  const kind = String(requested || "auto").trim().toLowerCase();
  if (!CONTENT_KINDS.has(kind)) {
    throw new HttpError(422, "validation_failed", "请选择有效的发送方式。", { fields: ["content_kind"] });
  }
  if (kind !== "auto") return kind;
  const mime = normalizedContentType(contentType);
  const lowerName = String(fileName).toLowerCase();
  if (mime === "image/gif" || lowerName.endsWith(".gif")) return "animation";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export function mediaUploadInput(value) {
  const input = object(value);
  const allowed = new Set(["account_id", "file_name", "content_type", "content_kind", "size_bytes"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new HttpError(422, "validation_failed", "请检查上传内容。", { fields: unknown });
  }
  const accountId = boundedText(input.account_id, "account_id", 160);
  if (!ACCOUNT_ID.test(accountId)) {
    throw new HttpError(422, "validation_failed", "请选择 Telegram 账号。", { fields: ["account_id"] });
  }
  const size = Number(input.size_bytes);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new HttpError(422, "validation_failed", "文件不能为空。", { fields: ["size_bytes"] });
  }
  if (size > MEDIA_UPLOAD_MAX_BYTES) {
    throw new HttpError(413, "media_upload_too_large", "直接上传最大支持 20 MB；更大的内容请使用 Telegram 消息链接。" );
  }
  const fileName = safeFileName(input.file_name);
  const contentType = normalizedContentType(input.content_type);
  return {
    account_id: accountId,
    file_name: fileName,
    content_type: contentType,
    content_kind: resolveContentKind(input.content_kind, contentType, fileName),
    size_bytes: size,
    total_chunks: Math.ceil(size / MEDIA_CHUNK_BYTES),
  };
}

function publicUpload(row) {
  if (!row) return null;
  return {
    id: row.id,
    account_id: row.account_id,
    file_name: row.file_name,
    content_type: row.content_type,
    content_kind: row.content_kind,
    size_bytes: Number(row.size_bytes),
    total_chunks: Number(row.total_chunks),
    uploaded_chunks: Number(row.uploaded_chunks || 0),
    status: row.status,
    source_chat_id: row.source_chat_id,
    source_message_id: row.source_message_id === null || row.source_message_id === undefined
      ? null
      : Number(row.source_message_id),
    error_code: row.error_code,
    error_message: row.error_message,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function userId(repository, context) {
  return repository.userId || context.identity?.user_id || "legacy-admin";
}

async function ownedUpload(repository, id, ownerId) {
  return repository.db.prepare("SELECT * FROM media_uploads WHERE id = ? AND user_id = ?")
    .bind(id, ownerId).first();
}

async function activeAccount(repository, accountId, ownerId) {
  return repository.db.prepare(`SELECT id FROM accounts
    WHERE id = ? AND user_id = ? AND enabled = 1 AND status = 'connected'`)
    .bind(accountId, ownerId).first();
}

async function createUpload(request, repository, context) {
  const input = mediaUploadInput(await readJson(request, 8_192));
  const ownerId = userId(repository, context);
  const now = timestamp(context);
  await expireUploads(repository, now, ownerId);
  const active = await repository.db.prepare(`SELECT COUNT(*) AS uploads,
    COALESCE(SUM(size_bytes), 0) AS bytes FROM media_uploads
    WHERE user_id = ? AND status IN ('created', 'uploaded', 'queued', 'processing') AND expires_at > ?`)
    .bind(ownerId, now).first();
  if (Number(active?.uploads || 0) >= MAX_ACTIVE_UPLOADS_PER_USER
    || Number(active?.bytes || 0) + input.size_bytes > MAX_ACTIVE_UPLOAD_BYTES_PER_USER) {
    throw new HttpError(429, "media_upload_capacity_reached", "已有内容正在上传或保存到 Telegram，请等待完成后再试。" );
  }
  if (!await activeAccount(repository, input.account_id, ownerId)) {
    throw new HttpError(409, "account_unavailable", "请选择已连接且已启用的 Telegram 账号。" );
  }
  const id = context.uuid();
  const expiresAt = new Date(context.now().getTime() + UPLOAD_TTL_MS).toISOString();
  await repository.db.prepare(`INSERT INTO media_uploads
    (id, user_id, account_id, file_name, content_type, content_kind, size_bytes, total_chunks,
      uploaded_chunks, status, attempt_count, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'created', 0, ?, ?, ?)`)
    .bind(id, ownerId, input.account_id, input.file_name, input.content_type, input.content_kind,
      input.size_bytes, input.total_chunks, expiresAt, now, now).run();
  return json({ data: publicUpload({ id, user_id: ownerId, ...input, uploaded_chunks: 0,
    status: "created", expires_at: expiresAt, created_at: now, updated_at: now }) }, 201);
}

function expectedChunkSize(upload, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= Number(upload.total_chunks)) {
    throw new HttpError(404, "media_chunk_not_found", "上传分块不存在。" );
  }
  if (index < Number(upload.total_chunks) - 1) return MEDIA_CHUNK_BYTES;
  return Number(upload.size_bytes) - (Number(upload.total_chunks) - 1) * MEDIA_CHUNK_BYTES;
}

function requireRootKey(env) {
  const value = String(env.SECRET_ROOT_KEY || "").trim();
  if (!value) throw new HttpError(500, "secret_key_missing", "媒体暂存加密尚未配置。" );
  return value;
}

async function putChunk(request, env, repository, context, id, indexSource) {
  const ownerId = userId(repository, context);
  const upload = await ownedUpload(repository, id, ownerId);
  if (!upload) throw new HttpError(404, "media_upload_not_found", "没有找到这次上传。" );
  if (!new Set(["created", "uploaded"]).has(upload.status)) {
    throw new HttpError(409, "media_upload_state_conflict", "这次上传已经进入处理阶段。" );
  }
  const index = Number(indexSource);
  const expected = expectedChunkSize(upload, index);
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared && declared !== expected) {
    throw new HttpError(422, "media_chunk_size_mismatch", "文件分块大小不正确。" );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength !== expected) {
    throw new HttpError(422, "media_chunk_size_mismatch", "文件分块大小不正确。" );
  }
  const keyVersion = Number(env.SECRET_KEY_VERSION || 1);
  const purpose = `media_upload_chunk:${index}`;
  const encrypted = await encryptBytes(requireRootKey(env), body, {
    purpose,
    ownerId: id,
    keyVersion,
  });
  const now = timestamp(context);
  await repository.db.batch([
    repository.db.prepare(`INSERT INTO media_upload_chunks
      (upload_id, chunk_index, plaintext_size, algorithm, ciphertext, nonce, aad, key_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(upload_id, chunk_index) DO UPDATE SET
        plaintext_size = excluded.plaintext_size, algorithm = excluded.algorithm,
        ciphertext = excluded.ciphertext, nonce = excluded.nonce, aad = excluded.aad,
        key_version = excluded.key_version, created_at = excluded.created_at`)
      .bind(id, index, body.byteLength, encrypted.algorithm, encrypted.ciphertext,
        encrypted.nonce, encrypted.aad, encrypted.key_version, now),
    repository.db.prepare(`UPDATE media_uploads SET
      uploaded_chunks = (SELECT COUNT(*) FROM media_upload_chunks WHERE upload_id = ?),
      status = CASE WHEN (SELECT COUNT(*) FROM media_upload_chunks WHERE upload_id = ?) >= total_chunks
        THEN 'uploaded' ELSE 'created' END,
      updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(id, id, now, id, ownerId),
  ]);
  const updated = await ownedUpload(repository, id, ownerId);
  return json({ data: publicUpload(updated) }, 202);
}

async function queueUpload(request, repository, context, id) {
  await readJson(request, 1_024);
  const ownerId = userId(repository, context);
  const upload = await ownedUpload(repository, id, ownerId);
  if (!upload) throw new HttpError(404, "media_upload_not_found", "没有找到这次上传。" );
  const summary = await repository.db.prepare(`SELECT COUNT(*) AS chunks,
    COALESCE(SUM(plaintext_size), 0) AS bytes FROM media_upload_chunks WHERE upload_id = ?`)
    .bind(id).first();
  if (Number(summary?.chunks) !== Number(upload.total_chunks)
    || Number(summary?.bytes) !== Number(upload.size_bytes)) {
    throw new HttpError(409, "media_upload_incomplete", "文件尚未完整上传。" );
  }
  const now = timestamp(context);
  await repository.db.prepare(`UPDATE media_uploads SET status = 'queued', updated_at = ?
    WHERE id = ? AND user_id = ? AND status IN ('created', 'uploaded')`)
    .bind(now, id, ownerId).run();
  return json({ data: publicUpload(await ownedUpload(repository, id, ownerId)) }, 202);
}

async function cancelUpload(repository, context, id) {
  const ownerId = userId(repository, context);
  const current = await ownedUpload(repository, id, ownerId);
  if (!current) throw new HttpError(404, "media_upload_not_found", "没有找到这次上传。" );
  if (current.status === "processing") {
    throw new HttpError(409, "media_upload_state_conflict", "内容正在保存到 Telegram，暂时不能取消。" );
  }
  await repository.db.prepare("DELETE FROM media_uploads WHERE id = ? AND user_id = ?")
    .bind(id, ownerId).run();
  return new Response(null, { status: 204 });
}

export async function handleWorkspaceMediaUploadApi(request, env, repository, context) {
  const url = new URL(request.url);
  const prefix = "/api/v1/media-uploads";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return createUpload(request, repository, context);
  }
  const [id, action, index] = parts;
  if (!ACCOUNT_ID.test(id)) throw new HttpError(404, "media_upload_not_found", "没有找到这次上传。" );
  if (parts.length === 1) {
    if (request.method === "GET") {
      const upload = await ownedUpload(repository, id, userId(repository, context));
      if (!upload) throw new HttpError(404, "media_upload_not_found", "没有找到这次上传。" );
      return json({ data: publicUpload(upload) });
    }
    if (request.method === "DELETE") return cancelUpload(repository, context, id);
    return methodNotAllowed(["GET", "DELETE"]);
  }
  if (action === "chunks" && parts.length === 3) {
    if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
    return putChunk(request, env, repository, context, id, index);
  }
  if (action === "complete" && parts.length === 2) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return queueUpload(request, repository, context, id);
  }
  throw new HttpError(404, "not_found", "Media upload route not found." );
}

async function expireUploads(repository, now, ownerId = null) {
  await repository.db.prepare(`DELETE FROM media_uploads
    WHERE expires_at <= ? AND status != 'ready' ${ownerId ? "AND user_id = ?" : ""}`)
    .bind(now, ...(ownerId ? [ownerId] : [])).run();
}

async function claimUpload(request, env, repository, context) {
  const body = object(await readJson(request, 4_096));
  const instanceId = boundedText(body.instance_id, "instance_id", 160);
  const now = timestamp(context);
  const leasedUntil = new Date(context.now().getTime() + MEDIA_LEASE_MS).toISOString();
  await expireUploads(repository, now);
  await repository.db.batch([
    repository.db.prepare("DELETE FROM media_upload_leases WHERE leased_until <= ?").bind(now),
    repository.db.prepare(`INSERT OR IGNORE INTO media_upload_leases
      (account_id, upload_id, holder, leased_until, created_at, updated_at)
      SELECT m.account_id, m.id, ?, ?, ?, ?
      FROM media_uploads m JOIN accounts a ON a.id = m.account_id
      JOIN users u ON u.id = m.user_id
      WHERE m.status = 'queued' AND m.expires_at > ?
        AND a.enabled = 1 AND a.status = 'connected' AND u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM account_leases account_lease
          WHERE account_lease.account_id = m.account_id AND account_lease.leased_until > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_upload_leases media_lease
          WHERE media_lease.account_id = m.account_id AND media_lease.leased_until > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_runs active JOIN tasks active_task ON active_task.id = active.task_id
          WHERE COALESCE(active.account_id_snapshot, active_task.account_id) = m.account_id
            AND (active.status IN ('claimed', 'running')
              OR (active.status = 'queued' AND active.dispatch_status IN ('dispatching', 'dispatched')))
        )
      ORDER BY m.created_at LIMIT 1`)
      .bind(instanceId, leasedUntil, now, now, now, now, now),
    repository.db.prepare(`UPDATE media_uploads SET status = 'processing', claimed_by = ?,
      attempt_count = attempt_count + 1, updated_at = ?
      WHERE status = 'queued' AND id IN (
        SELECT upload_id FROM media_upload_leases WHERE holder = ? AND created_at = ?
      )`).bind(instanceId, now, instanceId, now),
  ]);
  const upload = await repository.db.prepare(`SELECT m.* FROM media_uploads m
    JOIN media_upload_leases lease ON lease.upload_id = m.id
    WHERE m.status = 'processing' AND m.claimed_by = ? AND lease.holder = ?
      AND lease.created_at = ? ORDER BY m.created_at LIMIT 1`)
    .bind(instanceId, instanceId, now).first();
  if (!upload) return json({ data: null });
  try {
    const account = await listenerAccount(repository, env, upload.account_id);
    return json({ data: { upload: publicUpload(upload), account } });
  } catch {
    await repository.db.batch([
      repository.db.prepare(`UPDATE media_uploads SET status = 'failed', error_code = 'account_unavailable',
        error_message = 'Telegram 账号不可用，请重新连接后再试。', updated_at = ? WHERE id = ?`)
        .bind(now, upload.id),
      repository.db.prepare("DELETE FROM media_upload_chunks WHERE upload_id = ?").bind(upload.id),
      repository.db.prepare("DELETE FROM media_upload_leases WHERE upload_id = ?").bind(upload.id),
    ]);
    return json({ data: null });
  }
}

async function uploadChunks(repository, id, instanceId) {
  const upload = await repository.db.prepare(`SELECT * FROM media_uploads
    WHERE id = ? AND status = 'processing' AND claimed_by = ?`).bind(id, instanceId).first();
  if (!upload) throw new HttpError(404, "media_upload_not_found", "没有找到正在处理的上传。" );
  const result = await repository.db.prepare(`SELECT * FROM media_upload_chunks
    WHERE upload_id = ? ORDER BY chunk_index`).bind(id).all();
  const chunks = result?.results || [];
  if (chunks.length !== Number(upload.total_chunks)) {
    throw new HttpError(409, "media_upload_incomplete", "文件暂存不完整。" );
  }
  return { upload, chunks };
}

export function binaryResponse(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  return new Response(value, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(value.byteLength),
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
}

async function mediaContent(request, env, repository, id) {
  const instanceId = boundedText(request.headers.get("x-listener-instance-id"), "instance_id", 160);
  const { upload, chunks } = await uploadChunks(repository, id, instanceId);
  const output = new Uint8Array(Number(upload.size_bytes));
  let offset = 0;
  for (const chunk of chunks) {
    const rootKey = rootKeyForVersion(env, Number(chunk.key_version));
    if (!rootKey) throw new HttpError(500, "secret_key_missing", "媒体暂存解密尚未配置。" );
    const plaintext = await decryptBytes(rootKey, {
      algorithm: chunk.algorithm,
      ciphertext: chunk.ciphertext,
      nonce: chunk.nonce,
      aad: chunk.aad,
      key_version: Number(chunk.key_version),
    }, {
      purpose: `media_upload_chunk:${Number(chunk.chunk_index)}`,
      ownerId: id,
    });
    output.set(plaintext, offset);
    offset += plaintext.byteLength;
  }
  if (offset !== output.byteLength) throw new HttpError(409, "media_upload_incomplete", "文件暂存不完整。" );
  return binaryResponse(output);
}

async function completeUpload(request, repository, context, id) {
  const body = object(await readJson(request, 8_192));
  const instanceId = boundedText(body.instance_id, "instance_id", 160);
  const status = boundedText(body.status, "status", 20);
  if (!new Set(["ready", "failed", "ambiguous"]).has(status)) {
    throw new HttpError(422, "validation_failed", "上传处理状态无效。", { fields: ["status"] });
  }
  const current = await repository.db.prepare(`SELECT * FROM media_uploads
    WHERE id = ? AND claimed_by = ?`).bind(id, instanceId).first();
  if (current?.status === status && status === "ready"
    && Number(current.source_message_id) === Number(body.source_message_id)) {
    return json({ data: { accepted: true, replayed: true } });
  }
  if (current?.status === status && ["failed", "ambiguous"].includes(status)) {
    return json({ data: { accepted: true, replayed: true } });
  }
  if (!current || current.status !== "processing") {
    throw new HttpError(409, "media_upload_state_conflict", "上传状态已经改变。" );
  }
  const now = timestamp(context);
  if (status === "ready") {
    const messageId = Number(body.source_message_id);
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      throw new HttpError(422, "validation_failed", "Telegram 没有返回有效消息编号。", { fields: ["source_message_id"] });
    }
    await repository.db.batch([
      repository.db.prepare(`UPDATE media_uploads SET status = 'ready', source_chat_id = 'me',
        source_message_id = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`)
        .bind(messageId, now, id),
      repository.db.prepare("DELETE FROM media_upload_chunks WHERE upload_id = ?").bind(id),
      repository.db.prepare("DELETE FROM media_upload_leases WHERE upload_id = ?").bind(id),
    ]);
  } else {
    const errorCode = boundedText(body.error_code || (status === "ambiguous" ? "telegram_stage_ambiguous" : "telegram_stage_failed"), "error_code", 100);
    const errorMessage = boundedText(body.error_message || (status === "ambiguous"
      ? "Telegram 返回结果不确定；为避免重复发送，请检查账号收藏夹后重试。"
      : "内容未能保存到 Telegram。"), "error_message", 500);
    await repository.db.batch([
      repository.db.prepare(`UPDATE media_uploads SET status = ?, error_code = ?, error_message = ?,
        updated_at = ? WHERE id = ?`).bind(status, errorCode, errorMessage, now, id),
      repository.db.prepare("DELETE FROM media_upload_chunks WHERE upload_id = ?").bind(id),
      repository.db.prepare("DELETE FROM media_upload_leases WHERE upload_id = ?").bind(id),
    ]);
  }
  return json({ data: { accepted: true } });
}

export async function handleListenerMediaUploadApi(request, env, repository, context) {
  const url = new URL(request.url);
  const prefix = "/api/listener/v1/media-uploads";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  await verifyListener(request, env);
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 1 && parts[0] === "claim") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return claimUpload(request, env, repository, context);
  }
  const [id, action] = parts;
  if (!ACCOUNT_ID.test(id)) throw new HttpError(404, "media_upload_not_found", "没有找到这次上传。" );
  if (parts.length === 2 && action === "content") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return mediaContent(request, env, repository, id);
  }
  if (parts.length === 2 && action === "complete") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return completeUpload(request, repository, context, id);
  }
  throw new HttpError(404, "not_found", "Listener media upload route not found." );
}

export const __test = {
  MEDIA_CHUNK_BYTES,
  MEDIA_UPLOAD_MAX_BYTES,
  MAX_ACTIVE_UPLOADS_PER_USER,
  MAX_ACTIVE_UPLOAD_BYTES_PER_USER,
  MEDIA_LEASE_MS,
  binaryResponse,
  expireUploads,
  mediaUploadInput,
  resolveContentKind,
};
