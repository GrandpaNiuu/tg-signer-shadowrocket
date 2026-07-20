import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "./src/app.js";
import { HttpError } from "./src/http.js";

function fixedUuid() {
  return "request-test-id";
}

function authWorker(handle) {
  return createWorker({
    uuid: fixedUuid,
    repositoryFactory: () => ({}),
    adminAuth: {
      handle,
      async verify() { return null; },
    },
  });
}

test("unknown routes include a request id in the header and JSON body", async () => {
  const worker = createWorker({ uuid: fixedUuid });
  const response = await worker.fetch(new Request("https://example.test/unknown"), {});

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-request-id"), "request-test-id");
  assert.deepEqual(await response.json(), {
    error: { code: "not_found", message: "Route not found." },
    request_id: "request-test-id",
  });
});

test("method-not-allowed responses receive the same request id", async () => {
  const repository = {
    forUser() {
      return {};
    },
  };
  const worker = createWorker({
    uuid: fixedUuid,
    repositoryFactory: () => repository,
    verifyAdmin: async () => ({ user_id: "user-1", role: "user" }),
  });

  const response = await worker.fetch(new Request("https://example.test/api/v1/accounts", {
    method: "PUT",
  }), {});

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("x-request-id"), "request-test-id");
  assert.equal(response.headers.get("allow"), "GET, POST");
  assert.deepEqual(await response.json(), {
    error: { code: "method_not_allowed", message: "Method not allowed." },
    request_id: "request-test-id",
  });
});

test("valid cf-ray is preserved as the request id", async () => {
  const worker = createWorker({ uuid: fixedUuid });
  const response = await worker.fetch(new Request("https://example.test/health", {
    headers: { "cf-ray": "0123456789abcdef-SJC" },
  }), {});

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "0123456789abcdef-SJC");
  assert.deepEqual(await response.json(), {
    ok: true,
    worker: "tg-signer-shadowrocket",
  });
});

test("invalid or oversized cf-ray values fall back to a generated id", async () => {
  const worker = createWorker({ uuid: fixedUuid });
  for (const candidate of [
    "contains spaces",
    "contains/slash",
    "x".repeat(81),
  ]) {
    const response = await worker.fetch(new Request("https://example.test/health", {
      headers: { "cf-ray": candidate },
    }), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "request-test-id");
  }
});

test("204 authentication responses preserve multiple cookies", async () => {
  const worker = authWorker(async () => {
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", "tg_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
    headers.append("set-cookie", "tg_admin_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
    return new Response(null, { status: 204, headers });
  });

  const response = await worker.fetch(new Request("https://example.test/api/auth/logout", {
    method: "POST",
  }), {});

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("x-request-id"), "request-test-id");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(response.headers.getSetCookie(), [
    "tg_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    "tg_admin_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
  ]);
});

test("302 authentication responses preserve redirect headers and cookies", async () => {
  const worker = authWorker(async () => new Response(null, {
    status: 302,
    headers: {
      location: "https://github.com/login/oauth/authorize?client_id=test",
      "cache-control": "no-store",
      "set-cookie": "tg_oauth_state=opaque; Path=/api/auth/github/callback; HttpOnly; Secure; SameSite=Lax",
    },
  }));

  const response = await worker.fetch(new Request("https://example.test/api/auth/github/start"), {});

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("x-request-id"), "request-test-id");
  assert.equal(response.headers.get("location"), "https://github.com/login/oauth/authorize?client_id=test");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("set-cookie"),
    "tg_oauth_state=opaque; Path=/api/auth/github/callback; HttpOnly; Secure; SameSite=Lax",
  );
});

for (const status of [401, 403, 422, 500]) {
  test(`${status} authentication errors include the same request id`, async () => {
    const worker = authWorker(async () => {
      throw new HttpError(status, `error_${status}`, `Authentication error ${status}.`);
    });

    const response = await worker.fetch(new Request("https://example.test/api/auth/test"), {});

    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-request-id"), "request-test-id");
    assert.deepEqual(await response.json(), {
      error: { code: `error_${status}`, message: `Authentication error ${status}.` },
      request_id: "request-test-id",
    });
  });
}
