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

test("proxy forwards the session cookie and removes spoofed identity headers", async () => {
  let forwarded;
  const response = await onRequest({
    request: new Request("https://admin.example.com/api/auth/session", {
      headers: {
        cookie: "tg_admin_session=session-token",
        "x-admin-email": "attacker@example.com",
        "cf-access-authenticated-user-email": "attacker@example.com",
        "cf-access-jwt-assertion": "attacker-token",
      },
    }),
    env: { CONTROL_PLANE: { fetch: async (request) => {
      forwarded = request;
      return Response.json({ data: { authenticated: true, provider: "github", login: "GrandpaNiuu" } });
    }}},
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("cookie"), "tg_admin_session=session-token");
  assert.equal(forwarded.headers.get("x-admin-email"), null);
  assert.equal(forwarded.headers.get("cf-access-authenticated-user-email"), null);
  assert.equal(forwarded.headers.get("cf-access-jwt-assertion"), null);
  assert.equal(forwarded.headers.get("x-forwarded-by"), "telegram-checkin-pages");
});

test("proxy preserves OAuth redirects and all Set-Cookie headers", async () => {
  const upstreamHeaders = new Headers({ location: "https://github.com/login/oauth/authorize?state=opaque" });
  upstreamHeaders.append("set-cookie", "tg_admin_session=session; Path=/; HttpOnly; Secure; SameSite=Lax");
  upstreamHeaders.append("set-cookie", "tg_oauth_state=; Max-Age=0; Path=/api/auth/github/callback; HttpOnly; Secure; SameSite=Lax");
  const response = await onRequest({
    request: new Request("https://admin.example.com/api/auth/github/callback?code=code&state=state"),
    env: { CONTROL_PLANE: { fetch: async () => new Response(null, { status: 302, headers: upstreamHeaders }) } },
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://github.com/login/oauth/authorize?state=opaque");
  const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")];
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((cookie) => cookie.startsWith("tg_admin_session=")));
  assert.ok(cookies.some((cookie) => cookie.startsWith("tg_oauth_state=")));
});
