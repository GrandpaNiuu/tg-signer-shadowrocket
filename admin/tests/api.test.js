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
