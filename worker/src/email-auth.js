import { sendTransactionalEmail } from "./email-delivery.js";
import { HttpError, json, readJson } from "./http.js";
import { hashPassword, verifyPassword } from "./password.js";
import { publicPasswordAuthConfiguration } from "./public-auth-configuration.js";
import { verifyTurnstileToken } from "./turnstile.js";

const encoder = new TextEncoder();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const VERIFICATION_CODE_PATTERN = /^\d{6}$/;
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const VERIFICATION_RESEND_SECONDS = 60;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function normalizeEmail(value) {
  return String(value || "").trim().normalize("NFKC").toLowerCase();
}

function exactInput(body, fields) {
  const unknown = Object.keys(body).filter((key) => !fields.includes(key));
  if (unknown.length) throw new HttpError(422, "validation_failed", "输入内容无效。", { fields: unknown });
}

function emailInput(value) {
  const original = String(value || "").trim().normalize("NFKC");
  const normalized = normalizeEmail(original);
  if (!normalized || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new HttpError(422, "validation_failed", "请输入有效的邮箱地址。", { fields: ["email"] });
  }
  return { original, normalized };
}

function passwordInput(value) {
  const password = String(value || "");
  if (password.length < 12 || password.length > 1024) {
    throw new HttpError(422, "validation_failed", "密码至少需要 12 个字符。", { fields: ["password"] });
  }
  return password;
}

function verificationCodeInput(value) {
  const code = String(value || "").trim();
  if (!VERIFICATION_CODE_PATTERN.test(code)) {
    throw new HttpError(422, "validation_failed", "请输入 6 位数字验证码。", { fields: ["code"] });
  }
  return code;
}

function turnstileInput(value, { required = true } = {}) {
  const token = String(value || "").trim();
  if ((required && !token) || token.length > 2048) {
    throw new HttpError(422, "validation_failed", "请完成人机验证。", { fields: ["turnstile_token"] });
  }
  return token;
}

function authConfiguration(env, { requireRegistration = false, emailDelivery = false } = {}) {
  const passwordAuth = publicPasswordAuthConfiguration(env);
  if (!passwordAuth.enabled) {
    throw new HttpError(503, "email_auth_not_configured", "邮箱登录服务尚未完成配置。");
  }
  if (requireRegistration && !passwordAuth.registrationEnabled) {
    throw new HttpError(
      503,
      "secure_registration_not_configured",
      "邮箱新注册暂时关闭。管理员完成邮件验证与人机验证配置后才会开放。",
    );
  }
  if (emailDelivery && !passwordAuth.passwordResetEnabled) {
    throw new HttpError(503, "email_auth_not_configured", "邮箱找回服务尚未完成配置。");
  }
  return {
    localMode: passwordAuth.localMode,
    registrationEnabled: passwordAuth.registrationEnabled,
    emailVerificationRequired: passwordAuth.emailVerificationRequired,
    turnstileSecret: passwordAuth.turnstileSecretKey,
    apiKey: passwordAuth.resendApiKey,
    from: passwordAuth.emailFrom,
    origin: passwordAuth.origin,
    passwordPepper: String(env.PASSWORD_PEPPER || ""),
  };
}

async function verifyAuthChallenge(request, env, config, responseToken, action, fetchImpl) {
  return verifyTurnstileToken({
    request,
    responseToken,
    secret: config.turnstileSecret,
    origin: config.origin,
    action,
    env,
    fetchImpl,
  });
}

async function sendEmail(fetchImpl, env, config, message) {
  return sendTransactionalEmail({
    fetchImpl,
    env,
    apiKey: config.apiKey,
    from: config.from,
    message,
  });
}

function logPasswordRecoveryDeliveryFailure(error) {
  console.warn(JSON.stringify({
    level: "warning",
    event: "password_recovery_delivery_failed",
    error: error instanceof Error ? error.name : "UnknownError",
  }));
}

function randomVerificationCode() {
  const range = 1_000_000;
  const maximum = 0x1_0000_0000 - (0x1_0000_0000 % range);
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values); while (values[0] >= maximum);
  return String(values[0] % range).padStart(6, "0");
}

async function verificationToken(userId, code, passwordPepper) {
  return sha256(`email-verification-code-v1\u0000${userId}\u0000${code}\u0000${passwordPepper}`);
}

async function createVerificationCode(repository, randomToken, userId, timestamp, config) {
  const code = randomVerificationCode();
  const token = await verificationToken(userId, code, config.passwordPepper);
  await repository.createAuthToken({
    id: `auth-${randomToken(18)}`,
    token_hash: await sha256(token),
    user_id: userId,
    token_type: "verify_email",
    expires_at: new Date(timestamp.getTime() + VERIFICATION_CODE_TTL_MS).toISOString(),
    created_at: timestamp.toISOString(),
  });
  return { code, token };
}

async function sendVerificationEmail(fetchImpl, env, config, email, verification) {
  const verificationUrl = `${config.origin}/#/verify-email?token=${verification.token}`;
  await sendEmail(fetchImpl, env, config, {
    to: [email],
    subject: "Telegram 自动消息邮箱验证码",
    html: `<p>您的邮箱验证码是：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0">${verification.code}</p><p>验证码将在 10 分钟后失效，请勿转发给他人。</p><p>也可以点击下面的备用链接完成验证：</p><p><a href="${verificationUrl}">验证邮箱</a></p><p>如果不是您本人操作，请忽略此邮件。</p>`,
  });
}

function sessionTtlSeconds(env) {
  const configured = Number(env.ADMIN_SESSION_TTL_SECONDS || 604800);
  return Number.isInteger(configured) && configured >= 300 && configured <= 2592000 ? configured : 604800;
}

async function enforceRateLimit(repository, request, action, identity, now, limit, windowSeconds) {
  const timestamp = now.getTime();
  const windowStart = Math.floor(timestamp / (windowSeconds * 1000)) * windowSeconds * 1000;
  const remoteIp = String(request.headers.get("cf-connecting-ip") || "unknown");
  const allowed = await repository.consumeAuthRateLimit({
    action,
    bucket_hash: await sha256(`${remoteIp}\u0000${identity}`),
    window_started_at: new Date(windowStart).toISOString(),
    expires_at: new Date(windowStart + windowSeconds * 1000).toISOString(),
    limit,
  });
  if (!allowed) throw new HttpError(429, "rate_limited", "尝试次数过多，请稍后再试。");
}

async function enforceVerificationSendLimits(repository, request, emailNormalized, timestamp) {
  await enforceRateLimit(repository, request, "verification_code_send_minute", emailNormalized, timestamp, 1, VERIFICATION_RESEND_SECONDS);
  await enforceRateLimit(repository, request, "verification_code_send_hour", emailNormalized, timestamp, 5, 3600);
}

async function issueVerificationCode({ repository, request, email, user, timestamp, config, randomToken, fetchImpl, env }) {
  await enforceVerificationSendLimits(repository, request, email.normalized, timestamp);
  const verification = await createVerificationCode(repository, randomToken, user.id, timestamp, config);
  await sendVerificationEmail(fetchImpl, env, config, user.email || email.original, verification);
}

function sessionIdentity(user, provider = "email") {
  return {
    authenticated: true,
    user_id: user.id,
    role: user.role,
    provider,
    login: user.email,
    name: user.display_name,
    email: user.email,
  };
}

export function createEmailAuth(dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || (() => new Date());
  const randomToken = dependencies.randomToken;
  if (typeof randomToken !== "function") throw new Error("randomToken dependency is required");

  async function createSession(request, env, repository, user, status = 200) {
    const timestamp = new Date(now()).toISOString();
    const ttl = sessionTtlSeconds(env);
    const token = randomToken();
    await repository.createUserSession({
      id: `session-${randomToken(18)}`,
      token_hash: await sha256(token),
      user_id: user.id,
      provider: "email",
      user_agent_label: String(request.headers.get("user-agent") || "").slice(0, 160),
      created_at: timestamp,
      expires_at: new Date(Date.parse(timestamp) + ttl * 1000).toISOString(),
    });
    return json({ data: sessionIdentity(user) }, status, {
      "set-cookie": `tg_session=${token}; Max-Age=${ttl}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  return {
    async handle(request, env, repository) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/api/auth/email/")) return null;
      if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      const timestamp = new Date(now());

      if (path === "/api/auth/email/register") {
        const config = authConfiguration(env, { requireRegistration: true });
        const body = await readJson(request, 8_192);
        exactInput(body, ["email", "display_name", "password", "turnstile_token"]);
        const email = emailInput(body.email);
        const displayName = String(body.display_name || "").trim().normalize("NFKC");
        if (!displayName || displayName.length > 80) {
          throw new HttpError(422, "validation_failed", "请输入显示名称。", { fields: ["display_name"] });
        }
        const password = passwordInput(body.password);
        await verifyAuthChallenge(request, env, config, turnstileInput(body.turnstile_token, {
          required: Boolean(config.turnstileSecret),
        }), "email_register", fetchImpl);
        await enforceRateLimit(repository, request, "register_ip", "*", timestamp, 5, 3600);
        await enforceRateLimit(repository, request, "register", email.normalized, timestamp, 5, 3600);
        const passwordRecord = await hashPassword(password, env);
        const createdAt = timestamp.toISOString();

        if (config.localMode) {
          const result = await repository.createOrActivateLocalEmailUser({
            id: `user-${randomToken(18)}`,
            display_name: displayName,
            email: email.original,
            email_normalized: email.normalized,
            created_at: createdAt,
            updated_at: createdAt,
          }, passwordRecord);
          if (!result.created) {
            throw new HttpError(409, "account_exists", "该邮箱已注册，请直接登录。");
          }
          return createSession(request, env, repository, result.user, 201);
        }

        const result = await repository.createOrUpdatePendingEmailUser({
          id: `user-${randomToken(18)}`,
          display_name: displayName,
          email: email.original,
          email_normalized: email.normalized,
          created_at: createdAt,
          updated_at: createdAt,
        }, passwordRecord);
        if (!result.verification_required) {
          throw new HttpError(409, "account_exists", "该邮箱已注册，请直接登录或找回密码。");
        }
        await issueVerificationCode({ repository, request, email, user: result.user, timestamp, config, randomToken, fetchImpl, env });
        return json({ data: { status: "verification_required" } }, 202);
      }

      if (path === "/api/auth/email/verify-code") {
        const config = authConfiguration(env, { requireRegistration: true });
        const body = await readJson(request, 2_048);
        exactInput(body, ["email", "code"]);
        const email = emailInput(body.email);
        const code = verificationCodeInput(body.code);
        await enforceRateLimit(repository, request, "verification_code_attempt", email.normalized, timestamp, 5, 600);
        const pendingUser = await repository.getUserByEmail(email.normalized);
        const userId = pendingUser?.id || "missing-user";
        const token = await verificationToken(userId, code, config.passwordPepper);
        const user = await repository.consumeEmailVerification(await sha256(token), timestamp.toISOString());
        if (!user) throw new HttpError(400, "invalid_or_expired_code", "验证码错误或已过期。");
        return json({ data: { status: "verified" } });
      }

      if (path === "/api/auth/email/resend-code") {
        const config = authConfiguration(env, { requireRegistration: true });
        const body = await readJson(request, 2_048);
        exactInput(body, ["email"]);
        const email = emailInput(body.email);
        await enforceVerificationSendLimits(repository, request, email.normalized, timestamp);
        const user = await repository.getUserByEmail(email.normalized);
        if (user && !user.email_verified_at && ["pending", "active"].includes(user.status)) {
          const verification = await createVerificationCode(repository, randomToken, user.id, timestamp, config);
          await sendVerificationEmail(fetchImpl, env, config, user.email || email.original, verification);
        }
        return json({ data: { status: "accepted", resend_after_seconds: VERIFICATION_RESEND_SECONDS } }, 202);
      }

      if (path === "/api/auth/email/verify") {
        const body = await readJson(request, 2_048);
        exactInput(body, ["token"]);
        const token = String(body.token || "").trim();
        if (!TOKEN_PATTERN.test(token)) throw new HttpError(400, "invalid_or_expired_token", "验证链接无效或已过期。");
        const user = await repository.consumeEmailVerification(await sha256(token), timestamp.toISOString());
        if (!user) throw new HttpError(400, "invalid_or_expired_token", "验证链接无效或已过期。");
        return json({ data: { status: "verified" } });
      }

      if (path === "/api/auth/email/login") {
        const config = authConfiguration(env);
        const body = await readJson(request, 8_192);
        exactInput(body, ["email", "password", "turnstile_token"]);
        const email = emailInput(body.email);
        const password = passwordInput(body.password);
        await verifyAuthChallenge(request, env, config, turnstileInput(body.turnstile_token, {
          required: Boolean(config.turnstileSecret),
        }), "email_login", fetchImpl);
        if (config.localMode) {
          await enforceRateLimit(repository, request, "login_ip", "*", timestamp, 30, 900);
        }
        await enforceRateLimit(repository, request, "login", email.normalized, timestamp, 10, 900);
        const user = await repository.getUserByEmail(email.normalized);
        const valid = user
          ? await verifyPassword(password, user, env)
          : (await hashPassword(password, env), false);
        if (!valid || user.status === "disabled") {
          throw new HttpError(401, "invalid_credentials", "邮箱或密码不正确。");
        }
        if (user.status !== "active" || (config.emailVerificationRequired && !user.email_verified_at)) {
          if (config.registrationEnabled && !user.email_verified_at && ["pending", "active"].includes(user.status)) {
            await issueVerificationCode({ repository, request, email, user, timestamp, config, randomToken, fetchImpl, env });
            throw new HttpError(403, "email_verification_required", "请先输入邮箱收到的 6 位验证码完成验证。新的验证码已经发送。");
          }
          throw new HttpError(403, "email_verification_required", "请先输入邮箱收到的 6 位验证码完成验证。");
        }
        return createSession(request, env, repository, user);
      }

      if (path === "/api/auth/email/forgot-password") {
        const config = authConfiguration(env, { emailDelivery: true });
        const body = await readJson(request, 4_096);
        exactInput(body, ["email", "turnstile_token"]);
        const email = emailInput(body.email);
        await verifyAuthChallenge(
          request,
          env,
          config,
          turnstileInput(body.turnstile_token),
          "forgot_password",
          fetchImpl,
        );
        await enforceRateLimit(repository, request, "forgot_password", email.normalized, timestamp, 5, 3600);
        const user = await repository.getUserByEmail(email.normalized);
        if (user?.status === "active" && user.email_verified_at) {
          try {
            const token = randomToken();
            const createdAt = timestamp.toISOString();
            await repository.createAuthToken({
              id: `auth-${randomToken(18)}`,
              token_hash: await sha256(token),
              user_id: user.id,
              token_type: "password_reset",
              expires_at: new Date(timestamp.getTime() + 30 * 60 * 1000).toISOString(),
              created_at: createdAt,
            });
            const resetUrl = `${config.origin}/#/reset-password?token=${token}`;
            await sendEmail(fetchImpl, env, config, {
              to: [user.email],
              subject: "重置 Telegram 自动消息平台密码",
              html: `<p>请点击下面的链接重置密码：</p><p><a href="${resetUrl}">重置密码</a></p><p>链接将在 30 分钟后失效。</p>`,
            });
          } catch (error) {
            logPasswordRecoveryDeliveryFailure(error);
          }
        }
        return json({ data: { status: "accepted" } }, 202);
      }

      if (path === "/api/auth/email/reset-password") {
        const config = authConfiguration(env, { emailDelivery: true });
        const body = await readJson(request, 8_192);
        exactInput(body, ["token", "password", "turnstile_token"]);
        const token = String(body.token || "").trim();
        if (!TOKEN_PATTERN.test(token)) throw new HttpError(400, "invalid_or_expired_token", "重置链接无效或已过期。");
        const password = passwordInput(body.password);
        await verifyAuthChallenge(
          request,
          env,
          config,
          turnstileInput(body.turnstile_token),
          "reset_password",
          fetchImpl,
        );
        await enforceRateLimit(repository, request, "reset_password", await sha256(token), timestamp, 10, 3600);
        const passwordRecord = await hashPassword(password, env);
        const user = await repository.consumePasswordReset(await sha256(token), passwordRecord, timestamp.toISOString());
        if (!user) throw new HttpError(400, "invalid_or_expired_token", "重置链接无效或已过期。");
        return json({ data: { status: "password_reset" } });
      }

      throw new HttpError(404, "not_found", "Route not found.");
    },
  };
}

export const __test = {
  normalizeEmail,
  randomVerificationCode,
  verificationToken,
  VERIFICATION_CODE_TTL_MS,
  VERIFICATION_RESEND_SECONDS,
};
