import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { hashPassword } from "../src/password.js";
import { createTestRepository } from "./d1-helper.js";

const ORIGIN = "https://telegram-checkin-admin.pages.dev";
const PASSWORD = "correct horse battery staple";

function request(email) {
  return new Request(`${ORIGIN}/api/auth/email/forgot-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.88",
      "user-agent": "Password Recovery Enumeration Test",
    },
    body: JSON.stringify({ email, turnstile_token: `forgot-${email}` }),
  });
}

test("password recovery returns the same accepted response when email delivery fails", async () => {
  const { db, repository, sqlite } = createTestRepository();
  const env = {
    DB: db,
    ADMIN_ORIGIN: ORIGIN,
    ADMIN_GITHUB_LOGIN: "GrandpaNiuu",
    ADMIN_GITHUB_USER_ID: "123456",
    PASSWORD_PEPPER: "test-only-password-pepper",
    PASSWORD_HASH_ITERATIONS: "100000",
    PUBLIC_PASSWORD_AUTH_MODE: "secure",
    TURNSTILE_SITE_KEY: "turnstile-site",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    RESEND_API_KEY: "resend-key",
    AUTH_EMAIL_FROM: "Auth <auth@example.com>",
  };
  const password = await hashPassword(PASSWORD, env);
  await repository.createOrActivateLocalEmailUser({
    id: "user-existing",
    display_name: "Existing User",
    email: "existing@example.com",
    email_normalized: "existing@example.com",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  }, password);
  sqlite.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
    .run("2026-07-20T00:00:00.000Z", "user-existing");

  let emailCalls = 0;
  const fetch = async (url) => {
    if (String(url).includes("turnstile/v0/siteverify")) {
      return Response.json({
        success: true,
        hostname: "telegram-checkin-admin.pages.dev",
        action: "forgot_password",
      });
    }
    if (String(url) === "https://api.resend.com/emails") {
      emailCalls += 1;
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 404 });
  };
  const worker = createWorker({ fetch, repositoryFactory: () => repository });

  const existing = await worker.fetch(request("existing@example.com"), env);
  const missing = await worker.fetch(request("missing@example.com"), env);
  assert.equal(existing.status, 202);
  assert.equal(missing.status, 202);
  assert.deepEqual(await existing.json(), await missing.json());
  assert.equal(emailCalls, 1);
});
