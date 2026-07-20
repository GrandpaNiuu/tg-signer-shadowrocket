import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { hashPassword } from "../src/password.js";
import { publicPasswordAuthConfiguration } from "../src/public-auth-configuration.js";
import { createTestRepository } from "./d1-helper.js";

const ORIGIN = "https://telegram-checkin-admin.pages.dev";
const PASSWORD = "correct horse battery staple";

function request(path, body) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.20",
      "user-agent": "Secure Email Mode Test",
    },
    body: JSON.stringify(body),
  });
}

function baseEnv() {
  return {
    ADMIN_ORIGIN: ORIGIN,
    ADMIN_GITHUB_LOGIN: "GrandpaNiuu",
    ADMIN_GITHUB_USER_ID: "123456",
    PASSWORD_PEPPER: "test-only-password-pepper",
    PASSWORD_HASH_ITERATIONS: "100000",
    PUBLIC_PASSWORD_AUTH_MODE: "secure",
  };
}

async function createLegacyUser(repository, env) {
  const password = await hashPassword(PASSWORD, env);
  return repository.createOrActivateLocalEmailUser({
    id: "user-legacy",
    display_name: "Legacy User",
    email: "legacy@example.com",
    email_normalized: "legacy@example.com",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  }, password);
}

test("secure production mode closes new registration until mail and Turnstile are configured", async () => {
  const { db, repository } = createTestRepository();
  const env = { ...baseEnv(), DB: db };
  const config = publicPasswordAuthConfiguration(env);
  assert.equal(config.enabled, true);
  assert.equal(config.localMode, false);
  assert.equal(config.registrationEnabled, false);
  assert.equal(config.passwordResetEnabled, false);
  assert.equal(config.securitySetupRequired, true);

  const worker = createWorker({ repositoryFactory: () => repository });
  const response = await worker.fetch(request("/api/auth/email/register", {
    email: "new@example.com",
    display_name: "New User",
    password: PASSWORD,
    turnstile_token: "",
  }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "secure_registration_not_configured");
});

test("existing password users can still sign in during secure setup", async () => {
  const { db, repository } = createTestRepository();
  const env = { ...baseEnv(), DB: db };
  await createLegacyUser(repository, env);
  const worker = createWorker({ repositoryFactory: () => repository });

  const response = await worker.fetch(request("/api/auth/email/login", {
    email: "legacy@example.com",
    password: PASSWORD,
    turnstile_token: "",
  }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.match(response.headers.get("set-cookie") || "", /^tg_session=/);
});

test("legacy users receive verification mail after secure services are enabled", async () => {
  const { db, repository, sqlite } = createTestRepository();
  const emails = [];
  const env = {
    ...baseEnv(),
    DB: db,
    TURNSTILE_SITE_KEY: "turnstile-site",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    RESEND_API_KEY: "resend-key",
    AUTH_EMAIL_FROM: "Telegram Check-in <auth@example.com>",
  };
  await createLegacyUser(repository, env);
  const fetch = async (url, init = {}) => {
    if (String(url).includes("turnstile/v0/siteverify")) return Response.json({ success: true });
    if (String(url) === "https://api.resend.com/emails") {
      emails.push(JSON.parse(init.body));
      return Response.json({ id: "mail-1" });
    }
    return new Response(null, { status: 404 });
  };
  const worker = createWorker({ fetch, repositoryFactory: () => repository });

  const login = await worker.fetch(request("/api/auth/email/login", {
    email: "legacy@example.com",
    password: PASSWORD,
    turnstile_token: "captcha-token",
  }), env);
  assert.equal(login.status, 403);
  assert.equal((await login.json()).error.code, "email_verification_required");
  assert.equal(emails.length, 1);

  const token = emails[0].html.match(/verify-email\?token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token);
  const verification = await worker.fetch(request("/api/auth/email/verify", { token }), env);
  assert.equal(verification.status, 200, JSON.stringify(await verification.clone().json()));
  assert.ok(sqlite.prepare("SELECT email_verified_at FROM users WHERE id = 'user-legacy'").get().email_verified_at);

  const signedIn = await worker.fetch(request("/api/auth/email/login", {
    email: "legacy@example.com",
    password: PASSWORD,
    turnstile_token: "captcha-token-2",
  }), env);
  assert.equal(signedIn.status, 200, JSON.stringify(await signedIn.clone().json()));
});
