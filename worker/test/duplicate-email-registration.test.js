import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { createTestRepository } from "./d1-helper.js";

const ORIGIN = "https://telegram-checkin-admin.pages.dev";
const FIRST_PASSWORD = "correct horse battery staple";
const SECOND_PASSWORD = "different horse battery staple";

function registrationRequest(password, token) {
  return new Request(`${ORIGIN}/api/auth/email/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.44",
      "user-agent": "Duplicate Registration Test",
    },
    body: JSON.stringify({
      email: "User@Example.com",
      display_name: "Email User",
      password,
      turnstile_token: token,
    }),
  });
}

function verificationRequest(token) {
  return new Request(`${ORIGIN}/api/auth/email/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

function verificationToken(email) {
  const match = String(email?.html || "").match(/verify-email\?token=([A-Za-z0-9_-]{32,})/);
  assert.ok(match);
  return match[1];
}

function harness() {
  const { db, repository, sqlite } = createTestRepository();
  const emails = [];
  const fetch = async (url, init = {}) => {
    if (String(url).includes("turnstile/v0/siteverify")) {
      return Response.json({
        success: true,
        hostname: "telegram-checkin-admin.pages.dev",
        action: "email_register",
      });
    }
    if (String(url) === "https://api.resend.com/emails") {
      emails.push(JSON.parse(init.body));
      return Response.json({ id: `email-${emails.length}` });
    }
    return new Response(null, { status: 404 });
  };
  const worker = createWorker({ fetch, repositoryFactory: () => repository });
  const env = {
    DB: db,
    ADMIN_ORIGIN: ORIGIN,
    ADMIN_GITHUB_LOGIN: "GrandpaNiuu",
    ADMIN_GITHUB_USER_ID: "123456",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    TURNSTILE_SITE_KEY: "turnstile-site-key",
    RESEND_API_KEY: "resend-key",
    AUTH_EMAIL_FROM: "Telegram Check-in <auth@example.com>",
    PASSWORD_PEPPER: "test-only-password-pepper",
    PASSWORD_HASH_ITERATIONS: "100000",
  };
  return { worker, env, emails, sqlite };
}

test("re-registering a pending email is rejected without changing its password or sending another mail", async () => {
  const context = harness();
  const first = await context.worker.fetch(registrationRequest(FIRST_PASSWORD, "register-first"), context.env);
  assert.equal(first.status, 202, JSON.stringify(await first.clone().json()));
  assert.equal(context.emails.length, 1);

  const before = context.sqlite.prepare(`SELECT id, password_hash, password_salt, updated_at
    FROM users WHERE email_normalized = 'user@example.com'`).get();
  assert.ok(before);

  const duplicate = await context.worker.fetch(registrationRequest(SECOND_PASSWORD, "register-second"), context.env);
  assert.equal(duplicate.status, 409, JSON.stringify(await duplicate.clone().json()));
  const payload = await duplicate.json();
  assert.equal(payload.error.code, "account_pending_verification");
  assert.match(payload.error.message, /不能重复注册/);
  assert.equal(context.emails.length, 1);

  const after = context.sqlite.prepare(`SELECT id, password_hash, password_salt, updated_at
    FROM users WHERE email_normalized = 'user@example.com'`).get();
  assert.deepEqual(after, before);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE email_normalized = 'user@example.com'").get().count, 1);
});

test("re-registering an activated email returns account_exists", async () => {
  const context = harness();
  const first = await context.worker.fetch(registrationRequest(FIRST_PASSWORD, "register-first"), context.env);
  assert.equal(first.status, 202);
  const verified = await context.worker.fetch(verificationRequest(verificationToken(context.emails[0])), context.env);
  assert.equal(verified.status, 200);

  const duplicate = await context.worker.fetch(registrationRequest(SECOND_PASSWORD, "register-after-verify"), context.env);
  assert.equal(duplicate.status, 409, JSON.stringify(await duplicate.clone().json()));
  assert.equal((await duplicate.json()).error.code, "account_exists");
  assert.equal(context.emails.length, 1);
});
