import { HttpError, json } from "./http.js";
import { createEmailAuth } from "./email-auth.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_PATTERN_FOR_SESSION = /^[A-Za-z0-9_-]{32,128}$/;

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

function publicAuthConfiguration(env) {
  const githubEnabled = Boolean(String(env.GITHUB_OAUTH_CLIENT_ID || "").trim()
    && String(env.GITHUB_OAUTH_CLIENT_SECRET || "").trim());
  const turnstileSiteKey = String(env.TURNSTILE_SITE_KEY || "").trim();
  const emailEnabled = Boolean(
    turnstileSiteKey
    && String(env.TURNSTILE_SECRET_KEY || "").trim()
    && String(env.RESEND_API_KEY || "").trim()
    && String(env.AUTH_EMAIL_FROM || "").trim()
    && String(env.PASSWORD_PEPPER || "").length >= 16
    && String(env.ADMIN_ORIGIN || "").trim(),
  );
  return {
    github_enabled: githubEnabled,
    email_enabled: emailEnabled,
    registration_enabled: true,
    turnstile_site_key: emailEnabled ? turnstileSiteKey : null,
  };
}

async function sessionIdentity(request, env, repository, timestamp) {
  const policy = identityPolicy(env);
  const token = cookieValue(request, "tg_session");
  if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    const session = await repository.getUserSession(await tokenHash(token), timestamp);
    if (session) {
      return {
        authenticated: true,
        user_id: session.user_id,
        role: session.role,
        provider: session.provider,
        login: session.github_login || session.email || null,
        name: session.github_name || session.display_name || null,
        email: session.email || null,
      };
    }
  }

  // Existing deployments keep working until their old administrator cookie expires.
  const legacyToken = cookieValue(request, "tg_admin_session");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(legacyToken)) return null;
  const legacy = await repository.getAdminSession(await tokenHash(legacyToken), timestamp);
  if (!legacy || legacy.github_login.toLowerCase() !== policy.allowedLogin.toLowerCase()) return null;
  if (legacy.github_user_id !== policy.allowedUserId) return null;
  return {
    authenticated: true,
    user_id: legacy.user_id || "legacy-admin",
    role: "admin",
    provider: "github",
    login: legacy.github_login,
    name: legacy.github_name || null,
    email: null,
  };
}

export function createAdminAuth(dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || (() => new Date());
  const randomToken = dependencies.randomToken || secureToken;
  const emailAuth = createEmailAuth({ fetch: fetchImpl, now, randomToken });

  return {
    async handle(request, env, repository) {
      const url = new URL(request.url);
      const emailResponse = await emailAuth.handle(request, env, repository);
      if (emailResponse) return emailResponse;
      if (url.pathname === "/api/auth/config" && request.method === "GET") {
        return json({ data: publicAuthConfiguration(env) });
      }
      if (["/api/auth/me", "/api/auth/session"].includes(url.pathname) && request.method === "GET") {
        const identity = await sessionIdentity(request, env, repository, new Date(now()).toISOString());
        return json({ data: identity || { authenticated: false, provider: "github" } });
      }

      if ((url.pathname === "/api/auth/sessions" || url.pathname.startsWith("/api/auth/sessions/"))) {
        const timestamp = new Date(now()).toISOString();
        const identity = await sessionIdentity(request, env, repository, timestamp);
        if (!identity) throw new HttpError(401, "authentication_required", "?????");
        if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
          const token = cookieValue(request, "tg_session");
          const currentHash = TOKEN_PATTERN_FOR_SESSION.test(token) ? await tokenHash(token) : "";
          return json({ data: await repository.listUserSessions(identity.user_id, currentHash, timestamp) });
        }
        if (request.method === "DELETE") {
          const sessionId = decodeURIComponent(url.pathname.slice("/api/auth/sessions/".length));
          if (!/^[A-Za-z0-9_-]{8,160}$/.test(sessionId)) {
            throw new HttpError(404, "session_not_found", "????????");
          }
          const revoked = await repository.revokeUserSessionById(identity.user_id, sessionId, timestamp);
          if (!revoked) throw new HttpError(404, "session_not_found", "????????");
          return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        }
        throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const timestamp = new Date(now()).toISOString();
        const token = cookieValue(request, "tg_session");
        if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
          await repository.revokeUserSession(await tokenHash(token), timestamp);
        }
        const legacyToken = cookieValue(request, "tg_admin_session");
        if (/^[A-Za-z0-9_-]{32,128}$/.test(legacyToken)) {
          await repository.revokeAdminSession(await tokenHash(legacyToken), timestamp);
        }
        const headers = new Headers({ "cache-control": "no-store" });
        headers.append("set-cookie", "tg_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
        headers.append("set-cookie", "tg_admin_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
        return new Response(null, { status: 204, headers });
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

        const githubUser = await githubIdentity(code, savedState.code_verifier, config, fetchImpl);
        const isAdmin = String(githubUser.id) === config.allowedUserId;
        const user = await repository.upsertGithubUser({
          id: `user-${randomToken(18)}`,
          github_user_id: String(githubUser.id),
          github_login: githubUser.login,
          github_name: typeof githubUser.name === "string" ? githubUser.name.slice(0, 200) : null,
          is_admin: isAdmin,
          timestamp,
        });

        const sessionToken = randomToken();
        const ttl = sessionTtlSeconds(env);
        await repository.createUserSession({
          id: `session-${randomToken(18)}`,
          token_hash: await tokenHash(sessionToken),
          user_id: user.id,
          provider: "github",
          user_agent_label: String(request.headers.get("user-agent") || "").slice(0, 160),
          created_at: timestamp,
          expires_at: new Date(new Date(timestamp).getTime() + ttl * 1000).toISOString(),
        });

        const headers = new Headers();
        headers.append("set-cookie", `tg_session=${sessionToken}; Max-Age=${ttl}; Path=/; HttpOnly; Secure; SameSite=Lax`);
        headers.append("set-cookie", "tg_oauth_state=; Max-Age=0; Path=/api/auth/github/callback; HttpOnly; Secure; SameSite=Lax");
        return redirect(`${config.origin}${savedState.return_to}`, headers);
      }

      throw new HttpError(404, "not_found", "Route not found.");
    },

    async verify(request, env, repository) {
      const identity = await sessionIdentity(request, env, repository, new Date(now()).toISOString());
      if (!identity) {
        throw new HttpError(401, "authentication_required", "?????");
      }
      return identity;
    },
  };
}

export const __test = { configuredOrigin, tokenHash };
