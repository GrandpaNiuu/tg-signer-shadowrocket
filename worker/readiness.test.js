import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "./src/app.js";

function fixedUuid() {
  return "readiness-request-id";
}

function readyEnv(overrides = {}) {
  return {
    DB: {
      prepare(sql) {
        assert.equal(sql, "SELECT 1 AS ready");
        return {
          async first() {
            return { ready: 1 };
          },
        };
      },
    },
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "configured",
    RUNNER_OIDC_AUDIENCE: "https://worker.example/api/runner",
    TASK_RUNNER_WORKFLOW_FILE: "task-runner.yml",
    LOGIN_WORKFLOW_FILE: "telegram-login.yml",
    ADMIN_ORIGIN: "https://admin.example",
    ...overrides,
  };
}

test("health remains a liveness check without dependencies", async () => {
  const worker = createWorker({ uuid: fixedUuid });
  const response = await worker.fetch(new Request("https://example.test/health"), {});

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    worker: "tg-signer-shadowrocket",
  });
});

test("ready returns 200 when database and required configuration are available", async () => {
  const worker = createWorker({ uuid: fixedUuid });
  const response = await worker.fetch(new Request("https://example.test/ready"), readyEnv());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "readiness-request-id");
  assert.deepEqual(await response.json(), {
    ok: true,
    worker: "tg-signer-shadowrocket",
    checks: {
      database: "ok",
      configuration: "ok",
      credentials: "ok",
    },
  });
});

test("ready returns 503 and safe diagnostics when dependencies are missing", async () => {
  const worker = createWorker({ uuid: fixedUuid });
  const response = await worker.fetch(new Request("https://example.test/ready"), {});

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    worker: "tg-signer-shadowrocket",
    checks: {
      database: "missing",
      configuration: "missing",
      credentials: "missing",
    },
    missing_configuration: [
      "GITHUB_OWNER",
      "GITHUB_REPO",
      "RUNNER_OIDC_AUDIENCE",
      "TASK_RUNNER_WORKFLOW_FILE",
      "LOGIN_WORKFLOW_FILE",
      "ADMIN_ORIGIN",
    ],
  });
});

test("ready hides database error details", async () => {
  const worker = createWorker({ uuid: fixedUuid });
  const env = readyEnv({
    DB: {
      prepare() {
        return {
          async first() {
            throw new Error("sensitive database failure details");
          },
        };
      },
    },
  });
  const response = await worker.fetch(new Request("https://example.test/ready"), env);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.checks.database, "error");
  assert.equal(JSON.stringify(body).includes("sensitive database failure details"), false);
});