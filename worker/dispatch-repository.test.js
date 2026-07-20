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

test("the wrapper persists retry scheduling and the stable error code atomically", async () => {
  const db = database();
  let legacyCalls = 0;
  const repository = withDispatchErrorCodes({
    db,
    userId: null,
    async markRunDispatchFailed() {
      legacyCalls += 1;
    },
  });
  const timestamp = "2026-07-20T00:00:00.000Z";
  const message = "[github_dispatch_http_error] GitHub workflow dispatch returned HTTP 503.";

  await repository.markRunDispatchFailed("run-1", timestamp, message);

  assert.equal(legacyCalls, 0);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /dispatch_status = 'pending'/);
  assert.match(db.calls[0].sql, /error_code = \?/);
  assert.deepEqual(db.calls[0].bindings, [
    "2026-07-20T00:01:00.000Z",
    "github_dispatch_http_error",
    message,
    timestamp,
    "run-1",
  ]);
});

test("scoped repositories retain the user boundary in the atomic update", async () => {
  const db = database();
  const repository = withDispatchErrorCodes({
    db,
    userId: "user-a",
    async markRunDispatchFailed() {},
  });
  const timestamp = "2026-07-20T00:00:00.000Z";
  const message = "[github_dispatch_network_error] TypeError: network unavailable";

  await repository.markRunDispatchFailed("run-1", timestamp, message);

  assert.match(db.calls[0].sql, /AND user_id = \?/);
  assert.deepEqual(db.calls[0].bindings, [
    "2026-07-20T00:01:00.000Z",
    "github_dispatch_network_error",
    message,
    timestamp,
    "run-1",
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
