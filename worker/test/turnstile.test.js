import assert from "node:assert/strict";
import test from "node:test";

import { verifyTurnstileToken, __test } from "../src/turnstile.js";

const request = new Request("https://tg-signer-shadowrocket.q3j1h8.workers.dev/api/auth/email/register", {
  headers: {
    "cf-connecting-ip": "203.0.113.10",
    origin: "https://grandpaniu.ccwu.cc",
    referer: "https://grandpaniu.ccwu.cc/#/register",
  },
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

test("Turnstile accepts the configured frontend hostname and expected action", async () => {
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

test("Turnstile accepts the actual browser origin when the API runs on another hostname", async () => {
  const aliasRequest = new Request("https://tg-signer-shadowrocket.q3j1h8.workers.dev/api/auth/email/login", {
    headers: { origin: "https://preview.example.pages.dev" },
  });
  const result = await verifyTurnstileToken({
    request: aliasRequest,
    responseToken: "token-value",
    secret: "secret-key",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_login",
    fetchImpl: response({
      success: true,
      hostname: "preview.example.pages.dev",
      action: "email_login",
    }),
  });
  assert.equal(result.success, true);
});

test("Turnstile accepts a valid same-site token when an older widget omitted action", async () => {
  const result = await verifyTurnstileToken({
    request,
    responseToken: "token-value",
    secret: "secret-key",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_login",
    fetchImpl: response({
      success: true,
      hostname: "grandpaniu.ccwu.cc",
    }),
  });
  assert.equal(result.success, true);
});

test("Turnstile rejects a token issued for another non-empty authentication action", async () => {
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
  }), (error) => error?.code === "turnstile_failed"
    && error?.status === 400
    && error?.details?.reason === "action");
});

test("Turnstile rejects a token issued on an unrelated hostname", async () => {
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
  }), (error) => error?.code === "turnstile_failed"
    && error?.details?.reason === "hostname");
});

test("Turnstile exposes actionable messages for expired and invalid configuration responses", async () => {
  await assert.rejects(() => verifyTurnstileToken({
    request,
    responseToken: "token-value",
    secret: "secret-key",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_login",
    fetchImpl: response({ success: false, "error-codes": ["timeout-or-duplicate"] }),
  }), (error) => /过期或已被使用/.test(error?.message));

  await assert.rejects(() => verifyTurnstileToken({
    request,
    responseToken: "token-value",
    secret: "secret-key",
    origin: "https://grandpaniu.ccwu.cc",
    action: "email_login",
    fetchImpl: response({ success: false, "error-codes": ["invalid-input-secret"] }),
  }), (error) => /检查 Turnstile 密钥/.test(error?.message));
});

test("Turnstile fails closed on network and invalid API responses", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("network unavailable"); },
    response({}, 502),
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
  assert.deepEqual([...__test.expectedHostnames(request, "https://grandpaniu.ccwu.cc")].sort(), [
    "grandpaniu.ccwu.cc",
    "tg-signer-shadowrocket.q3j1h8.workers.dev",
  ]);
  assert.equal(__test.timeoutFromEnv({}), 5000);
  assert.equal(__test.timeoutFromEnv({ TURNSTILE_VERIFY_TIMEOUT_MS: "999" }), 5000);
  assert.equal(__test.timeoutFromEnv({ TURNSTILE_VERIFY_TIMEOUT_MS: "10000" }), 10000);
  assert.equal(__test.timeoutFromEnv({ TURNSTILE_VERIFY_TIMEOUT_MS: "10001" }), 5000);
});