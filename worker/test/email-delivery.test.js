import assert from "node:assert/strict";
import test from "node:test";

import { sendTransactionalEmail, __test } from "../src/email-delivery.js";

const message = {
  to: ["user@example.com"],
  subject: "Test",
  html: "<p>Verification code: <strong>123456</strong></p>",
};

test("transactional email sends HTML and plain text with the expected provider payload", async () => {
  let captured;
  const result = await sendTransactionalEmail({
    apiKey: "resend-key",
    from: "Auth <auth@example.com>",
    message,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body) };
      return Response.json({ id: "email-1" });
    },
  });
  assert.deepEqual(result, { id: "email-1", provider: "resend" });
  assert.equal(captured.url, "https://api.resend.com/emails");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer resend-key");
  assert.ok(captured.init.signal);
  assert.deepEqual(captured.body, {
    from: "Auth <auth@example.com>",
    ...message,
    text: "Verification code: 123456",
  });
});

test("transactional email preserves an explicitly supplied plain-text body", async () => {
  let body;
  await sendTransactionalEmail({
    apiKey: "resend-key",
    from: "Auth <auth@example.com>",
    message: { ...message, text: "Explicit text" },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ id: "email-2" });
    },
  });
  assert.equal(body.text, "Explicit text");
});

test("transactional email exposes actionable sender-domain configuration failures", async () => {
  await assert.rejects(() => sendTransactionalEmail({
    apiKey: "resend-key",
    from: "Auth <onboarding@resend.dev>",
    message,
    fetchImpl: async () => Response.json({
      name: "validation_error",
      message: "You can only send testing emails to your own email address. Please verify a domain.",
    }, { status: 403 }),
  }), (error) => error?.status === 502
    && error?.code === "email_sender_not_verified"
    && /验证自有发件域名/.test(error?.message));
});

test("transactional email distinguishes provider rate limits", async () => {
  await assert.rejects(() => sendTransactionalEmail({
    apiKey: "resend-key",
    from: "Auth <auth@example.com>",
    message,
    fetchImpl: async () => Response.json({ name: "rate_limit_exceeded" }, { status: 429 }),
  }), (error) => error?.status === 502 && error?.code === "email_provider_rate_limited");
});

test("transactional email fails closed on HTTP, network, and malformed success responses", async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response(null, { status: 503 }), "email_delivery_unavailable"],
    [async () => { throw new Error("network unavailable"); }, "email_delivery_unavailable"],
    [async () => Response.json({}), "email_delivery_invalid_response"],
  ]) {
    await assert.rejects(() => sendTransactionalEmail({
      apiKey: "resend-key",
      from: "Auth <auth@example.com>",
      message,
      fetchImpl,
    }), (error) => error?.status === 502 && error?.code === code);
  }
});

test("email delivery helpers avoid exposing full recipient addresses", () => {
  assert.deepEqual(__test.recipientDomains({
    to: ["first@example.com", "second@example.com", "third@another.test"],
  }), ["example.com", "another.test"]);
  assert.equal(__test.htmlToText("<p>验证码 <strong>123456</strong></p>"), "验证码 123456");
});

test("email delivery timeout configuration is bounded", () => {
  assert.equal(__test.timeoutFromEnv({}), 8000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "999" }), 8000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "1000" }), 1000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "15000" }), 15000);
  assert.equal(__test.timeoutFromEnv({ AUTH_EMAIL_TIMEOUT_MS: "15001" }), 8000);
});
