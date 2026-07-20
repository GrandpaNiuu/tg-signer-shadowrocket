import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPATCH_ERROR_CODES,
  dispatchNextForAccount,
  dispatchPendingRuns,
} from "./src/scheduler.js";

function fixedNow() {
  return new Date("2026-07-19T00:00:00.000Z");
}

function repository(overrides = {}) {
  const failures = [];
  return {
    failures,
    async reserveNextDispatch() {
      return { id: "run-1" };
    },
    async markRunDispatchFailed(...args) {
      failures.push(args);
    },
    async markRunDispatched() {
      return true;
    },
    async listDispatchableAccountIds() {
      return ["account-1"];
    },
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "token",
    ...overrides,
  };
}

test("HTTP dispatch failures use a stable error code", async () => {
  const repo = repository();
  const result = await dispatchNextForAccount("account-1", environment(), {
    repository: repo,
    now: fixedNow,
    fetch: async () => new Response(null, { status: 503 }),
  });

  assert.equal(result.error_code, DISPATCH_ERROR_CODES.HTTP);
  assert.match(repo.failures[0][2], /^\[github_dispatch_http_error\]/);
});

test("network dispatch failures use a stable error code", async () => {
  const repo = repository();
  const result = await dispatchNextForAccount("account-1", environment(), {
    repository: repo,
    now: fixedNow,
    fetch: async () => {
      throw new TypeError("network unavailable");
    },
  });

  assert.equal(result.error_code, DISPATCH_ERROR_CODES.NETWORK);
  assert.match(repo.failures[0][2], /^\[github_dispatch_network_error\]/);
});

test("aborted dispatch requests use the timeout error code", async () => {
  const repo = repository();
  const result = await dispatchNextForAccount("account-1", environment(), {
    repository: repo,
    now: fixedNow,
    fetch: async () => {
      const error = new Error("dispatch timed out");
      error.name = "AbortError";
      throw error;
    },
  });

  assert.equal(result.error_code, DISPATCH_ERROR_CODES.TIMEOUT);
  assert.match(repo.failures[0][2], /^\[github_dispatch_timeout\]/);
});

test("missing GitHub configuration is not misclassified as a network failure", async () => {
  const repo = repository();
  const result = await dispatchNextForAccount("account-1", environment({ GITHUB_TOKEN: "" }), {
    repository: repo,
    now: fixedNow,
    fetch: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.error_code, DISPATCH_ERROR_CODES.CONFIG);
  assert.match(repo.failures[0][2], /^\[github_dispatch_config_error\]/);
});

test("a Runner claim race is treated as an accepted dispatch", async () => {
  const repo = repository({
    async markRunDispatched() {
      return false;
    },
  });
  const result = await dispatchNextForAccount("account-1", environment(), {
    repository: repo,
    now: fixedNow,
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.reason, "state_already_advanced");
  assert.equal(repo.failures.length, 0);
});

test("an accepted dispatch is never reset to pending when state persistence throws", async () => {
  const repo = repository({
    async markRunDispatched() {
      throw new Error("database temporarily unavailable");
    },
  });
  const result = await dispatchNextForAccount("account-1", environment(), {
    repository: repo,
    now: fixedNow,
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.reason, "state_update_failed");
  assert.equal(result.warning_code, DISPATCH_ERROR_CODES.STATE_UPDATE);
  assert.equal(repo.failures.length, 0);
});

test("dispatch summary groups failures by stable code", async () => {
  const repo = repository();
  const summary = await dispatchPendingRuns(environment(), {
    repository: repo,
    now: fixedNow,
    fetch: async () => new Response(null, { status: 500 }),
  });

  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failures_by_code, {
    github_dispatch_http_error: 1,
  });
});

test("dispatch summary exposes accepted-dispatch persistence warnings", async () => {
  const repo = repository({
    async markRunDispatched() {
      throw new Error("database temporarily unavailable");
    },
  });
  const summary = await dispatchPendingRuns(environment(), {
    repository: repo,
    now: fixedNow,
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.equal(summary.dispatched, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.warnings_by_code, {
    github_dispatch_state_update_failed: 1,
  });
});
