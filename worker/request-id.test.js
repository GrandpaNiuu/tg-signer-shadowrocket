import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "./src/app.js";

function fixedUuid() {
  return "request-test-id";
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
