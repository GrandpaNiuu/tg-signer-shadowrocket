import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/runner-api-v2.js";

test("claim route parser only matches task claims", () => {
  assert.equal(__test.claimRunId(new URL("https://worker.test/api/runner/runs/run-1/claim")), "run-1");
  assert.equal(__test.claimRunId(new URL("https://worker.test/api/runner/runs/run-1/complete")), null);
});

test("claim enrichment resolves only workspace-owned media assets", async () => {
  const repository = {
    async getExecution() {
      return {
        user_id: "user-1",
        skill_key: "send_media",
        params_json_snapshot: JSON.stringify({
          target: "@target_bot",
          file_id: "media-asset-1234",
          media_type: "photo",
          caption: null,
          message_thread_id: null,
          delete_after: null,
        }),
      };
    },
    db: {
      prepare() {
        return {
          bind(fileId, userId) {
            assert.equal(fileId, "media-asset-1234");
            assert.equal(userId, "user-1");
            return { async first() { return { id: fileId, media_type: "photo", source_chat_id: "-1001", source_message_id: 77 }; } };
          },
        };
      },
    },
  };
  const payload = await __test.enrichClaim({ task: { skill: "send_media", params: {} } }, "run-1", repository);
  assert.equal(payload.task.params._source_chat_id, "-1001");
  assert.equal(payload.task.params._source_message_id, 77);
});

test("direct Telegram content claims bypass the legacy media registry", async () => {
  const repository = {
    async getExecution() {
      return {
        user_id: "user-1",
        skill_key: "send_media",
        params_json_snapshot: JSON.stringify({
          target: "@target_bot",
          source_chat_id: "me",
          source_message_id: 42,
          caption: null,
          message_thread_id: null,
          delete_after: null,
        }),
      };
    },
    db: { prepare() { assert.fail("direct content must not query media_assets"); } },
  };
  const payload = await __test.enrichClaim({ task: { skill: "send_media", params: {} } }, "run-1", repository);
  assert.equal(payload.task.params.source_chat_id, "me");
  assert.equal(payload.task.params.source_message_id, 42);
  assert.equal(payload.task.params._source_error, undefined);
});

test("retired Skill claims are rejected before Runner execution", async () => {
  for (const skill of ["account_audit", "bot_flow", "chat_snapshot"]) {
    const repository = {
      async getExecution() { return { user_id: "user-1", skill_key: skill, params_json_snapshot: "{}" }; },
    };
    await assert.rejects(
      () => __test.enrichClaim({ task: { skill, params: {} } }, "run-1", repository),
      (error) => error?.status === 422 && error?.code === "validation_failed",
    );
  }
});

test("missing media assets become a terminal Skill input error instead of breaking claim transport", async () => {
  const repository = {
    async getExecution() {
      return {
        user_id: "user-1",
        skill_key: "send_media",
        params_json_snapshot: JSON.stringify({
          target: "@target_bot",
          file_id: "media-asset-missing",
          media_type: "video",
          caption: null,
          message_thread_id: null,
          delete_after: null,
        }),
      };
    },
    db: {
      prepare() {
        return { bind() { return { async first() { return null; } }; } };
      },
    },
  };
  const payload = await __test.enrichClaim({ task: { skill: "send_media", params: {} } }, "run-1", repository);
  assert.equal(payload.task.params._source_error, "media_asset_unavailable");
  assert.equal(payload.task.params._source_chat_id, undefined);
});
