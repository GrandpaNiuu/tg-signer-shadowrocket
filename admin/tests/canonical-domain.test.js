import assert from "node:assert/strict";
import test from "node:test";

import { __test, onRequest } from "../functions/_middleware.js";

test("pages.dev requests redirect permanently to the configured production domain", async () => {
  const response = await onRequest({
    request: new Request("https://telegram-checkin-admin.pages.dev/tasks?status=failed"),
    env: { CANONICAL_HOST: "grandpaniu.ccwu.cc" },
    next: () => assert.fail("pages.dev must not reach the application"),
  });

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://grandpaniu.ccwu.cc/tasks?status=failed");
});

test("the production domain continues to Pages without a redirect", async () => {
  const expected = new Response("ok");
  const response = await onRequest({
    request: new Request("https://grandpaniu.ccwu.cc/"),
    env: { CANONICAL_HOST: "grandpaniu.ccwu.cc" },
    next: async () => expected,
  });
  assert.equal(response, expected);
});

test("an invalid canonical host falls back to the pinned production domain", () => {
  assert.equal(__test.canonicalHost({ CANONICAL_HOST: "bad host/path" }), "grandpaniu.ccwu.cc");
});
