const DEFAULT_ADMIN_URL = "https://grandpaniu.ccwu.cc";

function boolean(value) {
  return value === true;
}

export function validateAuthSnapshot(payload, { requireEmailRegistration = false } = {}) {
  const data = payload?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Auth configuration response is missing data.");
  }

  const snapshot = {
    github_enabled: boolean(data.github_enabled),
    email_enabled: boolean(data.email_enabled),
    registration_enabled: boolean(data.registration_enabled),
    email_verification_required: boolean(data.email_verification_required),
    password_reset_enabled: boolean(data.password_reset_enabled),
    security_setup_required: boolean(data.security_setup_required),
    turnstile_configured: typeof data.turnstile_site_key === "string" && data.turnstile_site_key.length > 0,
  };

  if (!snapshot.github_enabled && !snapshot.email_enabled) {
    throw new Error("No public authentication provider is enabled.");
  }
  if (snapshot.registration_enabled) {
    if (!snapshot.email_enabled
      || !snapshot.email_verification_required
      || !snapshot.password_reset_enabled
      || !snapshot.turnstile_configured) {
      throw new Error("Email registration is open without the complete verified-registration contract.");
    }
    if (snapshot.security_setup_required) {
      throw new Error("Registration cannot be both enabled and awaiting security setup.");
    }
  }
  if (requireEmailRegistration && !snapshot.registration_enabled) {
    throw new Error("Email registration is required but remains closed.");
  }
  return snapshot;
}

async function requestJson(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      accept: "application/json",
      "user-agent": "telegram-checkin-live-auth-audit/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return { finalUrl: response.url, payload: JSON.parse(text) };
  } catch {
    throw new Error(`${url} returned invalid JSON.`);
  }
}

async function requestPage(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: { "user-agent": "telegram-checkin-live-auth-audit/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error(`${url} did not return HTML.`);
  }
  return response.url;
}

export async function runLiveAuthAudit({
  adminUrl = DEFAULT_ADMIN_URL,
  requireEmailRegistration = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = new URL(adminUrl).origin;
  const finalPageUrl = await requestPage(`${origin}/`, fetchImpl);
  const { finalUrl: finalConfigUrl, payload } = await requestJson(`${origin}/api/auth/config`, fetchImpl);
  const snapshot = validateAuthSnapshot(payload, { requireEmailRegistration });
  return {
    requested_origin: origin,
    final_page_url: finalPageUrl,
    final_config_url: finalConfigUrl,
    ...snapshot,
  };
}

async function main() {
  const requireEmailRegistration = String(process.env.REQUIRE_EMAIL_REGISTRATION || "").toLowerCase() === "true";
  const result = await runLiveAuthAudit({
    adminUrl: process.env.ADMIN_URL || DEFAULT_ADMIN_URL,
    requireEmailRegistration,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.registration_enabled) {
    console.log("::warning title=Email registration closed::GitHub registration remains available, but verified email registration is not configured in production.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Live authentication audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
