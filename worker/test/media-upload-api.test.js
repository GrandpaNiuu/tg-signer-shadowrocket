import assert from "node:assert/strict";
import test from "node:test";

import {
  __test,
  handleListenerMediaUploadApi,
  handleWorkspaceMediaUploadApi,
} from "../src/media-upload-api.js";
import { createTestRepository, seedAccount, seedTask } from "./d1-helper.js";

const ROOT_KEY = Buffer.alloc(32, 7).toString("base64");
const LISTENER_TOKEN = "listener-test-token-that-is-at-least-32-bytes";

function context(uuid = () => "upload-12345678") {
  return {
    identity: { user_id: "legacy-admin", role: "admin" },
    now: () => new Date("2026-07-22T08:00:00.000Z"),
    uuid,
  };
}

function workspaceRequest(path, { method = "GET", body, contentType = "application/json" } = {}) {
  const init = { method, headers: { "content-type": contentType } };
  if (body !== undefined) init.body = contentType === "application/json" ? JSON.stringify(body) : body;
  return new Request(`https://worker.example${path}`, init);
}

function listenerRequest(path, { method = "GET", body } = {}) {
  const init = {
    method,
    headers: {
      authorization: `Bearer ${LISTENER_TOKEN}`,
      "content-type": "application/json",
      "x-listener-instance-id": "listener-vps-1",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://worker.example${path}`, init);
}

test("upload metadata is filename-safe, bounded and split into deterministic encrypted chunks", () => {
  assert.deepEqual(__test.mediaUploadInput({
    account_id: "account-12345678",
    file_name: "../旅行视频.mp4",
    content_type: "video/mp4",
    content_kind: "auto",
    size_bytes: __test.MEDIA_CHUNK_BYTES + 1,
  }), {
    account_id: "account-12345678",
    file_name: "旅行视频.mp4",
    content_type: "video/mp4",
    content_kind: "video",
    size_bytes: __test.MEDIA_CHUNK_BYTES + 1,
    total_chunks: 2,
  });
  assert.throws(
    () => __test.mediaUploadInput({
      account_id: "account-12345678",
      file_name: "too-big.zip",
      content_type: "application/zip",
      content_kind: "document",
      size_bytes: __test.MEDIA_UPLOAD_MAX_BYTES + 1,
    }),
    (error) => error?.status === 413 && error?.code === "media_upload_too_large",
  );
});

test("content kind can be automatic or explicitly forced for Telegram", () => {
  assert.equal(__test.resolveContentKind("auto", "image/png", "image.png"), "photo");
  assert.equal(__test.resolveContentKind("auto", "image/gif", "motion.gif"), "animation");
  assert.equal(__test.resolveContentKind("voice", "audio/ogg", "note.ogg"), "voice");
  assert.equal(__test.resolveContentKind("document", "video/mp4", "clip.mp4"), "document");
});

test("listener content responses are private and never cache file bytes", () => {
  const response = __test.binaryResponse(Uint8Array.from([1, 2, 3]), "video/mp4");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-length"), "3");
});

test("a browser upload is encrypted, staged for the listener, and removed after Telegram accepts it", async () => {
  const { sqlite, repository } = createTestRepository();
  await seedAccount(repository, { id: "account-12345678" });
  const env = {
    SECRET_ROOT_KEY: ROOT_KEY,
    SECRET_KEY_VERSION: "1",
    LISTENER_API_TOKEN: LISTENER_TOKEN,
  };
  const runtime = context();
  const plaintext = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);

  const createdResponse = await handleWorkspaceMediaUploadApi(workspaceRequest("/api/v1/media-uploads", {
    method: "POST",
    body: {
      account_id: "account-12345678",
      file_name: "preview.png",
      content_type: "image/png",
      content_kind: "auto",
      size_bytes: plaintext.byteLength,
    },
  }), env, repository, runtime);
  assert.equal(createdResponse.status, 201);
  assert.equal((await createdResponse.json()).data.content_kind, "photo");

  const chunkResponse = await handleWorkspaceMediaUploadApi(workspaceRequest(
    "/api/v1/media-uploads/upload-12345678/chunks/0",
    { method: "PUT", body: plaintext, contentType: "application/octet-stream" },
  ), env, repository, runtime);
  assert.equal(chunkResponse.status, 202);
  const encrypted = sqlite.prepare("SELECT ciphertext FROM media_upload_chunks WHERE upload_id = ?")
    .get("upload-12345678").ciphertext;
  assert.notDeepEqual([...encrypted], [...plaintext]);

  const queuedResponse = await handleWorkspaceMediaUploadApi(workspaceRequest(
    "/api/v1/media-uploads/upload-12345678/complete",
    { method: "POST", body: {} },
  ), env, repository, runtime);
  assert.equal(queuedResponse.status, 202);
  assert.equal((await queuedResponse.json()).data.status, "queued");

  sqlite.prepare(`UPDATE media_uploads SET status = 'processing', claimed_by = ? WHERE id = ?`)
    .run("listener-vps-1", "upload-12345678");
  const contentResponse = await handleListenerMediaUploadApi(listenerRequest(
    "/api/listener/v1/media-uploads/upload-12345678/content",
  ), env, repository, runtime);
  assert.equal(contentResponse.status, 200);
  assert.deepEqual([...new Uint8Array(await contentResponse.arrayBuffer())], [...plaintext]);

  const completedResponse = await handleListenerMediaUploadApi(listenerRequest(
    "/api/listener/v1/media-uploads/upload-12345678/complete",
    { method: "POST", body: { instance_id: "listener-vps-1", status: "ready", source_message_id: 321 } },
  ), env, repository, runtime);
  assert.equal(completedResponse.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM media_upload_chunks WHERE upload_id = ?")
    .get("upload-12345678").total, 0);
  assert.deepEqual({ ...sqlite.prepare(
    "SELECT status, source_chat_id, source_message_id FROM media_uploads WHERE id = ?",
  ).get("upload-12345678") }, { status: "ready", source_chat_id: "me", source_message_id: 321 });
});

test("a workspace cannot fill D1 with unlimited concurrent file uploads", async () => {
  const { repository } = createTestRepository();
  await seedAccount(repository, { id: "account-12345678" });
  const env = { SECRET_ROOT_KEY: ROOT_KEY };
  let sequence = 0;
  const runtime = context(() => `upload-capacity-${++sequence}`);
  const create = () => handleWorkspaceMediaUploadApi(workspaceRequest("/api/v1/media-uploads", {
    method: "POST",
    body: {
      account_id: "account-12345678",
      file_name: "small.bin",
      content_type: "application/octet-stream",
      content_kind: "auto",
      size_bytes: 1,
    },
  }), env, repository, runtime);

  assert.equal((await create()).status, 201);
  assert.equal((await create()).status, 201);
  await assert.rejects(
    create(),
    (error) => error?.status === 429 && error?.code === "media_upload_capacity_reached",
  );
});

test("workspace expiry only removes uploads owned by the current user", async () => {
  const { sqlite, repository } = createTestRepository();
  await seedAccount(repository, { id: "account-legacy" });
  sqlite.prepare(`INSERT INTO users (id, role, status, display_name, created_at, updated_at)
    VALUES ('user-other', 'user', 'active', 'Other', ?, ?)`).run(
    "2026-07-22T07:00:00.000Z", "2026-07-22T07:00:00.000Z",
  );
  sqlite.prepare(`INSERT INTO accounts
    (id, name, phone_masked, status, enabled, created_at, updated_at, user_id)
    VALUES ('account-other', 'Other', '+86*******0000', 'connected', 1, ?, ?, 'user-other')`).run(
    "2026-07-22T07:00:00.000Z", "2026-07-22T07:00:00.000Z",
  );
  for (const [id, userId, accountId] of [
    ["upload-expired-legacy", "legacy-admin", "account-legacy"],
    ["upload-expired-other", "user-other", "account-other"],
  ]) {
    sqlite.prepare(`INSERT INTO media_uploads
      (id, user_id, account_id, file_name, content_type, content_kind, size_bytes, total_chunks,
       uploaded_chunks, status, attempt_count, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'old.bin', 'application/octet-stream', 'document', 1, 1, 0,
       'created', 0, '2026-07-22T07:30:00.000Z', '2026-07-22T07:00:00.000Z', '2026-07-22T07:00:00.000Z')`)
      .run(id, userId, accountId);
  }

  await __test.expireUploads(repository, "2026-07-22T08:00:00.000Z", "legacy-admin");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM media_uploads WHERE id = ?")
    .get("upload-expired-legacy").total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM media_uploads WHERE id = ?")
    .get("upload-expired-other").total, 1);
});

test("media staging and scheduled runs never share one Telegram account session", async () => {
  const { sqlite, repository } = createTestRepository();
  const now = "2026-07-22T08:00:00.000Z";
  await seedAccount(repository, { id: "account-shared", timestamp: now });
  await seedTask(repository, { id: "task-active", accountId: "account-shared", timestamp: now });
  await repository.enqueueRun({
    run: {
      id: "run-active", task_id: "task-active", trigger_type: "manual", scheduled_for: now,
      dedupe_key: "manual:run-active", max_attempts: 1,
      claim_expires_at: "2026-07-22T09:00:00.000Z", created_at: now, updated_at: now,
    },
  });
  assert.ok(await repository.claimRun(
    "run-active", "github-1", now, "2026-07-22T08:15:00.000Z",
  ));
  sqlite.prepare(`INSERT INTO media_uploads
    (id, user_id, account_id, file_name, content_type, content_kind, size_bytes, total_chunks,
     uploaded_chunks, status, attempt_count, expires_at, created_at, updated_at)
    VALUES ('upload-waiting', 'legacy-admin', 'account-shared', 'wait.bin',
     'application/octet-stream', 'document', 1, 1, 1, 'queued', 0,
     '2026-07-22T08:30:00.000Z', ?, ?)`).run(now, now);

  const blockedUpload = await handleListenerMediaUploadApi(listenerRequest(
    "/api/listener/v1/media-uploads/claim",
    { method: "POST", body: { instance_id: "listener-vps-1" } },
  ), { LISTENER_API_TOKEN: LISTENER_TOKEN }, repository, context());
  assert.equal((await blockedUpload.json()).data, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM media_upload_leases").get().total, 0);

  sqlite.prepare("DELETE FROM account_leases WHERE account_id = 'account-shared'").run();
  sqlite.prepare("UPDATE task_runs SET status = 'success' WHERE id = 'run-active'").run();
  sqlite.prepare(`INSERT INTO media_upload_leases
    (account_id, upload_id, holder, leased_until, created_at, updated_at)
    VALUES ('account-shared', 'upload-waiting', 'listener-vps-1',
      '2026-07-22T08:15:00.000Z', ?, ?)`).run(now, now);

  await seedTask(repository, { id: "task-blocked", accountId: "account-shared", timestamp: now });
  await repository.enqueueRun({
    run: {
      id: "run-blocked", task_id: "task-blocked", trigger_type: "manual", scheduled_for: now,
      dedupe_key: "manual:run-blocked", max_attempts: 1,
      claim_expires_at: "2026-07-22T09:00:00.000Z", created_at: now, updated_at: now,
    },
  });
  assert.equal(await repository.claimRun(
    "run-blocked", "github-2", now, "2026-07-22T08:15:00.000Z",
  ), null);
  assert.deepEqual(await repository.listDispatchableAccountIds(now, 10), []);
});

test("ambiguous Telegram staging is terminal, private and idempotent", async () => {
  const { sqlite, repository } = createTestRepository();
  await seedAccount(repository, { id: "account-ambiguous" });
  const now = "2026-07-22T08:00:00.000Z";
  sqlite.prepare(`INSERT INTO media_uploads
    (id, user_id, account_id, file_name, content_type, content_kind, size_bytes, total_chunks,
     uploaded_chunks, status, attempt_count, claimed_by, expires_at, created_at, updated_at)
    VALUES ('upload-ambiguous', 'legacy-admin', 'account-ambiguous', 'clip.mp4', 'video/mp4',
      'video', 1, 1, 1, 'processing', 1, 'listener-vps-1', '2026-07-22T08:30:00.000Z', ?, ?)`)
    .run(now, now);
  sqlite.prepare(`INSERT INTO media_upload_leases
    (account_id, upload_id, holder, leased_until, created_at, updated_at)
    VALUES ('account-ambiguous', 'upload-ambiguous', 'listener-vps-1',
      '2026-07-22T08:15:00.000Z', ?, ?)`).run(now, now);
  const request = () => listenerRequest(
    "/api/listener/v1/media-uploads/upload-ambiguous/complete",
    { method: "POST", body: {
      instance_id: "listener-vps-1", status: "ambiguous", error_code: "telegram_transport",
      error_message: "Telegram 返回结果不确定；请检查收藏夹。",
    } },
  );
  assert.equal((await handleListenerMediaUploadApi(
    request(), { LISTENER_API_TOKEN: LISTENER_TOKEN }, repository, context(),
  )).status, 200);
  assert.equal(sqlite.prepare("SELECT status FROM media_uploads WHERE id = 'upload-ambiguous'").get().status, "ambiguous");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM media_upload_leases").get().total, 0);
  const replay = await handleListenerMediaUploadApi(
    request(), { LISTENER_API_TOKEN: LISTENER_TOKEN }, repository, context(),
  );
  assert.equal((await replay.json()).data.replayed, true);
});
