import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  handleWorkspaceDialogDirectoryApi,
  __test,
} from "./src/dialog-directory-api.js";

const migrationUrl = new URL("./migrations/0109_account_dialog_directory.sql", import.meta.url);
const appUrl = new URL("./src/app.js", import.meta.url);

function listingRepository({ owned = true } = {}) {
  const sql = [];
  return {
    userId: "user-1",
    sql,
    async getAccount(id) {
      return owned && id === "account-1"
        ? { id, user_id: "user-1", status: "connected", enabled: true }
        : null;
    },
    db: {
      prepare(statement) {
        const source = String(statement);
        sql.push(source);
        return {
          bind() {
            return {
              async all() {
                if (source.includes("FROM account_dialogs")) {
                  return {
                    results: [{
                      peer_id: "998877",
                      target: "@buyer_a",
                      peer_type: "private",
                      title: "采购经理",
                      username: "buyer_a",
                      label: "采购经理（@buyer_a） · 好友",
                      is_writable: 1,
                      last_message_at: "2026-07-23T00:00:00.000Z",
                      synced_at: "2026-07-23T00:01:00.000Z",
                    }],
                  };
                }
                return { results: [] };
              },
              async first() {
                if (source.includes("FROM account_dialog_syncs")) {
                  return {
                    id: "sync-1",
                    account_id: "account-1",
                    status: "success",
                    dialog_count: 1,
                    created_at: "2026-07-23T00:00:00.000Z",
                    updated_at: "2026-07-23T00:01:00.000Z",
                    finished_at: "2026-07-23T00:01:00.000Z",
                  };
                }
                return null;
              },
            };
          },
        };
      },
    },
  };
}

test("dialog directory migration is isolated by both user and Telegram account", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS account_dialog_syncs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS account_dialogs/);
  assert.match(migration, /user_id TEXT NOT NULL REFERENCES users/);
  assert.match(migration, /account_id TEXT NOT NULL REFERENCES accounts/);
  assert.match(migration, /PRIMARY KEY \(account_id, peer_id\)/);
  assert.match(migration, /'private', 'bot', 'group', 'supergroup', 'channel'/);
});

test("dialog input accepts a hidden numeric target while preserving a readable label", () => {
  assert.deepEqual(__test.dialogInput({
    peer_id: "998877",
    target: "998877",
    peer_type: "private",
    title: "采购经理",
    username: "",
    label: "采购经理 · 好友",
    is_writable: true,
    last_message_at: "2026-07-23T00:00:00.000Z",
  }, 0), {
    peer_id: "998877",
    target: "998877",
    peer_type: "private",
    title: "采购经理",
    username: null,
    label: "采购经理 · 好友",
    is_writable: 1,
    last_message_at: "2026-07-23T00:00:00.000Z",
  });
  assert.throws(() => __test.dialogInput({
    peer_id: "1",
    target: "https://example.com",
    peer_type: "private",
    title: "错误目标",
    label: "错误目标",
  }, 0), /格式不正确/);
});

test("workspace lists only dialogs belonging to the selected owned account", async () => {
  const repository = listingRepository();
  const response = await handleWorkspaceDialogDirectoryApi(
    new Request("https://worker.example/api/v1/account-dialogs?account_id=account-1"),
    {},
    repository,
    {},
  );
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.account_id, "account-1");
  assert.equal(data.dialogs.length, 1);
  assert.equal(data.dialogs[0].label, "采购经理（@buyer_a） · 好友");
  assert.equal(data.dialogs[0].target, "@buyer_a");
  assert.equal(data.dialogs[0].is_writable, true);
  assert.equal(data.sync.status, "success");
  assert.ok(repository.sql.some((source) => source.includes("WHERE user_id = ? AND account_id = ?")));
});

test("workspace cannot inspect a Telegram account owned by another user", async () => {
  await assert.rejects(() => handleWorkspaceDialogDirectoryApi(
    new Request("https://worker.example/api/v1/account-dialogs?account_id=account-2"),
    {},
    listingRepository({ owned: false }),
    {},
  ), (error) => error?.status === 404 && error?.code === "account_not_found");
});

test("Worker exposes both user and Listener dialog directory routes before generic handlers", async () => {
  const app = await readFile(appUrl, "utf8");
  assert.match(app, /handleWorkspaceDialogDirectoryApi/);
  assert.match(app, /handleListenerDialogDirectoryApi/);
  const dialogRoute = app.indexOf('url.pathname.startsWith("\/api\/listener\/v1\/dialog-syncs")');
  const genericRoute = app.indexOf('url.pathname.startsWith("\/api\/listener\/v1\/")');
  assert.ok(dialogRoute >= 0 && dialogRoute < genericRoute);
});
