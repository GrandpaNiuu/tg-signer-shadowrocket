import assert from "node:assert/strict";
import test from "node:test";

import { publicPasswordAuthConfiguration, __test } from "../src/public-auth-configuration.js";

function secureEnv(from) {
  return {
    ADMIN_ORIGIN: "https://admin.example.com",
    PASSWORD_PEPPER: "test-only-password-pepper",
    TURNSTILE_SITE_KEY: "turnstile-site",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    RESEND_API_KEY: "resend-key",
    AUTH_EMAIL_FROM: from,
    PUBLIC_PASSWORD_AUTH_MODE: "secure",
  };
}

test("secure public registration requires a custom production sender domain", () => {
  for (const from of [
    "onboarding@resend.dev",
    "Telegram <onboarding@resend.dev>",
    "Telegram <sender@mail.resend.dev>",
    "not-an-email",
  ]) {
    const config = publicPasswordAuthConfiguration(secureEnv(from));
    assert.equal(config.registrationEnabled, false, from);
    assert.equal(config.passwordResetEnabled, false, from);
    assert.equal(config.emailFrom, null, from);
    assert.equal(config.securitySetupRequired, true, from);
  }
});

test("secure public registration accepts a syntactically valid custom sender", () => {
  const config = publicPasswordAuthConfiguration(secureEnv("Telegram 自动消息 <login@send.example.com>"));
  assert.equal(config.registrationEnabled, true);
  assert.equal(config.emailVerificationRequired, true);
  assert.equal(config.passwordResetEnabled, true);
  assert.equal(config.emailFrom, "Telegram 自动消息 <login@send.example.com>");
  assert.equal(config.senderDomain, "send.example.com");
});

test("sender parsing supports display names without accepting Resend's test domain", () => {
  assert.equal(__test.senderAddress("Telegram <LOGIN@Example.com>"), "login@example.com");
  assert.equal(__test.productionSenderDomain("Telegram <LOGIN@Example.com>"), "example.com");
  assert.equal(__test.productionSenderDomain("onboarding@resend.dev"), null);
});
