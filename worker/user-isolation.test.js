import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "./src/app.js";
import { createD1Repository } from "./src/repository.js";

function recordingDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            async first() { return null; },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 0 } }; },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  };
}

test("scoped account reads always bind the authenticated user id", async () => {
  const db = recordingDb();
  const repository = createD1Repository(db).forUser({ user_id: "user-a", role: "user" });

  assert.equal(await repository.getAccount("account-b"), null);
  assert.match(db.calls[0].sql, /WHERE id = \?\s+AND user_id = \?/);
  assert.deepEqual(db.calls[0].bindings, ["account-b", "user-a"]);
});

test("scoped task reads always bind the authenticated user id", async () => {
  const db = recordingDb();
  const repository = createD1Repository(db).forUser({ user_id: "user-a", role: "user" });

  assert.equal(await repository.getTask("task-b"), null);
  assert.match(db.calls[0].sql, /WHERE t\.id = \?\s+AND t\.user_id = \?/);
  assert.deepEqual(db.calls[0].bindings, ["task-b", "user-a"]);
});

test("scoped run reads always bind the authenticated user id", async () => {
  const db = recordingDb();
  const repository = createD1Repository(db).forUser({ user_id: "user-a", role: "user" });

  assert.equal(await repository.getRun("run-b"), null);
  assert.match(db.calls[0].sql, /WHERE r\.id = \?\s+AND r\.user_id = \?/);
  assert.deepEqual(db.calls[0].bindings, ["run-b", "user-a"]);
});

test("admin account routes use the user-scoped repository", async () => {
  const calls = [];
  const scoped = {
    async getAccount(id) {
      calls.push(["scoped", id]);
      return null;
    },
  };
  const root = {
    forUser(identity) {
      calls.push(["forUser", identity.user_id]);
      return scoped;
    },
    async getAccount(id) {
      calls.push(["root", id]);
      throw new Error("unscoped repository must not be used");
    },
  };
  const worker = createWorker({
    uuid: () => "request-id",
    repositoryFactory: () => root,
    verifyAdmin: async () => ({ user_id: "user-a", role: "user" }),
  });

  const response = await worker.fetch(
    new Request("https://example.test/api/v1/accounts/account-b"),
    {},
  );

  assert.equal(response.status, 404);
  assert.deepEqual(calls, [
    ["forUser", "user-a"],
    ["scoped", "account-b"],
  ]);
});

test("a user cannot manually execute a task outside their scoped workspace", async () => {
  const calls = [];
  const scoped = {
    async getTask(id) {
      calls.push(["scoped", id]);
      return null;
    },
  };
  const root = {
    forUser(identity) {
      calls.push(["forUser", identity.user_id]);
      return scoped;
    },
  };
  const worker = createWorker({
    uuid: () => "request-id",
    repositoryFactory: () => root,
    verifyAdmin: async () => ({ user_id: "user-a", role: "user" }),
  });

  const response = await worker.fetch(new Request(
    "https://example.test/api/v1/tasks/task-b/runs",
    {
      method: "POST",
      headers: { "idempotency-key": "cross-user-attempt" },
      body: "{}",
    },
  ), {});

  assert.equal(response.status, 404);
  assert.deepEqual(calls, [
    ["forUser", "user-a"],
    ["scoped", "task-b"],
  ]);
});
