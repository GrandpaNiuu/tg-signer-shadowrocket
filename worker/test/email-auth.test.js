import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { createTestRepository } from "./d1-helper.js";

const ORIGIN = "https://telegram-checkin-admin.pages.dev";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "new correct horse battery staple";

function request(path, { method = "GET", body, cookie } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "cf-connecting-ip": "203.0.113.10",
      "user-agent": "Email Auth Test Browser",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function tokenFromEmail(email, route) {
  const match = String(email?.html || "").match(new RegExp(`${route}\\?token=([A-Za-z0-9_-]{32,})`));
  assert.ok(match, `expected ${route} token in email`);
  return match[1];
}

function harness() {
  const { sqlite, db, repository } = createTestRepository();
  const emails = [];
  const turnstile = [];
  let current = new Date("2026-07-18T00:00:00.000Z");
  const fetch = async (url, init = {}) => {
    if (String(url) === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      const form = new URLSearchParams(init.body);
      turnstile.push(Object.fromEntries(form));
      return Response.json({ success: form.get("response") !== "invalid-captcha" });
    }
    if (String(url) === "https://api.resend.com/emails") {
      emails.push(JSON.parse(init.body));
      return Response.json({ id: `email-${emails.length}` });
    }
    return new Response(null, { status: 404 });
  };
  const worker = createWorker({
    fetch,
    repositoryFactory: () => repository,
    now: () => current,
  });
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
  return {
    sqlite,
    worker,
    env,
    emails,
    turnstile,
    setNow(value) { current = new Date(value); },
  };
}

async function registerAndVerify(context) {
  const registration = await context.worker.fetch(request("/api/auth/email/register", {
    method: "POST",
    body: {
      email: "User@Example.com",
      display_name: "Email User",
      password: PASSWORD,
      turnstile_token: "register-captcha",
    },
  }), context.env);
  assert.equal(registration.status, 202, JSON.stringify(await registration.clone().json()));
  assert.deepEqual((await registration.json()).data, { status: "verification_required" });
  assert.equal(context.emails.length, 1);
  const token = tokenFromEmail(context.emails[0], "verify-email");
  const verification = await context.worker.fetch(request("/api/auth/email/verify", {
    method: "POST",
    body: { token },
  }), context.env);
  assert.equal(verification.status, 200, JSON.stringify(await verification.clone().json()));
  return token;
}

async function login(context, password = PASSWORD, captcha = "login-captcha") {
  return context.worker.fetch(request("/api/auth/email/login", {
    method: "POST",
    body: {
      email: "user@example.com",
      password,
      turnstile_token: captcha,
    },
  }), context.env);
}

test("email registration requires verification before password login and never stores plaintext", async () => {
  const context = harness();
  const registration = await context.worker.fetch(request("/api/auth/email/register", {
    method: "POST",
    body: {
      email: "User@Example.com",
      display_name: "Email User",
      password: PASSWORD,
      turnstile_token: "register-captcha",
    },
  }), context.env);
  assert.equal(registration.status, 202, JSON.stringify(await registration.clone().json()));
  assert.equal(JSON.stringify(await registration.json()).includes(PASSWORD), false);

  const user = context.sqlite.prepare(`SELECT id, role, status, email, email_normalized,
    password_algorithm, password_hash, password_salt, password_iterations
    FROM users WHERE email_normalized = 'user@example.com'`).get();
  assert.equal(user.role, "user");
  assert.equal(user.status, "pending");
  assert.equal(user.email, "User@Example.com");
  assert.equal(user.password_algorithm, "PBKDF2-HMAC-SHA256");
  assert.equal(user.password_iterations, 100000);
  assert.notEqual(user.password_hash, PASSWORD);
  assert.ok(user.password_salt);
  assert.equal(JSON.stringify(user).includes(PASSWORD), false);

  const beforeVerification = await login(context);
  assert.equal(beforeVerification.status, 403);
  assert.equal((await beforeVerification.json()).error.code, "email_verification_required");

  const token = tokenFromEmail(context.emails[0], "verify-email");
  const verify = await context.worker.fetch(request("/api/auth/email/verify", {
    method: "POST",
    body: { token },
  }), context.env);
  assert.equal(verify.status, 200);
  assert.equal(context.sqlite.prepare("SELECT status FROM users WHERE id = ?").get(user.id).status, "active");

  const successful = await login(context);
  assert.equal(successful.status, 200, JSON.stringify(await successful.clone().json()));
  const cookies = successful.headers.getSetCookie?.() || [successful.headers.get("set-cookie")];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("tg_session="))?.split(";", 1)[0];
  assert.ok(sessionCookie);
  const identity = await context.worker.fetch(request("/api/auth/me", { cookie: sessionCookie }), context.env)
    .then((response) => response.json());
  assert.equal(identity.data.provider, "email");
  assert.equal(identity.data.email, "User@Example.com");
  assert.equal(identity.data.role, "user");

  const wrong = await login(context, "wrong password that is long enough");
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, "invalid_credentials");
});

test("password reset is one-time and revokes every previous session", async () => {
  const context = harness();
  await registerAndVerify(context);
  const signedIn = await login(context);
  const sessionCookie = (signedIn.headers.getSetCookie?.() || [signedIn.headers.get("set-cookie")])
    .find((cookie) => cookie.startsWith("tg_session="))?.split(";", 1)[0];
  assert.ok(sessionCookie);

  const forgot = await context.worker.fetch(request("/api/auth/email/forgot-password", {
    method: "POST",
    body: { email: "user@example.com", turnstile_token: "forgot-captcha" },
  }), context.env);
  assert.equal(forgot.status, 202);
  assert.deepEqual((await forgot.json()).data, { status: "accepted" });
  const resetToken = tokenFromEmail(context.emails.at(-1), "reset-password");

  const reset = await context.worker.fetch(request("/api/auth/email/reset-password", {
    method: "POST",
    body: {
      token: resetToken,
      password: NEW_PASSWORD,
      turnstile_token: "reset-captcha",
    },
  }), context.env);
  assert.equal(reset.status, 200, JSON.stringify(await reset.clone().json()));

  const replay = await context.worker.fetch(request("/api/auth/email/reset-password", {
    method: "POST",
    body: { token: resetToken, password: PASSWORD, turnstile_token: "replay-captcha" },
  }), context.env);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error.code, "invalid_or_expired_token");

  const oldSession = await context.worker.fetch(request("/api/auth/me", { cookie: sessionCookie }), context.env)
    .then((response) => response.json());
  assert.equal(oldSession.data.authenticated, false);
  assert.equal((await login(context, PASSWORD)).status, 401);
  assert.equal((await login(context, NEW_PASSWORD)).status, 200);
});

test("Turnstile and mail configuration fail closed without exposing account existence", async () => {
  const context = harness();
  const captchaFailure = await context.worker.fetch(request("/api/auth/email/register", {
    method: "POST",
    body: {
      email: "user@example.com",
      display_name: "User",
      password: PASSWORD,
      turnstile_token: "invalid-captcha",
    },
  }), context.env);
  assert.equal(captchaFailure.status, 400);
  assert.equal((await captchaFailure.json()).error.code, "turnstile_failed");

  delete context.env.RESEND_API_KEY;
  const mailMissing = await context.worker.fetch(request("/api/auth/email/register", {
    method: "POST",
    body: {
      email: "user@example.com",
      display_name: "User",
      password: PASSWORD,
      turnstile_token: "valid-captcha",
    },
  }), context.env);
  assert.equal(mailMissing.status, 503);
  assert.equal((await mailMissing.json()).error.code, "secure_registration_not_configured");

  const forgotUnknown = await context.worker.fetch(request("/api/auth/email/forgot-password", {
    method: "POST",
    body: { email: "missing@example.com", turnstile_token: "forgot-captcha" },
  }), { ...context.env, RESEND_API_KEY: "resend-key" });
  assert.equal(forgotUnknown.status, 202);
  assert.deepEqual((await forgotUnknown.json()).data, { status: "accepted" });
});

test("authenticated users can inspect and revoke only their own login sessions", async () => {
  const context = harness();
  await registerAndVerify(context);
  const first = await login(context, PASSWORD, "first-session-captcha");
  const second = await login(context, PASSWORD, "second-session-captcha");
  const cookie = (response) => (response.headers.getSetCookie?.() || [response.headers.get("set-cookie")])
    .find((item) => item.startsWith("tg_session="))?.split(";", 1)[0];
  const firstCookie = cookie(first);
  const secondCookie = cookie(second);

  const sessionsResponse = await context.worker.fetch(request("/api/auth/sessions", { cookie: secondCookie }), context.env);
  assert.equal(sessionsResponse.status, 200);
  const sessions = (await sessionsResponse.json()).data;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((session) => session.current).length, 1);
  assert.equal(JSON.stringify(sessions).includes("token_hash"), false);
  const firstSession = sessions.find((session) => !session.current);

  const revoke = await context.worker.fetch(request(`/api/auth/sessions/${firstSession.id}`, {
    method: "DELETE",
    cookie: secondCookie,
  }), context.env);
  assert.equal(revoke.status, 204);
  const revokedIdentity = await context.worker.fetch(request("/api/auth/me", { cookie: firstCookie }), context.env)
    .then((response) => response.json());
  assert.equal(revokedIdentity.data.authenticated, false);
  const currentIdentity = await context.worker.fetch(request("/api/auth/me", { cookie: secondCookie }), context.env)
    .then((response) => response.json());
  assert.equal(currentIdentity.data.authenticated, true);
});

test("public auth configuration exposes provider availability but never secrets", async () => {
  const context = harness();
  const response = await context.worker.fetch(request("/api/auth/config"), context.env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.data, {
    github_enabled: true,
    email_enabled: true,
    registration_enabled: true,
    email_verification_required: true,
    password_reset_enabled: true,
    turnstile_site_key: "turnstile-site-key",
  });
  const serialized = JSON.stringify(payload);
  for (const secret of ["turnstile-secret", "resend-key", "test-only-password-pepper", "client-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("local password mode enables immediate public registration without mail delivery", async () => {
  const context = harness();
  context.env.PUBLIC_PASSWORD_AUTH_MODE = "local";
  delete context.env.TURNSTILE_SECRET_KEY;
  delete context.env.TURNSTILE_SITE_KEY;
  delete context.env.RESEND_API_KEY;
  delete context.env.AUTH_EMAIL_FROM;

  const configResponse = await context.worker.fetch(request("/api/auth/config"), context.env);
  assert.equal(configResponse.status, 200);
  assert.deepEqual((await configResponse.json()).data, {
    github_enabled: true,
    email_enabled: true,
    registration_enabled: true,
    email_verification_required: false,
    password_reset_enabled: false,
    turnstile_site_key: null,
  });

  const registration = await context.worker.fetch(request("/api/auth/email/register", {
    method: "POST",
    body: {
      email: "Public@Example.com",
      display_name: "Public User",
      password: PASSWORD,
      turnstile_token: "",
    },
  }), context.env);
  assert.equal(registration.status, 201, JSON.stringify(await registration.clone().json()));
  assert.equal(context.emails.length, 0);
  assert.equal(context.turnstile.length, 0);

  const user = context.sqlite.prepare(`SELECT status, email_verified_at, password_hash
    FROM users WHERE email_normalized = 'public@example.com'`).get();
  assert.equal(user.status, "active");
  assert.equal(user.email_verified_at, null);
  assert.notEqual(user.password_hash, PASSWORD);

  const sessionCookie = (registration.headers.getSetCookie?.() || [registration.headers.get("set-cookie")])
    .find((cookie) => cookie.startsWith("tg_session="))?.split(";", 1)[0];
  assert.ok(sessionCookie);
  const identity = await context.worker.fetch(request("/api/auth/me", { cookie: sessionCookie }), context.env)
    .then((response) => response.json());
  assert.equal(identity.data.authenticated, true);
  assert.equal(identity.data.email, "Public@Example.com");

  const signedIn = await context.worker.fetch(request("/api/auth/email/login", {
    method: "POST",
    body: { email: "public@example.com", password: PASSWORD, turnstile_token: "" },
  }), context.env);
  assert.equal(signedIn.status, 200, JSON.stringify(await signedIn.clone().json()));
});
