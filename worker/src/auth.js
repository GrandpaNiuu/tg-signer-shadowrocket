import { HttpError } from "./http.js";

const sharedJwksCache = new Map();
const encoder = new TextEncoder();

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function parseJsonSegment(value) {
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength > 16_384) throw new Error("JWT segment is too large.");
  return JSON.parse(new TextDecoder().decode(bytes));
}

function audienceMatches(actual, expected) {
  return typeof actual === "string" ? actual === expected : Array.isArray(actual) && actual.includes(expected);
}

async function fetchJwks(url, fetchImpl, cache, now) {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now()) return cached.keys;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Identity key endpoint is unavailable.");
  const body = await response.json();
  if (!body || !Array.isArray(body.keys)) throw new Error("Identity key response is invalid.");
  cache.set(url, { keys: body.keys, expiresAt: now() + 3_600_000 });
  return body.keys;
}

async function verifyJwt(token, policy, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const cache = dependencies.cache || sharedJwksCache;
  if (typeof token !== "string" || token.length > 32_768) throw new Error("JWT is invalid.");
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("JWT is invalid.");
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = parseJsonSegment(encodedHeader);
  const claims = parseJsonSegment(encodedPayload);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("JWT algorithm is not allowed.");

  const keys = await fetchJwks(policy.jwksUrl, fetchImpl, cache, now);
  const jwk = keys.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === "RS256"));
  if (!jwk) throw new Error("JWT signing key is unknown.");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const validSignature = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    decodeBase64Url(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!validSignature) throw new Error("JWT signature is invalid.");

  const nowSeconds = Math.floor(now() / 1000);
  const skew = 60;
  if (claims.iss !== policy.issuer) throw new Error("JWT issuer is invalid.");
  if (!audienceMatches(claims.aud, policy.audience)) throw new Error("JWT audience is invalid.");
  if (!Number.isFinite(claims.exp) || claims.exp < nowSeconds - skew) throw new Error("JWT is expired.");
  if (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds + skew) throw new Error("JWT is not active.");
  if (Number.isFinite(claims.iat) && claims.iat > nowSeconds + skew) throw new Error("JWT issue time is invalid.");
  return claims;
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!match) throw new Error("Bearer token is required.");
  return match[1];
}

export async function verifyRunnerRequest(request, env, dependencies = {}) {
  try {
    if (!env.RUNNER_OIDC_AUDIENCE || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      throw new Error("Runner identity policy is incomplete.");
    }
    const issuer = "https://token.actions.githubusercontent.com";
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    const fetchImpl = dependencies.fetch || globalThis.fetch;
    const cache = dependencies.cache || sharedJwksCache;
    const now = dependencies.now || Date.now;
    const discoveryKey = `${discoveryUrl}#discovery`;
    let discovery = cache.get(discoveryKey);
    if (!discovery || discovery.expiresAt <= now()) {
      const response = await fetchImpl(discoveryUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("OIDC discovery is unavailable.");
      const body = await response.json();
      const jwksUrl = new URL(body.jwks_uri);
      if (jwksUrl.origin !== issuer) throw new Error("OIDC key endpoint has an invalid origin.");
      discovery = { jwksUrl: jwksUrl.toString(), expiresAt: now() + 3_600_000 };
      cache.set(discoveryKey, discovery);
    }

    const claims = await verifyJwt(bearerToken(request), {
      issuer,
      audience: env.RUNNER_OIDC_AUDIENCE,
      jwksUrl: discovery.jwksUrl,
    }, { ...dependencies, fetch: fetchImpl, cache, now });
    const expectedRepository = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    const configuredRef = env.GITHUB_REF || "main";
    const expectedRef = configuredRef.startsWith("refs/") ? configuredRef : `refs/heads/${configuredRef}`;
    if (claims.repository !== expectedRepository || claims.ref !== expectedRef || !/^\d+$/.test(String(claims.run_id || ""))) {
      throw new Error("Runner claims do not match this repository.");
    }
    const path = new URL(request.url).pathname;
    const workflowFile = path === "/api/runner/migrations/legacy"
      ? (env.MIGRATION_WORKFLOW_FILE || "migrate-legacy.yml")
      : path.startsWith("/api/runner/login-flows/")
        ? (env.LOGIN_WORKFLOW_FILE || "telegram-login.yml")
        : (env.TASK_RUNNER_WORKFLOW_FILE || "task-runner.yml");
    const explicitWorkflowRef = path === "/api/runner/migrations/legacy"
      ? env.MIGRATION_WORKFLOW_REF
      : path.startsWith("/api/runner/login-flows/")
        ? env.LOGIN_WORKFLOW_REF
        : env.RUNNER_WORKFLOW_REF;
    const expectedWorkflowRef = explicitWorkflowRef
      || `${expectedRepository}/.github/workflows/${workflowFile}@${expectedRef}`;
    if (claims.workflow_ref !== expectedWorkflowRef) {
      throw new Error("Runner workflow is not allowed.");
    }
    return claims;
  } catch {
    throw new HttpError(401, "invalid_runner_identity", "Runner identity could not be verified.");
  }
}
