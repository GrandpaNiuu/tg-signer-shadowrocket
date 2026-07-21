const DEFAULT_ADMIN_URL = "https://grandpaniu.ccwu.cc";

async function responsePayload(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${response.url || "request"} returned invalid JSON.`);
  }
}

async function request(origin, path, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${origin}${path}`, {
    redirect: "follow",
    headers: {
      accept: "application/json",
      "user-agent": "telegram-checkin-live-profile-audit/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: response.status,
    url: response.url || `${origin}${path}`,
    payload: await responsePayload(response),
  };
}

export function validatePublicBranding(result) {
  if (result.status !== 200 || !result.payload?.data || typeof result.payload.data !== "object") {
    throw new Error(`Public branding route is unavailable (HTTP ${result.status}).`);
  }
  const avatar = result.payload.data.avatar_data_url;
  if (avatar !== null && typeof avatar !== "string") {
    throw new Error("Public branding payload has an invalid avatar_data_url value.");
  }
  return "ok";
}

export function validateProtectedProfile(result) {
  const code = result.payload?.error?.code;
  if (result.status === 401 && code === "authentication_required") return "protected";
  if (result.status === 404) {
    throw new Error("Profile route is missing from the deployed Worker (HTTP 404).");
  }
  if (result.status >= 500) {
    throw new Error(`Profile route reached the Worker but failed (HTTP ${result.status}, code ${code || "unknown"}).`);
  }
  throw new Error(`Profile route returned an unexpected response (HTTP ${result.status}, code ${code || "unknown"}).`);
}

export async function runLiveProfileAudit({
  adminUrl = DEFAULT_ADMIN_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = new URL(adminUrl).origin;
  const authConfig = await request(origin, "/api/auth/config", fetchImpl);
  if (authConfig.status !== 200 || !authConfig.payload?.data) {
    throw new Error(`Admin service binding is unavailable (HTTP ${authConfig.status}).`);
  }
  const branding = await request(origin, "/api/branding", fetchImpl);
  const profile = await request(origin, "/api/v1/profile", fetchImpl);
  return {
    admin_origin: origin,
    service_binding: "ok",
    public_branding: validatePublicBranding(branding),
    protected_profile: validateProtectedProfile(profile),
    profile_status: profile.status,
    profile_error_code: profile.payload?.error?.code || null,
  };
}

async function main() {
  const result = await runLiveProfileAudit({ adminUrl: process.env.ADMIN_URL || DEFAULT_ADMIN_URL });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Live profile audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
