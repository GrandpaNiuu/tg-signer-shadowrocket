import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError } from "../src/api.js";

test("unwraps data and sends same-origin mutation headers", async () => {
  let captured;
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ data: { id: "task-1" } }), { status: 202, headers: { "content-type": "application/json" } });
  }});
  const result = await client.createTask({ name: "签到" });
  assert.deepEqual(result, { id: "task-1" });
  assert.equal(captured.url, "/api/v1/tasks");
  assert.equal(captured.options.credentials, "same-origin");
  assert.equal(captured.options.headers["x-requested-with"], "tg-checkin-admin");
});

test("encodes filters and never puts values in an error message", async () => {
  let requestedUrl;
  const secret = "secret-session-value";
  const client = new ApiClient({ fetchImpl: async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "输入无效" } }), { status: 400 });
  }});
  await assert.rejects(client.taskRuns({ status: "failed", task_id: "a/b" }), (error) => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(requestedUrl, "/api/v1/task-runs?status=failed&task_id=a%2Fb");
});

test("uses the settings values envelope", async () => {
  let body;
  const client = new ApiClient({ fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: body }), { status: 200 });
  }});
  await client.updateSettings({ scheduler_mode: "d1" });
  assert.deepEqual(body, { values: { scheduler_mode: "d1" } });
});

test("sends account secret clears as explicit null PATCH values", async () => {
  let captured;
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    captured = { url, method: options.method, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: { id: "account-1" } }), { status: 200 });
  }});
  await client.updateAccount("account/1", {
    name: "主账号",
    enabled: true,
    session: null,
    proxy: null,
  });
  assert.deepEqual(captured, {
    url: "/api/v1/accounts/account%2F1",
    method: "PATCH",
    body: { name: "主账号", enabled: true, session: null, proxy: null },
  });
});

test("starts Session validation and verification-code resend with opaque ids", async () => {
  const requests = [];
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: { id: "flow-1", status: "starting" } }), { status: 202 });
  }});

  await client.validateAccount("account/1");
  await client.resendLoginCode("flow/1");
  assert.deepEqual(requests, [
    { url: "/api/v1/accounts/account%2F1/validate", method: "POST", body: {} },
    { url: "/api/v1/login-flows/flow%2F1/resend", method: "POST", body: {} },
  ]);
});

test("starts a privacy-safe bulk account validation request", async () => {
  const captured = [];
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    const call = { url, method: options.method, body: JSON.parse(options.body) };
    captured.push(call);
    if (call.body.cursor === 0) {
      return Response.json({ data: {
        requested: 2,
        started: 1,
        flows: [{ id: "flow-1" }],
        failures: [{ account_id: "account-2", code: "validation_dispatch_failed" }],
        next_cursor: 20,
      } }, { status: 202 });
    }
    return Response.json({ data: {
      requested: 1,
      started: 1,
      flows: [{ id: "flow-3" }],
      failures: [],
      next_cursor: null,
    } }, { status: 202 });
  }});

  const result = await client.validateAllAccounts();
  assert.deepEqual(captured, [
    { url: "/api/v1/accounts/validate-all", method: "POST", body: { cursor: 0 } },
    { url: "/api/v1/accounts/validate-all", method: "POST", body: { cursor: 20 } },
  ]);
  assert.deepEqual(result, {
    requested: 3,
    started: 2,
    flows: [{ id: "flow-1" }, { id: "flow-3" }],
    failures: [{ account_id: "account-2", code: "validation_dispatch_failed" }],
  });
});

test("uses a dedicated endpoint for notification secret replacement and clearing", async () => {
  let captured;
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    captured = { url, method: options.method, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: {
      notification_bot_token_configured: true,
      notification_chat_id_configured: false,
    } }), { status: 200 });
  }});
  const result = await client.updateNotificationSettings({ bot_token: "replacement", chat_id: null });
  assert.deepEqual(captured, {
    url: "/api/v1/settings/notifications",
    method: "PATCH",
    body: { bot_token: "replacement", chat_id: null },
  });
  assert.equal(result.notification_bot_token_configured, true);
  assert.equal(result.notification_chat_id_configured, false);
});

test("uses a dedicated endpoint for global Telegram application credentials", async () => {
  let captured;
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    captured = { url, method: options.method, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: { telegram_application_configured: true } }), { status: 200 });
  }});
  const credentials = { api_id: "123456", api_hash: "0123456789abcdef0123456789abcdef" };
  const result = await client.updateTelegramApplicationSettings(credentials);
  assert.deepEqual(captured, {
    url: "/api/v1/settings/telegram",
    method: "PATCH",
    body: credentials,
  });
  assert.equal(result.telegram_application_configured, true);
});

test("loads every cursor page for accounts, tasks, and runs", async () => {
  const requested = [];
  const client = new ApiClient({ fetchImpl: async (url) => {
    requested.push(url);
    const secondPage = url.includes("cursor=next-1");
    return new Response(JSON.stringify({
      data: [{ id: secondPage ? "row-2" : "row-1" }],
      pagination: { next_cursor: secondPage ? null : "next-1" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }});

  assert.deepEqual(await client.accounts(), [{ id: "row-1" }, { id: "row-2" }]);
  assert.deepEqual(requested, ["/api/v1/accounts", "/api/v1/accounts?cursor=next-1"]);
});

test("identity and logout use the same-origin GitHub auth endpoints", async () => {
  const requests = [];
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, credentials: options.credentials, requestedWith: options.headers["x-requested-with"] });
    return Response.json({ data: url.endsWith("/me")
      ? { authenticated: true, provider: "github", login: "GrandpaNiuu" }
      : null });
  }});

  assert.equal((await client.identity()).login, "GrandpaNiuu");
  await client.logout();
  assert.deepEqual(requests, [
    { url: "/api/auth/me", method: "GET", credentials: "same-origin", requestedWith: "tg-checkin-admin" },
    { url: "/api/auth/logout", method: "POST", credentials: "same-origin", requestedWith: "tg-checkin-admin" },
  ]);
});

test("calls receiver-sensitive browser fetch implementations with the global receiver", async () => {
  let receiver;
  function receiverSensitiveFetch() {
    receiver = this;
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(Response.json({ data: { authenticated: false, provider: "github" } }));
  }

  const client = new ApiClient({ fetchImpl: receiverSensitiveFetch });
  assert.deepEqual(await client.identity(), { authenticated: false, provider: "github" });
  assert.equal(receiver, globalThis);
});

test("email registration, login, reset, and session management use dedicated auth endpoints", async () => {
  const requests = [];
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    return url === "/api/auth/sessions/session%2F1"
      ? new Response(null, { status: 204 })
      : Response.json({ data: url === "/api/auth/config" ? { email_enabled: true } : { status: "ok" } });
  }});

  await client.authConfig();
  await client.registerEmail({ email: "user@example.com", password: "long-password", display_name: "User", turnstile_token: "captcha" });
  await client.verifyEmail("verify-token");
  await client.loginEmail({ email: "user@example.com", password: "long-password", turnstile_token: "captcha" });
  await client.forgotPassword({ email: "user@example.com", turnstile_token: "captcha" });
  await client.resetPassword({ token: "reset-token", password: "new-long-password", turnstile_token: "captcha" });
  await client.sessions();
  await client.revokeSession("session/1");

  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: "/api/auth/config", method: "GET" },
    { url: "/api/auth/email/register", method: "POST" },
    { url: "/api/auth/email/verify", method: "POST" },
    { url: "/api/auth/email/login", method: "POST" },
    { url: "/api/auth/email/forgot-password", method: "POST" },
    { url: "/api/auth/email/reset-password", method: "POST" },
    { url: "/api/auth/sessions", method: "GET" },
    { url: "/api/auth/sessions/session%2F1", method: "DELETE" },
  ]);
});

test("platform user management uses administrator-only endpoints", async () => {
  const requests = [];
  const client = new ApiClient({ fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    return Response.json({
      data: url.endsWith("/users") ? [{ id: "user-1" }] : { id: "user-1", status: "disabled" },
      pagination: { next_cursor: null },
    });
  }});

  assert.deepEqual(await client.platformUsers(), [{ id: "user-1" }]);
  assert.equal((await client.updatePlatformUser("user/1", { status: "disabled" })).status, "disabled");
  assert.deepEqual(requests, [
    { url: "/api/v1/admin/users", method: "GET", body: undefined },
    { url: "/api/v1/admin/users/user%2F1", method: "PATCH", body: { status: "disabled" } },
  ]);
});
