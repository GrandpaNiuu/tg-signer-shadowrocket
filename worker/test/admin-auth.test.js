import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { createTestRepository } from "./d1-helper.js";

const ADMIN_ORIGIN = "https://grandpaniu.ccwu.cc";

function request(path, options = {}) {
  return new Request(`${ADMIN_ORIGIN}${path}`, options);
}

function harness(fetchImpl = globalThis.fetch) {
  const { db, repository } = createTestRepository();
  let current = new Date("2026-07-18T00:00:00.000Z");
  const worker = createWorker({
    fetch: fetchImpl,
    repositoryFactory: () => repository,
    now: () => current,
  });
  const env = {
    DB: db,
    ADMIN_ORIGIN,
    ADMIN_GITHUB_LOGIN: "GrandpaNiuu",
    ADMIN_GITHUB_USER_ID: "123456",
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
  };
  return { worker, env, setNow: (value) => { current = new Date(value); } };
}

async function loginSession(worker, env) {
  const start = await worker.fetch(request("/api/auth/github/start"), env);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const callback = await worker.fetch(request(`/api/auth/github/callback?code=oauth-code&state=${state}`, {
    headers: { cookie: `tg_oauth_state=${state}` },
  }), env);
  const cookies = callback.headers.getSetCookie?.() || [callback.headers.get("set-cookie")];
  return cookies.find((cookie) => cookie.startsWith("tg_admin_session=")).split(";", 1)[0];
}

test("GitHub login start redirects with a one-time state cookie", async () => {
  const { worker, env } = harness();

  const response = await worker.fetch(request("/api/auth/github/start"), env);

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://github.com");
  assert.equal(location.pathname, "/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), "client-id");
  assert.equal(location.searchParams.get("redirect_uri"), `${ADMIN_ORIGIN}/api/auth/github/callback`);
  assert.match(location.searchParams.get("state"), /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.match(location.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);

  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`^tg_oauth_state=${location.searchParams.get("state")};`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test("GitHub login does not start when the OAuth secret is missing", async () => {
  const { worker, env } = harness();
  delete env.GITHUB_OAUTH_CLIENT_SECRET;

  const response = await worker.fetch(request("/api/auth/github/start"), env);

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "admin_auth_not_configured");
  assert.equal(response.headers.get("location"), null);
});

test("GitHub login requires a configured immutable numeric user id", async () => {
  const { worker, env } = harness();
  delete env.ADMIN_GITHUB_USER_ID;

  const missing = await worker.fetch(request("/api/auth/github/start"), env);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, "admin_auth_not_configured");

  env.ADMIN_GITHUB_USER_ID = "not-a-number";
  const invalid = await worker.fetch(request("/api/auth/github/start"), env);
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).error.code, "admin_auth_not_configured");
});

test("GitHub callback creates a session only for the configured administrator", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-access-token", token_type: "bearer" });
    }
    if (String(url) === "https://api.github.com/user") {
      return Response.json({ id: 123456, login: "GrandpaNiuu", name: "Grandpa Niu" });
    }
    return new Response(null, { status: 404 });
  };
  const { worker, env } = harness(fetch);
  const start = await worker.fetch(request("/api/auth/github/start"), env);
  const authorize = new URL(start.headers.get("location"));
  const state = authorize.searchParams.get("state");

  const response = await worker.fetch(request(`/api/auth/github/callback?code=oauth-code&state=${state}`, {
    headers: { cookie: `tg_oauth_state=${state}` },
  }), env);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${ADMIN_ORIGIN}/#/dashboard`);
  const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")];
  assert.ok(cookies.some((cookie) => /^tg_admin_session=[A-Za-z0-9_-]{32,};/.test(cookie)));
  assert.ok(cookies.some((cookie) => /tg_admin_session=.*HttpOnly.*Secure.*SameSite=Lax/i.test(cookie)));
  assert.ok(cookies.some((cookie) => /^tg_oauth_state=;/.test(cookie)));
  assert.equal(calls.length, 2);
  const tokenRequest = JSON.parse(calls[0].init.body);
  assert.equal(tokenRequest.client_secret, "client-secret");
  assert.match(tokenRequest.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    createHash("sha256").update(tokenRequest.code_verifier).digest("base64url"),
    authorize.searchParams.get("code_challenge"),
  );
  assert.equal(calls[1].init.headers.authorization, "Bearer github-access-token");
});

test("a valid GitHub session authenticates the identity and administrator interfaces", async () => {
  const fetch = async (url) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-access-token", token_type: "bearer" });
    }
    if (String(url) === "https://api.github.com/user") {
      return Response.json({ id: 123456, login: "GrandpaNiuu", name: "Grandpa Niu" });
    }
    return new Response(null, { status: 404 });
  };
  const { worker, env } = harness(fetch);
  const start = await worker.fetch(request("/api/auth/github/start"), env);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const callback = await worker.fetch(request(`/api/auth/github/callback?code=oauth-code&state=${state}`, {
    headers: { cookie: `tg_oauth_state=${state}` },
  }), env);
  const cookies = callback.headers.getSetCookie?.() || [callback.headers.get("set-cookie")];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("tg_admin_session=")).split(";", 1)[0];

  const identityResponse = await worker.fetch(request("/api/auth/session", {
    headers: { cookie: sessionCookie },
  }), env);
  assert.equal(identityResponse.status, 200);
  assert.deepEqual((await identityResponse.json()).data, {
    authenticated: true,
    provider: "github",
    login: "GrandpaNiuu",
    name: "Grandpa Niu",
  });

  const authorized = await worker.fetch(request("/api/v1/skills", {
    headers: { cookie: sessionCookie },
  }), env);
  assert.equal(authorized.status, 200);

  const anonymous = await worker.fetch(request("/api/v1/skills"), env);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, "admin_authentication_required");
});

test("logout revokes the D1 session and clears the browser cookie", async () => {
  const fetch = async (url) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-access-token" });
    }
    if (String(url) === "https://api.github.com/user") {
      return Response.json({ id: 123456, login: "GrandpaNiuu", name: "Grandpa Niu" });
    }
    return new Response(null, { status: 404 });
  };
  const { worker, env } = harness(fetch);
  const sessionCookie = await loginSession(worker, env);

  const logout = await worker.fetch(request("/api/auth/logout", {
    method: "POST",
    headers: { cookie: sessionCookie },
  }), env);

  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie"), /^tg_admin_session=;.*Max-Age=0/i);
  const afterLogout = await worker.fetch(request("/api/v1/skills", {
    headers: { cookie: sessionCookie },
  }), env);
  assert.equal(afterLogout.status, 401);
});

test("a different GitHub account cannot become the administrator", async () => {
  const fetch = async (url) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "attacker-token" });
    }
    if (String(url) === "https://api.github.com/user") {
      return Response.json({ id: 999, login: "NotGrandpaNiuu", name: "Other User" });
    }
    return new Response(null, { status: 404 });
  };
  const { worker, env } = harness(fetch);
  const start = await worker.fetch(request("/api/auth/github/start"), env);
  const state = new URL(start.headers.get("location")).searchParams.get("state");

  const response = await worker.fetch(request(`/api/auth/github/callback?code=oauth-code&state=${state}`, {
    headers: { cookie: `tg_oauth_state=${state}` },
  }), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "admin_forbidden");
  assert.doesNotMatch(response.headers.get("set-cookie") || "", /tg_admin_session=/);
});

test("the configured login is rejected when its immutable GitHub user id does not match", async () => {
  const fetch = async (url) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "attacker-token" });
    }
    if (String(url) === "https://api.github.com/user") {
      return Response.json({ id: 999, login: "GrandpaNiuu", name: "Renamed account" });
    }
    return new Response(null, { status: 404 });
  };
  const { worker, env } = harness(fetch);
  const start = await worker.fetch(request("/api/auth/github/start"), env);
  const state = new URL(start.headers.get("location")).searchParams.get("state");

  const response = await worker.fetch(request(`/api/auth/github/callback?code=oauth-code&state=${state}`, {
    headers: { cookie: `tg_oauth_state=${state}` },
  }), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "admin_forbidden");
  assert.doesNotMatch(response.headers.get("set-cookie") || "", /tg_admin_session=/);
});

test("an OAuth state cannot be replayed", async () => {
  let githubCalls = 0;
  const fetch = async (url) => {
    githubCalls += 1;
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-access-token" });
    }
    return Response.json({ id: 123456, login: "GrandpaNiuu", name: "Grandpa Niu" });
  };
  const { worker, env } = harness(fetch);
  const start = await worker.fetch(request("/api/auth/github/start"), env);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const callbackRequest = () => request(`/api/auth/github/callback?code=oauth-code&state=${state}`, {
    headers: { cookie: `tg_oauth_state=${state}` },
  });

  assert.equal((await worker.fetch(callbackRequest(), env)).status, 302);
  const replay = await worker.fetch(callbackRequest(), env);

  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error.code, "invalid_oauth_state");
  assert.equal(githubCalls, 2);
});

test("an expired administrator session is rejected", async () => {
  const fetch = async (url) => String(url).includes("access_token")
    ? Response.json({ access_token: "github-access-token" })
    : Response.json({ id: 123456, login: "GrandpaNiuu", name: "Grandpa Niu" });
  const { worker, env, setNow } = harness(fetch);
  const sessionCookie = await loginSession(worker, env);
  setNow("2026-07-26T00:00:01.000Z");

  const identity = await worker.fetch(request("/api/auth/session", {
    headers: { cookie: sessionCookie },
  }), env);
  assert.deepEqual((await identity.json()).data, { authenticated: false, provider: "github" });

  const admin = await worker.fetch(request("/api/v1/skills", {
    headers: { cookie: sessionCookie },
  }), env);
  assert.equal(admin.status, 401);
});
