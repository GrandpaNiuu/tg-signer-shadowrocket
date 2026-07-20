import assert from "node:assert/strict";
import test from "node:test";

import { verifyTurnstileToken, __test } from "../src/turnstile.js";

const request = new Request("https://grandpaniu.ccwu.cc/api/auth/email/register", {
  headers: { "cf-connecting-ip": "203.0.113.10" },
});

function response(payload, status = 200) {
  return async (_url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("secret"), "secret-key");
    assert.equal(body.get("response"), "token-value");
    assert.equal(body.get("remoteip"), "203.0.113.10");
    assert.ok(init.signal);
    return Response.json(payload, { status });
  };
}

test("Turnstile accepts only the expected hostname and action", async () => {
  const result = await verifyTurnstileToken({
    request,
    responseToken: "token-value",
    secret: "secret-key",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_register",
    fetchImpl: response({
      success: true,
      hostname: "grandpaniu.ccwu.cc",
      action: "email_register",
    }),
  });
  assert.equal(result.success, true);
});

test("Turnstile rejects a token issued for another authentication action", async () => {
  await assert.rejects(() => verifyTurnstileToken({
    request,
    responseToken: "token-value",
    secret: "secret-key",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_login",
    fetchImpl: response({
      success: true,
      hostname: "grandpaniu.ccwu.cc",
      action: "email_register",
    }),
  }), (error) => error?.code === "turnstile_failed" && error?.status === 400);
});

test("Turnstile rejects a token issued on another hostname", async () => {
  await assert.rejects(() => verifyTurnstileToken({
    request,
    responseToken: "token-value",
    secret: "secret-key",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_login",
    fetchImpl: response({
      success: true,
      hostname: "attacker.example",
      action: "email_login",
    }),
  }), (error) => error?.code === "turnstile_failed");
});

test("Turnstile fails closed on network and invalid API responses", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("network unavailable"); },
    response({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    response({ success: true, hostname: "grandpaniu.ccwu.cc" }),
  ]) {
    await assert.rejects(() => verifyTurnstileToken({
      request,
      responseToken: "token-value",
      secret: "secret-key",
      origin: "https://grandpaniu.ccwu.cc",
      action: "email_login",
      fetchImpl,
    }), (error) => error?.code === "turnstile_failed");
  }
});

test("Turnstile skips external validation when no secret is configured", async () => {
  const result = await verifyTurnstileToken({
    request,
    responseToken: "",
    secret: "",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_login",
    fetchImpl: async () => assert.fail("fetch must not be called"),
  });
  assert.equal(result, null);
});

test("Turnstile timeout and hostname helpers use safe bounds", () => {
  assert.equal(__test.expectedHostname("https://GrandpaNiu.ccwu.cc/path"), "grandpaniu.ccwu.cc");
  assert.equal(__test.expectedHostname("not-an-origin"), "");
  assert.equal(__test.timeoutFromEnv({}), 5000);
  assert.equal(__test.timeoutFromEnv({ TURNSTILE_VERIFY_TIMEOUT_MS: "999" }), 5000);
  assert.equal(__test.timeoutFromEnv({ TURNSTILE_VERIFY_TIMEOUT_MS: "10000" }), 10000);
  assert.equal(__test.timeoutFromEnv({ TURNSTILE_VERIFY_TIMEOUT_MS: "10001" }), 5000);
});
