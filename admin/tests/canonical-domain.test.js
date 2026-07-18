import assert from "node:assert/strict";
import test from "node:test";

import { __test, onRequest } from "../functions/_middleware.js";

test("the custom production domain continues without a redirect", async () => {
  const expected = new Response("ok");
  const response = await onRequest({
    request: new Request("https://grandpaniu.ccwu.cc/tasks?status=failed"),
    env: { CANONICAL_HOST: "grandpaniu.ccwu.cc" },
    next: async () => expected,
  });

  assert.equal(response, expected);
});

test("a pages.dev hostname redirects to the configured custom host", async () => {
  const response = await onRequest({
    request: new Request("https://telegram-checkin-admin.pages.dev/tasks?status=failed"),
    env: { CANONICAL_HOST: "grandpaniu.ccwu.cc" },
    next: () => assert.fail("preview pages.dev must not reach the application"),
  });

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://grandpaniu.ccwu.cc/tasks?status=failed",
  );
});

test("an invalid canonical host falls back to the pinned production domain", () => {
  assert.equal(
    __test.canonicalHost({ CANONICAL_HOST: "bad host/path" }),
    "grandpaniu.ccwu.cc",
  );
});
