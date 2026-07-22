import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { createTestRepository } from "./d1-helper.js";

const ORIGIN = "https://telegram-checkin-admin.pages.dev";
const PASSWORD = "correct horse battery staple";
const WRONG_PASSWORD = "incorrect horse battery staple";

function request(path, body, { ip = "203.0.113.10" } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      "user-agent": "Email Auth Hardening Test",
    },
    body: JSON.stringify(body),
  });
}

function verificationToken(email) {
  const match = String(email?.html || "").match(/verify-email\?token=([A-Za-z0-9_-]{32,128})/);
  assert.ok(match, "expected verification link");
  return match[1];
}

function harness() {
  const { db, repository } = createTestRepository();
  const emails = [];
  const fetch = async (url, init = {}) => {
    if (String(url) === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      const responseToken = String(new URLSearchParams(init.body).get("response") || "");
      return Response.json({
        success: true,
        hostname: "telegram-checkin-admin.pages.dev",
        action: responseToken.startsWith("register-") ? "email_register" : "email_login",
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
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    TURNSTILE_SITE_KEY: "turnstile-site-key",
    RESEND_API_KEY: "resend-key",
    AUTH_EMAIL_FROM: "Telegram Check-in <auth@example.com>",
    PASSWORD_PEPPER: "test-only-password-pepper",
    PASSWORD_HASH_ITERATIONS: "100000",
  };
  return { worker, env, emails };
}

async function registerAndVerify(context, email = "protected@example.com") {
  const registration = await context.worker.fetch(request("/api/auth/email/register", {
    email,
    display_name: "Protected User",
    password: PASSWORD,
    turnstile_token: "register-first",
  }), context.env);
  assert.equal(registration.status, 202, JSON.stringify(await registration.clone().json()));
  const token = verificationToken(context.emails.at(-1));
  const verification = await context.worker.fetch(request("/api/auth/email/verify", { token }), context.env);
  assert.equal(verification.status, 200, JSON.stringify(await verification.clone().json()));
  return await registration.json();
}

test("secure registration returns the same response for a new address and an existing account", async () => {
  const context = harness();
  const firstPayload = await registerAndVerify(context);
  const emailCount = context.emails.length;

  const repeated = await context.worker.fetch(request("/api/auth/email/register", {
    email: "protected@example.com",
    display_name: "Different Name",
    password: "another strong password value",
    turnstile_token: "register-repeat",
  }, { ip: "203.0.113.11" }), context.env);
  assert.equal(repeated.status, 202, JSON.stringify(await repeated.clone().json()));
  assert.deepEqual(await repeated.json(), firstPayload);
  assert.equal(context.emails.length, emailCount);
});

test("invalid logins are limited globally per email across changing IP addresses", async () => {
  const context = harness();
  await registerAndVerify(context);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await context.worker.fetch(request("/api/auth/email/login", {
      email: "protected@example.com",
      password: WRONG_PASSWORD,
      turnstile_token: `login-failed-${attempt}`,
    }, { ip: `198.51.100.${attempt + 1}` }), context.env);
    assert.equal(response.status, 401, `attempt ${attempt + 1}`);
  }

  const blocked = await context.worker.fetch(request("/api/auth/email/login", {
    email: "protected@example.com",
    password: WRONG_PASSWORD,
    turnstile_token: "login-failed-blocked",
  }, { ip: "198.51.100.99" }), context.env);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "rate_limited");

  const legitimate = await context.worker.fetch(request("/api/auth/email/login", {
    email: "protected@example.com",
    password: PASSWORD,
    turnstile_token: "login-legitimate",
  }, { ip: "192.0.2.20" }), context.env);
  assert.equal(legitimate.status, 200, JSON.stringify(await legitimate.clone().json()));
});
