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

function hostnameFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function expectedHostname(origin) {
  return hostnameFromUrl(origin);
}

function expectedHostnames(request, origin) {
  const hosts = new Set();
  for (const value of [
    origin,
    request?.url,
    request?.headers?.get?.("origin"),
    request?.headers?.get?.("referer"),
  ]) {
    const hostname = hostnameFromUrl(value);
    if (hostname) hosts.add(hostname);
  }
  return hosts;
}

function errorCodes(result) {
  return Array.isArray(result?.["error-codes"])
    ? result["error-codes"].map((value) => String(value || "")).filter(Boolean)
    : [];
}

function validationError(reason = "invalid", result = null) {
  const codes = errorCodes(result);
  let message = "人机验证失败，请重新尝试。";

  if (reason === "network") {
    message = "人机验证服务暂时无法连接，请稍后重新验证。";
  } else if (reason === "action") {
    message = "人机验证场景不匹配，请刷新页面后重新验证。";
  } else if (reason === "hostname") {
    message = "人机验证域名不匹配，请使用正式网站地址访问后重新验证。";
  } else if (codes.includes("timeout-or-duplicate")) {
    message = "人机验证已过期或已被使用，请重新验证后立即提交。";
  } else if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret")) {
    message = "人机验证服务配置错误，请管理员检查 Turnstile 密钥。";
  } else if (codes.includes("invalid-input-response") || codes.includes("missing-input-response")) {
    message = "人机验证结果无效，请重新验证。";
  }

  return new HttpError(400, "turnstile_failed", message, {
    reason,
    error_codes: codes,
  });
}

function logValidationFailure(reason, result, action, hosts) {
  console.warn(JSON.stringify({
    level: "warning",
    event: "turnstile_validation_failed",
    reason,
    expected_action: action,
    received_action: String(result?.action || ""),
    received_hostname: String(result?.hostname || "").toLowerCase(),
    expected_hostnames: [...hosts],
    error_codes: errorCodes(result),
  }));
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
  if (!ACTION_PATTERN.test(String(action || ""))) throw validationError("action");

  const hosts = expectedHostnames(request, origin);
  if (!hosts.size) throw new HttpError(503, "email_auth_not_configured", "邮箱登录服务尚未完成配置。");

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

  if (!result) {
    logValidationFailure("network", result, action, hosts);
    throw validationError("network", result);
  }
  if (result.success !== true) {
    logValidationFailure("invalid", result, action, hosts);
    throw validationError("invalid", result);
  }

  const receivedAction = String(result.action || "");
  // Older or cached widgets may omit action even when the token is otherwise valid.
  // A non-empty conflicting action is still rejected.
  if (receivedAction && receivedAction !== action) {
    logValidationFailure("action", result, action, hosts);
    throw validationError("action", result);
  }

  const receivedHostname = String(result.hostname || "").toLowerCase();
  if (!receivedHostname || !hosts.has(receivedHostname)) {
    logValidationFailure("hostname", result, action, hosts);
    throw validationError("hostname", result);
  }

  return result;
}

export const __test = { expectedHostname, expectedHostnames, timeoutFromEnv };