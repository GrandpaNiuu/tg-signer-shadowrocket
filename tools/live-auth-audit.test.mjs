import assert from "node:assert/strict";
import test from "node:test";

import { runLiveAuthAudit, validateAuthSnapshot } from "./live-auth-audit.mjs";

const OPEN = {
  data: {
    github_enabled: true,
    email_enabled: true,
    registration_enabled: true,
    email_verification_required: true,
    password_reset_enabled: true,
    security_setup_required: false,
    turnstile_site_key: "site-key",
  },
};

const CLOSED = {
  data: {
    github_enabled: true,
    email_enabled: true,
    registration_enabled: false,
    email_verification_required: false,
    password_reset_enabled: false,
    security_setup_required: true,
    turnstile_site_key: null,
  },
};

test("verified email registration requires the complete security contract", () => {
  assert.deepEqual(validateAuthSnapshot(OPEN), {
    github_enabled: true,
    email_enabled: true,
    registration_enabled: true,
    email_verification_required: true,
    password_reset_enabled: true,
    security_setup_required: false,
    turnstile_configured: true,
  });
  assert.throws(() => validateAuthSnapshot({
    data: { ...OPEN.data, password_reset_enabled: false },
  }), /complete verified-registration contract/);
});

test("safely closed email registration remains a valid production state", () => {
  const snapshot = validateAuthSnapshot(CLOSED);
  assert.equal(snapshot.github_enabled, true);
  assert.equal(snapshot.registration_enabled, false);
  assert.equal(snapshot.security_setup_required, true);
  assert.throws(
    () => validateAuthSnapshot(CLOSED, { requireEmailRegistration: true }),
    /remains closed/,
  );
});

test("at least one public authentication provider is required", () => {
  assert.throws(() => validateAuthSnapshot({
    data: { ...CLOSED.data, github_enabled: false, email_enabled: false },
  }), /No public authentication provider/);
});

test("live audit follows the production page and reports only safe booleans", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/auth/config")) {
      return new Response(JSON.stringify(CLOSED), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("<!doctype html><title>Telegram</title>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  const result = await runLiveAuthAudit({
    adminUrl: "https://grandpaniu.ccwu.cc",
    fetchImpl,
  });
  assert.deepEqual(calls, [
    "https://grandpaniu.ccwu.cc/",
    "https://grandpaniu.ccwu.cc/api/auth/config",
  ]);
  assert.equal(result.requested_origin, "https://grandpaniu.ccwu.cc");
  assert.equal(result.registration_enabled, false);
  assert.equal(JSON.stringify(result).includes("site-key"), false);
});
