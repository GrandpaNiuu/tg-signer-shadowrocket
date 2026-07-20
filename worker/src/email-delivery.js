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
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, ...message }),
      signal: controller.signal,
    });
  } catch {
    response = null;
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    throw new HttpError(502, "email_delivery_failed", "验证邮件暂时无法发送，请稍后重试。");
  }
  return response;
}

export const __test = { timeoutFromEnv };
