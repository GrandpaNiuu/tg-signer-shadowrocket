import assert from "node:assert/strict";
import test from "node:test";

import { verifyAdminRequest, verifyRunnerRequest } from "../src/auth.js";

function encode(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

async function fixtureToken(claimOverrides = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = encode({
    iss: "https://token.actions.githubusercontent.com",
    aud: "https://worker.example/api/runner",
    repository: "owner/repo",
    ref: "refs/heads/main",
    workflow_ref: "owner/repo/.github/workflows/task-runner.yml@refs/heads/main",
    run_id: "1234",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    ...claimOverrides,
  });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { token: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...jwk, kid: "test-key", alg: "RS256", use: "sig" } };
}

test("runner OIDC verifies signature, audience, repository, ref, and run_id", async () => {
  const { token, jwk } = await fixtureToken();
  const fetch = async (url) => {
    if (String(url).endsWith("openid-configuration")) {
      return Response.json({ jwks_uri: "https://token.actions.githubusercontent.com/.well-known/jwks" });
    }
    return Response.json({ keys: [jwk] });
  };
  const request = new Request("https://worker.example/api/runner/runs/run-1/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  const claims = await verifyRunnerRequest(request, {
    RUNNER_OIDC_AUDIENCE: "https://worker.example/api/runner",
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_REF: "main",
    TASK_RUNNER_WORKFLOW_FILE: "task-runner.yml",
  }, { fetch, now: () => Date.now(), cache: new Map() });

  assert.equal(claims.run_id, "1234");
});

test("runner OIDC rejects a token from another repository", async () => {
  const { token, jwk } = await fixtureToken({ repository: "attacker/repo" });
  const fetch = async (url) => Response.json(String(url).endsWith("openid-configuration")
    ? { jwks_uri: "https://token.actions.githubusercontent.com/.well-known/jwks" }
    : { keys: [jwk] });

  await assert.rejects(
    verifyRunnerRequest(new Request("https://worker.example", { headers: { authorization: `Bearer ${token}` } }), {
      RUNNER_OIDC_AUDIENCE: "https://worker.example/api/runner",
      GITHUB_OWNER: "owner",
      GITHUB_REPO: "repo",
      GITHUB_REF: "main",
      TASK_RUNNER_WORKFLOW_FILE: "task-runner.yml",
    }, { fetch, cache: new Map() }),
    (error) => error.status === 401 && error.code === "invalid_runner_identity",
  );
});

test("admin identity header is accepted only with explicit local-development opt-in", async () => {
  const request = new Request("http://localhost/api/v1/dashboard", {
    headers: { "cf-access-authenticated-user-email": "admin@example.com" },
  });
  assert.deepEqual(await verifyAdminRequest(request, {
    ACCESS_ALLOW_HEADER: "true",
    ADMIN_EMAIL: "admin@example.com",
  }), { email: "admin@example.com", source: "trusted_header" });

  await assert.rejects(
    verifyAdminRequest(request, { ADMIN_EMAIL: "admin@example.com" }),
    (error) => error.status === 401,
  );
});
