import { HttpError } from "./http.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15_000;

function timeoutFromEnv(env = {}) {
  const configured = Number(env.AUTH_EMAIL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= MIN_TIMEOUT_MS && configured <= MAX_TIMEOUT_MS
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function providerPayload(message = {}) {
  const payload = { ...message };
  if (!String(payload.text || "").trim() && payload.html) {
    payload.text = htmlToText(payload.html);
  }
  return payload;
}

function providerFailureReason(response, payload, networkFailure = "") {
  if (!response) return networkFailure || "network";
  if (response.status === 429) return "rate_limit";
  const code = String(payload?.name || payload?.code || "").toLowerCase();
  const message = String(payload?.message || payload?.error || "").toLowerCase();
  if (/testing emails|resend\.dev|domain.+not verified|verify.+domain/.test(message)) return "sender_domain";
  if (/api.?key|restricted_api_key|invalid_api_key/.test(`${code} ${message}`)) return "api_key";
  if (response.status >= 500) return "provider";
  return "rejected";
}

function deliveryError(reason, response) {
  if (reason === "sender_domain") {
    return new HttpError(
      502,
      "email_sender_not_verified",
      "邮件服务拒绝发送。请管理员在 Resend 验证自有发件域名，并确认 AUTH_EMAIL_FROM 与已验证域名完全一致。",
      { reason, provider_status: Number(response?.status || 0) },
    );
  }
  if (reason === "api_key") {
    return new HttpError(
      502,
      "email_provider_not_configured",
      "邮件服务鉴权失败。请管理员检查 RESEND_API_KEY 及其发送权限。",
      { reason, provider_status: Number(response?.status || 0) },
    );
  }
  if (reason === "rate_limit") {
    return new HttpError(
      502,
      "email_provider_rate_limited",
      "邮件服务当前发送过于频繁，请稍后重新获取验证码。",
      { reason, provider_status: Number(response?.status || 0) },
    );
  }
  if (reason === "timeout" || reason === "network" || reason === "provider") {
    return new HttpError(
      502,
      "email_delivery_unavailable",
      "验证邮件服务暂时不可用，请稍后重新获取验证码。",
      { reason, provider_status: Number(response?.status || 0) },
    );
  }
  return new HttpError(
    502,
    "email_delivery_failed",
    "验证邮件未被邮件服务接受，请稍后重试或联系管理员检查发件配置。",
    { reason, provider_status: Number(response?.status || 0) },
  );
}

function logDeliveryFailure(reason, response, payload) {
  console.warn(JSON.stringify({
    level: "warning",
    event: "transactional_email_delivery_failed",
    provider: "resend",
    reason,
    provider_status: Number(response?.status || 0),
    provider_code: String(payload?.name || payload?.code || "").slice(0, 80),
  }));
}

function recipientDomains(message = {}) {
  const addresses = Array.isArray(message.to) ? message.to : [message.to];
  return [...new Set(addresses.map((address) => String(address || "").split("@").at(-1)?.toLowerCase())
    .filter(Boolean))];
}

export async function sendTransactionalEmail({
  fetchImpl = globalThis.fetch,
  env = {},
  apiKey,
  from,
  message,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutFromEnv(env));
  let response = null;
  let networkFailure = "";
  const outbound = providerPayload(message);
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, ...outbound }),
      signal: controller.signal,
    });
  } catch (error) {
    networkFailure = error?.name === "AbortError" ? "timeout" : "network";
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;
  if (response) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  if (!response?.ok) {
    const reason = providerFailureReason(response, payload, networkFailure);
    logDeliveryFailure(reason, response, payload);
    throw deliveryError(reason, response);
  }

  const id = String(payload?.id || "").trim();
  if (!id) {
    logDeliveryFailure("invalid_response", response, payload);
    throw new HttpError(502, "email_delivery_invalid_response", "邮件服务返回了无效结果，请稍后重试。");
  }

  console.info(JSON.stringify({
    level: "info",
    event: "transactional_email_accepted",
    provider: "resend",
    provider_id: id,
    recipient_domains: recipientDomains(outbound),
  }));
  return { id, provider: "resend" };
}

export const __test = {
  timeoutFromEnv,
  htmlToText,
  providerPayload,
  providerFailureReason,
  recipientDomains,
};
