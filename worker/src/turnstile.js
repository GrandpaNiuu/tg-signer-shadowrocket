import { HttpError } from "./http.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;
const ACTION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function timeoutFromEnv(env = {}) {
  const configured = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= MIN_TIMEOUT_MS && configured <= MAX_TIMEOUT_MS
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function expectedHostname(origin) {
  try {
    return new URL(String(origin || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function validationError() {
  return new HttpError(400, "turnstile_failed", "人机验证失败，请重新尝试。");
}

export async function verifyTurnstileToken({
  request,
  responseToken,
  secret,
  origin,
  action,
  env = {},
  fetchImpl = globalThis.fetch,
}) {
  if (!secret) return null;
  if (!ACTION_PATTERN.test(String(action || ""))) throw validationError();

  const hostname = expectedHostname(origin);
  if (!hostname) throw new HttpError(503, "email_auth_not_configured", "邮箱登录服务尚未完成配置。");

  const body = new URLSearchParams({
    secret,
    response: String(responseToken || ""),
  });
  const remoteIp = String(request?.headers?.get?.("cf-connecting-ip") || "").trim();
  if (remoteIp) body.set("remoteip", remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutFromEnv(env));
  let result = null;
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    result = response.ok ? await response.json() : null;
  } catch {
    result = null;
  } finally {
    clearTimeout(timeout);
  }

  if (result?.success !== true
    || String(result.action || "") !== action
    || String(result.hostname || "").toLowerCase() !== hostname) {
    throw validationError();
  }
  return result;
}

export const __test = { expectedHostname, timeoutFromEnv };
