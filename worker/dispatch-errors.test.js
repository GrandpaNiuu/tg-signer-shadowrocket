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

function repository() {
  const failures = [];
  return {
    failures,
    async reserveNextDispatch() {
      return { id: "run-1" };
    },
    async markRunDispatchFailed(...args) {
      failures.push(args);
    },
    async markRunDispatched() {},
    async listDispatchableAccountIds() {
      return ["account-1"];
    },
  };
}

test("HTTP dispatch failures use a stable error code", async () => {
  const repo = repository();
  const result = await dispatchNextForAccount("account-1", {
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "token",
  }, {
    repository: repo,
    now: fixedNow,
    fetch: async () => new Response(null, { status: 503 }),
  });

  assert.equal(result.error_code, DISPATCH_ERROR_CODES.HTTP);
  assert.match(repo.failures[0][2], /^\[github_dispatch_http_error\]/);
});

test("network dispatch failures use a stable error code", async () => {
  const repo = repository();
  const result = await dispatchNextForAccount("account-1", {
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "token",
  }, {
    repository: repo,
    now: fixedNow,
    fetch: async () => {
      throw new TypeError("network unavailable");
    },
  });

  assert.equal(result.error_code, DISPATCH_ERROR_CODES.NETWORK);
  assert.match(repo.failures[0][2], /^\[github_dispatch_network_error\]/);
});

test("dispatch summary groups failures by stable code", async () => {
  const repo = repository();
  const summary = await dispatchPendingRuns({
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "token",
  }, {
    repository: repo,
    now: fixedNow,
    fetch: async () => new Response(null, { status: 500 }),
  });

  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failures_by_code, {
    github_dispatch_http_error: 1,
  });
});
