import test from "node:test";
import assert from "node:assert/strict";
import { __test, onRequest } from "../functions/api/[[path]].js";

test("rejects cross-origin writes", () => {
  const request = new Request("https://admin.example.com/api/v1/tasks", {
    method: "POST",
    headers: { origin: "https://evil.example", "x-requested-with": "tg-checkin-admin" },
  });
  assert.equal(__test.isSameOriginWrite(request), false);
});

test("accepts same-origin marked writes and safe reads", () => {
  const write = new Request("https://admin.example.com/api/v1/tasks", {
    method: "POST",
    headers: { origin: "https://admin.example.com", "x-requested-with": "tg-checkin-admin" },
  });
  assert.equal(__test.isSameOriginWrite(write), true);
  assert.equal(__test.isSameOriginWrite(new Request("https://admin.example.com/api/v1/tasks")), true);
});

test("identity response only exposes Access identity", async () => {
  const response = await onRequest({
    request: new Request("https://admin.example.com/api/identity", { headers: { "cf-access-authenticated-user-email": "owner@example.com" } }),
    env: {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { authenticated: true, email: "owner@example.com", provider: "cloudflare_access" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("proxy removes spoofed admin identity and forwards Access identity", async () => {
  let forwarded;
  const response = await onRequest({
    request: new Request("https://admin.example.com/api/v1/dashboard", {
      headers: { "x-admin-email": "attacker@example.com", "cf-access-authenticated-user-email": "owner@example.com" },
    }),
    env: { CONTROL_PLANE: { fetch: async (request) => {
      forwarded = request;
      return new Response(JSON.stringify({ data: {} }), { headers: { "content-type": "application/json" } });
    }}},
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("x-admin-email"), "owner@example.com");
});
