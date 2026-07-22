import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { createTestRepository } from "./d1-helper.js";

const ORIGIN = "https://telegram-checkin-admin.pages.dev";
const PASSWORD = "correct horse battery staple";

function request(path, { body, ip = "203.0.113.55" } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      "user-agent": "Verification Code Test",
    },
    body: JSON.stringify(body || {}),
  });
}

function codeFromEmail(email) {
  const match = String(email?.html || "").match(/>(\d{6})<\/p>/);
  assert.ok(match, "expected a six digit verification code in the email");
  return match[1];
}

function tokenFromEmail(email) {
  const match = String(email?.html || "").match(/verify-email\?token=([A-Za-z0-9_-]{32,128})/);
  assert.ok(match, "expected a backward-compatible verification link");
  return match[1];
}

function harness() {
  const { sqlite, db, repository } = createTestRepository();
  const emails = [];
  let current = new Date("2026-07-22T00:00:00.000Z");
  const fetch = async (url, init = {}) => {
    if (String(url) === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      const form = new URLSearchParams(init.body);
      const token = String(form.get("response") || "");
      return Response.json({
        success: token !== "invalid-captcha",
        hostname: "telegram-checkin-admin.pages.dev",
        action: token.includes("resend") ? "resend_verification" : "email_register",
      });
    }
    if (String(url) === "https://api.resend.com/emails") {
      emails.push(JSON.parse(init.body));
      return Response.json({ id: `email-${emails.length}` });
    }
    return new Response(null, { status: 404 });
  };
  const worker = createWorker({ fetch, repositoryFactory: () => repository, now: () => current });
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
  return { sqlite, worker, env, emails, advance(milliseconds) { current = new Date(current.getTime() + milliseconds); } };
}

async function register(context, email = "code-user@example.com") {
  const response = await context.worker.fetch(request("/api/auth/email/register", {
    body: {
      email,
      display_name: "Code User",
      password: PASSWORD,
      turnstile_token: "register-captcha",
    },
  }), context.env);
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  return codeFromEmail(context.emails.at(-1));
}

test("registration sends a six digit code, stores only a hash, and accepts the code", async () => {
  const context = harness();
  const code = await register(context);
  assert.match(code, /^\d{6}$/);
  assert.equal(context.emails[0].subject, "Telegram 自动消息邮箱验证码");
  assert.equal(tokenFromEmail(context.emails[0]).length >= 32, true);

  const tokenRow = context.sqlite.prepare(`SELECT token_hash, expires_at, attempt_count
    FROM auth_tokens WHERE token_type = 'verify_email'`).get();
  assert.ok(tokenRow.token_hash);
  assert.equal(tokenRow.token_hash.includes(code), false);
  assert.equal(tokenRow.attempt_count, 0);
  assert.equal(Date.parse(tokenRow.expires_at) - Date.parse("2026-07-22T00:00:00.000Z"), 10 * 60 * 1000);

  const wrongCode = code === "000000" ? "000001" : "000000";
  const wrong = await context.worker.fetch(request("/api/auth/email/verify-code", {
    body: { email: "code-user@example.com", code: wrongCode },
  }), context.env);
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error.code, "invalid_or_expired_code");
  assert.equal(context.sqlite.prepare("SELECT attempt_count FROM auth_tokens WHERE token_type = 'verify_email'").get().attempt_count, 1);

  const verified = await context.worker.fetch(request("/api/auth/email/verify-code", {
    body: { email: "code-user@example.com", code },
  }), context.env);
  assert.equal(verified.status, 200, JSON.stringify(await verified.clone().json()));
  const user = context.sqlite.prepare("SELECT status, email_verified_at FROM users WHERE email_normalized = ?")
    .get("code-user@example.com");
  assert.equal(user.status, "active");
  assert.ok(user.email_verified_at);
});

test("resend requires Turnstile, is rate limited, and invalidates the previous verification code", async () => {
  const context = harness();
  const firstCode = await register(context, "resend@example.com");

  const missingChallenge = await context.worker.fetch(request("/api/auth/email/resend-code", {
    body: { email: "resend@example.com", turnstile_token: "" },
  }), context.env);
  assert.equal(missingChallenge.status, 422);

  const tooSoon = await context.worker.fetch(request("/api/auth/email/resend-code", {
    body: { email: "resend@example.com", turnstile_token: "resend-captcha-too-soon" },
  }), context.env);
  assert.equal(tooSoon.status, 429);

  context.advance(61_000);
  const resent = await context.worker.fetch(request("/api/auth/email/resend-code", {
    body: { email: "resend@example.com", turnstile_token: "resend-captcha-valid" },
  }), context.env);
  assert.equal(resent.status, 202, JSON.stringify(await resent.clone().json()));
  assert.equal((await resent.json()).data.resend_after_seconds, 60);
  const secondCode = codeFromEmail(context.emails.at(-1));

  const oldCode = await context.worker.fetch(request("/api/auth/email/verify-code", {
    body: { email: "resend@example.com", code: firstCode },
  }), context.env);
  assert.equal(oldCode.status, 400);

  const newCode = await context.worker.fetch(request("/api/auth/email/verify-code", {
    body: { email: "resend@example.com", code: secondCode },
  }), context.env);
  assert.equal(newCode.status, 200);
});

test("five wrong verification codes invalidate the token even when every attempt uses a different IP", async () => {
  const context = harness();
  const realCode = await register(context, "attempts@example.com");
  const wrongCodes = ["000000", "000001", "000002", "000003", "000004", "000005"].filter((code) => code !== realCode);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await context.worker.fetch(request("/api/auth/email/verify-code", {
      ip: `203.0.113.${60 + attempt}`,
      body: { email: "attempts@example.com", code: wrongCodes[attempt] },
    }), context.env);
    assert.equal(response.status, 400);
  }

  const token = context.sqlite.prepare(`SELECT attempt_count, consumed_at FROM auth_tokens
    WHERE token_type = 'verify_email'`).get();
  assert.equal(token.attempt_count, 5);
  assert.ok(token.consumed_at);

  const correctAfterLock = await context.worker.fetch(request("/api/auth/email/verify-code", {
    ip: "203.0.113.99",
    body: { email: "attempts@example.com", code: realCode },
  }), context.env);
  assert.equal(correctAfterLock.status, 400);
  assert.equal((await correctAfterLock.json()).error.code, "invalid_or_expired_code");
});
