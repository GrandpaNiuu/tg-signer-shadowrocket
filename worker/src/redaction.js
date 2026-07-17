const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "api_hash",
  "authorization",
  "code",
  "import_blob",
  "login_code",
  "otp",
  "password",
  "phone_code",
  "proxy_password",
  "secret",
  "session",
  "session_string",
  "telegram_session",
  "tg_signer_import",
  "signer_import_base64",
  "token",
  "two_factor_password",
  "verification_code",
]);

function normalizedKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
}

export function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    output[key] = SENSITIVE_KEYS.has(normalized) || normalized.endsWith("_token")
      ? REDACTED
      : redact(child, seen);
  }
  return output;
}

export function sanitizeLogText(value, { maxLines = 200, maxLength = 16_000 } = {}) {
  let text = String(value ?? "").replace(/\r\n?/g, "\n");

  text = text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b((?:https?|socks5h?|socks4|mtproto):\/\/[^\s:/@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /(["']?(?:api[_-]?hash|session(?:[_-]?string)?|telegram[_-]?session|tg[_-]?signer[_-]?import|signer[_-]?import[_-]?base64|import[_-]?blob|proxy[_-]?password|two[_-]?factor[_-]?password|verification[_-]?code|phone[_-]?code|login[_-]?code|password|otp|code|token)["']?\s*[:=]\s*)["']?[^\s,;}"']+["']?/gi,
      `$1${REDACTED}`,
    );

  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = `${lines.slice(0, Math.max(0, maxLines - 1)).join("\n")}\n[TRUNCATED]`;
  }
  if (text.length > maxLength) {
    const marker = "[TRUNCATED]";
    text = maxLength <= marker.length
      ? marker.slice(0, maxLength)
      : `${text.slice(0, maxLength - marker.length)}${marker}`;
  }
  return text;
}

export function sanitizedError(value, maxLength = 2_000) {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
  return sanitizeLogText(text, { maxLines: 20, maxLength });
}
