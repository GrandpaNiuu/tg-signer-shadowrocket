import assert from "node:assert/strict";
import test from "node:test";

import { runLiveWorkerAudit, validateWorkerReadiness } from "./live-worker-audit.mjs";

const READY = {
  ok: true,
  worker: "tg-signer-shadowrocket",
  checks: {
    database: "ok",
    configuration: "ok",
    credentials: "ok",
    github_token: "ok",
    secret_root_key: "ok",
    realtime_listener: "disabled",
  },
};

test("readiness requires the realtime D1 schema and listener state", () => {
  assert.deepEqual(validateWorkerReadiness(READY), {
    database: "ok",
    configuration: "ok",
    credentials: "ok",
    realtime_listener: "disabled",
  });
  assert.throws(() => validateWorkerReadiness({
    ...READY,
    checks: { ...READY.checks, database: "schema_missing" },
  }), /database is schema_missing/);
  assert.throws(() => validateWorkerReadiness({
    ...READY,
    checks: { ...READY.checks, realtime_listener: undefined },
  }), /listener readiness field/);
});

test("live Worker audit checks health before readiness", async () => {
  const calls = [];
  const result = await runLiveWorkerAudit({
    workerUrl: "https://worker.example",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, worker: "tg-signer-shadowrocket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(READY), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(calls, ["https://worker.example/health", "https://worker.example/ready"]);
  assert.equal(result.database, "ok");
  assert.equal(result.realtime_listener, "disabled");
});
