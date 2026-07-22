import assert from "node:assert/strict";
import test from "node:test";

import {
  __test,
  handleListenerMediaUploadApi,
  handleWorkspaceMediaUploadApi,
} from "../src/media-upload-api.js";
import { createTestRepository, seedAccount } from "./d1-helper.js";

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
