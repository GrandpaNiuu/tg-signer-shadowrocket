import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { enforceListenerLeader, __test } from "../src/listener-leader.js";

function responseWithConfig() {
  return new Response(JSON.stringify({
    data: {
      accounts: [{ id: "account-1" }],
      rules: [{ id: "rule-1" }],
    },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-1",
    },
  });
}

function databaseReturning(leaderId) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async run() {
          assert.match(sql, /listener_instances/);
          return { success: true };
        },
        async first() {
          assert.match(sql, /ORDER BY COALESCE\(started_at, last_heartbeat_at\), id/);
          return { id: leaderId };
        },
      };
    },
  };
}

test("leader receives realtime accounts and rules", async () => {
  const request = new Request("https://worker.example/api/listener/v1/config", {
    headers: { "x-listener-instance-id": "listener-a" },
  });
  const response = await enforceListenerLeader(
    request,
    { DB: databaseReturning("listener-a") },
    responseWithConfig(),
    () => new Date("2026-07-21T00:00:00.000Z"),
  );
  const payload = await response.json();
  assert.equal(payload.data.leader, true);
  assert.equal(payload.data.instance_id, "listener-a");
  assert.equal(payload.data.accounts.length, 1);
  assert.equal(payload.data.rules.length, 1);
});

test("standby Listener receives no sessions or rules", async () => {
  const request = new Request("https://worker.example/api/listener/v1/config", {
    headers: { "x-listener-instance-id": "listener-b" },
  });
  const response = await enforceListenerLeader(
    request,
    { DB: databaseReturning("listener-a") },
    responseWithConfig(),
    () => new Date("2026-07-21T00:00:00.000Z"),
  );
  const payload = await response.json();
  assert.equal(payload.data.leader, false);
  assert.deepEqual(payload.data.accounts, []);
  assert.deepEqual(payload.data.rules, []);
});

test("Listener configuration requires a bounded instance id", async () => {
  const response = await enforceListenerLeader(
    new Request("https://worker.example/api/listener/v1/config"),
    { DB: databaseReturning("listener-a") },
    responseWithConfig(),
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "listener_instance_id_required");
  assert.equal(__test.isoOffset("2026-07-21T00:00:00.000Z", -130), "2026-07-20T23:57:50.000Z");
});

test("production Worker entry wraps the authenticated config response", async () => {
  const source = await readFile(new URL("../cloudflare-worker.js", import.meta.url), "utf8");
  assert.match(source, /enforceListenerLeader/);
  assert.match(source, /\/api\/listener\/v1\/config/);
});
