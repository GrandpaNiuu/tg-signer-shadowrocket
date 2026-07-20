import assert from "node:assert/strict";
import test from "node:test";

import { sendTransactionalEmail, __test } from "../src/email-delivery.js";

const message = {
  to: ["user@example.com"],
  subject: "Test",
  html: "<p>Test</p>",
};

test("transactional email sends only the expected provider payload", async () => {
  let captured;
  const response = await sendTransactionalEmail({
    apiKey: "resend-key",
    from: "Auth <auth@example.com>",
    message,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body) };
      return Response.json({ id: "email-1" });
    },
  });
  assert.equal(response.ok, true);
  assert.equal(captured.url, "https://api.resend.com/emails");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer resend-key");
  assert.ok(captured.init.signal);
  assert.deepEqual(captured.body, { from: "Auth <auth@example.com>", ...message });
});

test("transactional email fails closed on HTTP and network errors", async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 503 }),
    async () => { throw new Error("network unavailable"); },
  ]) {
    await assert.rejects(() => sendTransactionalEmail({
      apiKey: "resend-key",
      from: "Auth <auth@example.com>",
      message,
      fetchImpl,
    }), (error) => error?.status === 502 && error?.code === "email_delivery_failed");
  }
});

test("email delivery timeout configuration is bounded", () => {
  assert.equal(__test.timeoutFromEnv({}), 8000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "999" }), 8000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "1000" }), 1000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "15000" }), 15000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "15001" }), 8000);
});
