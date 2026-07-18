import { HttpError, json } from "./http.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function secureToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function tokenHash(token) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

function configuredOrigin(env) {
  try {
    const url = new URL(String(env.ADMIN_ORIGIN || ""));
    if (url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(503, "admin_auth_not_configured", "Administrator login is not configured.");
  }
}

function oauthConfiguration(env) {
  const clientId = String(env.GITHUB_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(env.GITHUB_OAUTH_CLIENT_SECRET || "").trim();
  const policy = identityPolicy(env);
  if (!clientId || !clientSecret) {
    throw new HttpError(503, "admin_auth_not_configured", "Administrator login is not configured.");
  }
  return { clientId, clientSecret, ...policy, origin: configuredOrigin(env) };
}

function identityPolicy(env) {
  const allowedLogin = String(env.ADMIN_GITHUB_LOGIN || "").trim();
  const allowedUserId = String(env.ADMIN_GITHUB_USER_ID || "").trim();
  if (!allowedLogin || !/^[1-9]\d*$/.test(allowedUserId)) {
    throw new HttpError(503, "admin_auth_not_configured", "Administrator login is not configured.");
  }
  return { allowedLogin, allowedUserId };
}

function redirect(location, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("location", location);
  responseHeaders.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers: responseHeaders });
}

function cookieValue(request, name) {
  for (const item of String(request.headers.get("cookie") || "").split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return "";
}

async function githubIdentity(code, codeVerifier, config, fetchImpl) {
  if (!config.clientSecret) {
    throw new HttpError(503, "admin_auth_not_configured", "Administrator login is not configured.");
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) {
    throw new HttpError(400, "invalid_oauth_state", "GitHub login state is invalid or expired.");
  }
  const tokenResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: `${config.origin}/api/auth/github/callback`,
    }),
  });
  const token = tokenResponse.ok ? await tokenResponse.json() : null;
  if (!token?.access_token) {
    throw new HttpError(502, "github_oauth_failed", "GitHub login could not be completed.");
  }

  const userResponse = await fetchImpl("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "telegram-checkin-admin",
      "x-github-api-version": "2022-11-28",
    },
  });
  const user = userResponse.ok ? await userResponse.json() : null;
  if (!user || !Number.isSafeInteger(user.id) || typeof user.login !== "string") {
    throw new HttpError(502, "github_identity_failed", "GitHub identity could not be verified.");
  }
  return user;
}

function sessionTtlSeconds(env) {
  const configured = Number(env.ADMIN_SESSION_TTL_SECONDS || 604800);
  return Number.isInteger(configured) && configured >= 300 && configured <= 2592000 ? configured : 604800;
}

async function sessionIdentity(request, env, repository, timestamp) {
  const policy = identityPolicy(env);
  const token = cookieValue(request, "tg_admin_session");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const session = await repository.getAdminSession(await tokenHash(token), timestamp);
  if (!session || session.github_login.toLowerCase() !== policy.allowedLogin.toLowerCase()) return null;
  if (session.github_user_id !== policy.allowedUserId) return null;
  return {
    authenticated: true,
    provider: "github",
    login: session.github_login,
    name: session.github_name || null,
  };
}

export function createAdminAuth(dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || (() => new Date());
  const randomToken = dependencies.randomToken || secureToken;

  return {
    async handle(request, env, repository) {
      const url = new URL(request.url);
      if (["/api/auth/me", "/api/auth/session"].includes(url.pathname) && request.method === "GET") {
        const identity = await sessionIdentity(request, env, repository, new Date(now()).toISOString());
        return json({ data: identity || { authenticated: false, provider: "github" } });
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const token = cookieValue(request, "tg_admin_session");
        if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
          await repository.revokeAdminSession(await tokenHash(token), new Date(now()).toISOString());
        }
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "set-cookie": "tg_admin_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
          },
        });
      }

      if (url.pathname === "/api/auth/github/start" && request.method === "GET") {
        const config = oauthConfiguration(env);
        const state = randomToken();
        const codeVerifier = randomToken();
        const createdAt = new Date(now()).toISOString();
        const expiresAt = new Date(new Date(createdAt).getTime() + OAUTH_STATE_TTL_MS).toISOString();
        await repository.createAdminOAuthState({
          state_hash: await tokenHash(state),
          code_verifier: codeVerifier,
          return_to: "/#/dashboard",
          expires_at: expiresAt,
          created_at: createdAt,
        });

        const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
        authorizeUrl.searchParams.set("client_id", config.clientId);
        authorizeUrl.searchParams.set("redirect_uri", `${config.origin}/api/auth/github/callback`);
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", await tokenHash(codeVerifier));
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        return redirect(authorizeUrl.toString(), {
          "set-cookie": `tg_oauth_state=${state}; Max-Age=600; Path=/api/auth/github/callback; HttpOnly; Secure; SameSite=Lax`,
        });
      }

      if (url.pathname === "/api/auth/github/callback" && request.method === "GET") {
        const config = oauthConfiguration(env);
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        if (!/^[A-Za-z0-9_-]{32,128}$/.test(state) || !code || cookieValue(request, "tg_oauth_state") !== state) {
          throw new HttpError(400, "invalid_oauth_state", "GitHub login state is invalid or expired.");
        }
        const timestamp = new Date(now()).toISOString();
        const savedState = await repository.consumeAdminOAuthState(await tokenHash(state), timestamp);
        if (!savedState) {
          throw new HttpError(400, "invalid_oauth_state", "GitHub login state is invalid or expired.");
        }

        const user = await githubIdentity(code, savedState.code_verifier, config, fetchImpl);
        if (user.login.toLowerCase() !== config.allowedLogin.toLowerCase()
          || String(user.id) !== config.allowedUserId) {
          throw new HttpError(403, "admin_forbidden", "This GitHub account is not the configured administrator.");
        }

        const sessionToken = randomToken();
        const ttl = sessionTtlSeconds(env);
        await repository.createAdminSession({
          token_hash: await tokenHash(sessionToken),
          github_user_id: String(user.id),
          github_login: user.login,
          github_name: typeof user.name === "string" ? user.name.slice(0, 200) : null,
          created_at: timestamp,
          expires_at: new Date(new Date(timestamp).getTime() + ttl * 1000).toISOString(),
        });

        const headers = new Headers();
        headers.append("set-cookie", `tg_admin_session=${sessionToken}; Max-Age=${ttl}; Path=/; HttpOnly; Secure; SameSite=Lax`);
        headers.append("set-cookie", "tg_oauth_state=; Max-Age=0; Path=/api/auth/github/callback; HttpOnly; Secure; SameSite=Lax");
        return redirect(`${config.origin}${savedState.return_to}`, headers);
      }

      throw new HttpError(404, "not_found", "Route not found.");
    },

    async verify(request, env, repository) {
      const identity = await sessionIdentity(request, env, repository, new Date(now()).toISOString());
      if (!identity) {
        throw new HttpError(401, "admin_authentication_required", "GitHub administrator login is required.");
      }
      return identity;
    },
  };
}

export const __test = { configuredOrigin, tokenHash };
