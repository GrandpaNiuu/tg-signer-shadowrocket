import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";

function responseJson(response) {
  return response.json();
}

function userScoped(repository) {
  return {
    ...repository,
    forUser() {
      return repository;
    },
  };
}

test("retired legacy /run endpoint is not exposed", async () => {
  const calls = [];
  const worker = createWorker({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  const response = await worker.fetch(new Request("https://worker.example/run"), {});
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test("scheduled handler uses only the D1 scheduler", async () => {
  const calls = [];
  const worker = createWorker({
    fetch: async (url) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    },
    repositoryFactory: () => ({
      async reconcileRuns() {},
      async getDueTasks() { return []; },
      async listDispatchableAccountIds() { return []; },
    }),
  });
  let pending;

  await worker.scheduled(
    { cron: "* * * * *", scheduledTime: Date.parse("2026-07-18T16:00:00.000Z") },
    {
      DB: {},
      SCHEDULE_DISPATCH_LEAD_SECONDS: "90",
    },
    { waitUntil(value) { pending = value; } },
  );
  await pending;

  assert.equal(calls.length, 0);
});

test("scheduled handler fails closed when D1 mode cannot be read", async () => {
  const calls = [];
  const worker = createWorker({
    fetch: async (url) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    },
    repositoryFactory: () => ({
      async reconcileRuns() {
        throw new Error("temporary D1 failure");
      },
    }),
  });
  let pending;

  await worker.scheduled(
    { cron: "* * * * *", scheduledTime: Date.parse("2026-07-18T16:00:00.000Z") },
    {
      DB: {},
      SCHEDULE_DISPATCH_LEAD_SECONDS: "90",
    },
    { waitUntil(value) { pending = value; } },
  );
  await pending;

  assert.equal(calls.length, 0);
});

test("admin can create an account without secrets appearing in the response", async () => {
  const created = [];
  const repository = userScoped({
    async createAccount(value) {
      created.push(value);
      return {
        id: value.account.id,
        name: value.account.name,
        phone_masked: value.account.phone_masked,
        status: value.account.status,
        enabled: 1,
        created_at: value.account.created_at,
        updated_at: value.account.updated_at,
        last_connected_at: null,
      };
    },
  });
  const worker = createWorker({
    repositoryFactory: () => repository,
    verifyAdmin: async () => ({ email: "admin@example.com" }),
    uuid: (() => {
      let index = 0;
      return () => `id-${++index}`;
    })(),
    now: () => new Date("2026-07-18T00:00:00.000Z"),
  });
  const rootKey = Buffer.alloc(32, 9).toString("base64");
  const response = await worker.fetch(new Request("https://worker.example/api/v1/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Primary",
      phone: "+8613812345678",
      api_id: "123456",
      api_hash: "0123456789abcdef0123456789abcdef",
      session: "test-session-value-with-enough-length",
    }),
  }), { DB: {}, SECRET_ROOT_KEY: rootKey });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.data.name, "Primary");
  assert.equal(payload.data.phone_masked.endsWith("5678"), true);
  assert.equal(JSON.stringify(payload).includes("test-session"), false);
  assert.equal(created.length, 1);
  assert.equal(created[0].secrets.length, 4);
  assert.equal(created[0].secrets.every((secret) => secret.ciphertext && !secret.plaintext), true);
});

test("admin API rejects unknown and invalid account fields with a uniform error", async () => {
  const repository = userScoped({
    createAccount: async () => assert.fail("repository must not be called"),
  });
  const worker = createWorker({
    repositoryFactory: () => repository,
    verifyAdmin: async () => ({ email: "admin@example.com" }),
    uuid: () => "request-id",
  });
  const response = await worker.fetch(new Request("https://worker.example/api/v1/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x", phone: "not-a-phone", unexpected: true }),
  }), { DB: {}, SECRET_ROOT_KEY: Buffer.alloc(32).toString("base64") });

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: {
      code: "validation_failed",
      message: "Request validation failed.",
      details: { fields: ["unexpected"] },
    },
    request_id: "request-id",
  });
});
