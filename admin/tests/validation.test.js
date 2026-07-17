import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAccountPatch,
  nextCronOccurrences,
  validateAccount,
  validateAccountPatch,
  validateCron,
  validateSettings,
  validateTask,
} from "../src/validation.js";

test("validates Telegram login inputs without reflecting secrets", () => {
  const secret = "1234567890abcdef1234567890abcdef";
  const errors = validateAccount({ name: "", api_id: "bad", api_hash: secret.slice(0, 10), phone: "138" });
  assert.deepEqual(Object.keys(errors).sort(), ["api_hash", "api_id", "name", "phone"]);
  assert.equal(JSON.stringify(errors).includes(secret), false);

  assert.deepEqual(validateAccount({
    name: "主账号",
    api_id: "12345678",
    api_hash: secret,
    phone: "+8613812345678",
  }), {});
});

test("requires a session only in import mode", () => {
  const base = { name: "旧账号", api_id: "12345678", api_hash: "a".repeat(32), phone: "+8613812345678" };
  assert.equal(validateAccount(base, { requireSession: true }).session.length > 0, true);
  assert.deepEqual(validateAccount({ ...base, session: "valid-session-value-long-enough" }, { requireSession: true }), {});
});

test("account PATCH leaves blank credentials out and supports explicit secret clearing", () => {
  const blankPatch = buildAccountPatch({
    name: "主账号",
    enabled: true,
    phone: "",
    api_id: "",
    api_hash: "",
    session: "",
    proxy: { protocol: "socks5", host: "", port: "", username: "", password: "" },
  });
  assert.deepEqual(blankPatch, { name: "主账号", enabled: true });

  assert.deepEqual(buildAccountPatch({ name: "主账号", enabled: false }, {
    clearSession: true,
    clearProxy: true,
  }), {
    name: "主账号",
    enabled: false,
    session: null,
    proxy: null,
  });
});

test("account PATCH validates only supplied replacements without reflecting secrets", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const valid = {
    name: "备用账号",
    enabled: true,
    phone: "+8613812345678",
    api_id: "12345678",
    api_hash: secret,
    session: "session-value-long-enough",
    proxy: {
      protocol: "socks5h",
      host: "proxy.example.test",
      port: "1080",
      username: "proxy-user",
      password: "proxy-password",
    },
  };
  assert.deepEqual(validateAccountPatch(valid), {});
  assert.deepEqual(buildAccountPatch(valid), {
    name: "备用账号",
    enabled: true,
    phone: "+8613812345678",
    api_id: "12345678",
    api_hash: secret,
    session: "session-value-long-enough",
    proxy: {
      protocol: "socks5h",
      host: "proxy.example.test",
      port: 1080,
      username: "proxy-user",
      password: "proxy-password",
    },
  });

  const errors = validateAccountPatch({
    ...valid,
    phone: "138",
    api_id: "bad",
    api_hash: secret.slice(0, 10),
    session: "short",
    proxy: { ...valid.proxy, host: "bad host", port: "70000" },
  });
  assert.deepEqual(Object.keys(errors).sort(), ["api_hash", "api_id", "phone", "proxy_host", "proxy_port", "session"]);
  assert.equal(JSON.stringify(errors).includes(secret), false);
  assert.equal(JSON.stringify(errors).includes("proxy-password"), false);
});

test("account PATCH rejects replacing and clearing the same secret together", () => {
  const errors = validateAccountPatch({
    name: "主账号",
    enabled: true,
    session: "session-value-long-enough",
    proxy: { protocol: "http", host: "127.0.0.1", port: "8080" },
  }, { clearSession: true, clearProxy: true });
  assert.deepEqual(Object.keys(errors).sort(), ["proxy_host", "session"]);
});

test("validates all unified task policy fields", () => {
  const valid = {
    name: "每日签到",
    account_id: "account-1",
    skill_key: "send_text",
    bot: "@example_bot",
    command: "/checkin",
    cron: "0 0 * * *",
    timezone: "Asia/Shanghai",
    retry: 2,
    timeout_seconds: 120,
    thread_id: null,
    delete_after_seconds: 30,
  };
  assert.deepEqual(validateTask(valid), {});
  const errors = validateTask({ ...valid, retry: 6, timeout_seconds: 2, thread_id: -1, delete_after_seconds: 999999 });
  assert.deepEqual(Object.keys(errors).sort(), ["delete_after_seconds", "retry", "thread_id", "timeout_seconds"]);
  const unsafeDelete = validateTask({ ...valid, timeout_seconds: 120, delete_after_seconds: 115 });
  assert.match(unsafeDelete.delete_after_seconds, /超时/);
  assert.match(validateTask({ ...valid, retry: 5, timeout_seconds: 900 }).timeout_seconds, /900 秒/);
  assert.match(validateTask({ ...valid, skill_key: "tg_signer" }).tg_signer_import, /配置/);
  assert.deepEqual(validateTask({ ...valid, skill_key: "tg_signer", _has_tg_signer_import: true }), {});
});

test("checks five-part cron and previews a daily schedule", () => {
  assert.equal(validateCron("0 0 * * *"), true);
  assert.equal(validateCron("0 0 * *"), false);
  assert.equal(validateCron("hello 0 * * *"), false);
  const results = nextCronOccurrences("0 8 * * *", "Asia/Shanghai", 5, new Date("2026-07-18T00:01:00Z"));
  assert.equal(results.length, 5);
  assert.equal(results[0].toISOString(), "2026-07-19T00:00:00.000Z");
});

test("validates bounded settings", () => {
  assert.deepEqual(validateSettings({ default_timezone: "Asia/Shanghai", scheduler_mode: "legacy", notifications_enabled: true }), {});
  assert.deepEqual(Object.keys(validateSettings({ default_timezone: "", scheduler_mode: "both", notifications_enabled: false })).sort(), ["default_timezone", "scheduler_mode"]);
});
