import assert from "node:assert/strict";
import test from "node:test";

import { withDispatchErrorCodes, __test } from "./src/dispatch-repository.js";

function database() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

test("dispatch error prefixes are parsed into stable codes", () => {
  assert.equal(
    __test.dispatchErrorCode("[github_dispatch_timeout] AbortError: timed out"),
    "github_dispatch_timeout",
  );
  assert.equal(__test.dispatchErrorCode("GitHub workflow dispatch failed"), null);
  assert.equal(__test.dispatchErrorCode("[INVALID-CODE] message"), null);
});

test("the wrapper corrects the persisted generic dispatch_retry code", async () => {
  const db = database();
  const originalCalls = [];
  const repository = withDispatchErrorCodes({
    db,
    userId: null,
    async markRunDispatchFailed(...args) {
      originalCalls.push(args);
      return true;
    },
  });
  const message = "[github_dispatch_http_error] GitHub workflow dispatch returned HTTP 503.";

  await repository.markRunDispatchFailed("run-1", "2026-07-20T00:00:00.000Z", message);

  assert.deepEqual(originalCalls, [["run-1", "2026-07-20T00:00:00.000Z", message]]);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /UPDATE task_runs SET error_code = \?/);
  assert.deepEqual(db.calls[0].bindings, [
    "github_dispatch_http_error",
    "run-1",
    message,
  ]);
});

test("scoped repositories retain the user boundary when correcting error codes", async () => {
  const db = database();
  const repository = withDispatchErrorCodes({
    db,
    userId: "user-a",
    async markRunDispatchFailed() {},
  });
  const message = "[github_dispatch_network_error] TypeError: network unavailable";

  await repository.markRunDispatchFailed("run-1", "2026-07-20T00:00:00.000Z", message);

  assert.match(db.calls[0].sql, /AND user_id = \?/);
  assert.deepEqual(db.calls[0].bindings, [
    "github_dispatch_network_error",
    "run-1",
    message,
    "user-a",
  ]);
});

test("messages without a stable prefix keep the original repository behavior", async () => {
  const db = database();
  let called = false;
  const repository = withDispatchErrorCodes({
    db,
    async markRunDispatchFailed() {
      called = true;
    },
  });

  await repository.markRunDispatchFailed(
    "run-1",
    "2026-07-20T00:00:00.000Z",
    "legacy dispatch failure",
  );

  assert.equal(called, true);
  assert.deepEqual(db.calls, []);
});
