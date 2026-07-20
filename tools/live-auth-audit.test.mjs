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

const ADMIN_HTML = `<!doctype html>
<title>Telegram 自动消息</title>
<link rel="stylesheet" href="/assets/styles.css?v=1">
<script type="module" src="/src/app.js?v=1"></script>
<script type="module" src="/src/auth-security.js?v=1"></script>
<script type="module" src="/src/notification-guidance.js?v=1"></script>
<script type="module" src="/src/skill-guidance.js?v=2"></script>
<script type="module" src="/src/realtime-automation.js?v=20260721-2"></script>
<div id="auth-content"></div>`;

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

test("live audit verifies auth, guided sign-in, and realtime production assets", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith("/api/auth/config")) {
      return new Response(JSON.stringify(CLOSED), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.includes("/src/auth-security.js")) {
      return new Response("const applyScheduled = true; export default applyScheduled;", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/src/skill-guidance.js")) {
      return new Response('export const marker = "不用填写 JSON";', {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/src/realtime-automation.js")) {
      return new Response('export const marker = "自动识别机器人操作";', {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/src/")) {
      return new Response("export const loaded = true;", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/assets/styles.css")) {
      return new Response(".auth-gate { display: block; }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });
    }
    return new Response(ADMIN_HTML, {
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
    "https://grandpaniu.ccwu.cc/src/app.js?v=1",
    "https://grandpaniu.ccwu.cc/src/auth-security.js?v=1",
    "https://grandpaniu.ccwu.cc/src/notification-guidance.js?v=1",
    "https://grandpaniu.ccwu.cc/src/skill-guidance.js?v=2",
    "https://grandpaniu.ccwu.cc/src/realtime-automation.js?v=20260721-2",
    "https://grandpaniu.ccwu.cc/assets/styles.css?v=1",
    "https://grandpaniu.ccwu.cc/api/auth/config",
  ]);
  assert.equal(result.requested_origin, "https://grandpaniu.ccwu.cc");
  assert.equal(result.critical_assets_verified, true);
  assert.equal(result.asset_count, 6);
  assert.equal(result.registration_enabled, false);
  assert.equal(JSON.stringify(result).includes("site-key"), false);
});

test("live audit rejects stale guided sign-in and realtime scripts", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value === "https://grandpaniu.ccwu.cc/") {
      return new Response(ADMIN_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (value.includes("/src/auth-security.js")) {
      return new Response("const applyScheduled = true;", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/src/skill-guidance.js")) {
      return new Response('export const marker = "不用填写 JSON";', {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/src/realtime-automation.js")) {
      return new Response("export const oldRealtimeUi = true;", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/src/")) {
      return new Response("export const loaded = true;", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    if (value.includes("/assets/styles.css")) {
      return new Response(".auth-gate { display: block; }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });
    }
    return new Response(JSON.stringify(CLOSED), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await assert.rejects(
    () => runLiveAuthAudit({ adminUrl: "https://grandpaniu.ccwu.cc", fetchImpl }),
    /realtime_automation marker/,
  );
});
