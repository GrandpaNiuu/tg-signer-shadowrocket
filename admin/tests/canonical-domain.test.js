import assert from "node:assert/strict";
import test from "node:test";

import { __test, onRequest } from "../functions/_middleware.js";

test("the production pages.dev domain continues without a redirect", async () => {
  const expected = new Response("ok");
  const response = await onRequest({
    request: new Request("https://telegram-checkin-admin.pages.dev/tasks?status=failed"),
    env: { CANONICAL_HOST: "telegram-checkin-admin.pages.dev" },
    next: async () => expected,
  });

  assert.equal(response, expected);
});

test("a non-production pages.dev hostname redirects to the configured host", async () => {
  const response = await onRequest({
    request: new Request("https://preview.telegram-checkin-admin.pages.dev/tasks?status=failed"),
    env: { CANONICAL_HOST: "telegram-checkin-admin.pages.dev" },
    next: () => assert.fail("preview pages.dev must not reach the application"),
  });

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://telegram-checkin-admin.pages.dev/tasks?status=failed",
  );
});

test("an invalid canonical host falls back to the pinned production domain", () => {
  assert.equal(
    __test.canonicalHost({ CANONICAL_HOST: "bad host/path" }),
    "telegram-checkin-admin.pages.dev",
  );
});
