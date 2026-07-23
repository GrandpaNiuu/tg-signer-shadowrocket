const EMAIL_ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function httpsOrigin(value) {
  try {
    const origin = new URL(String(value || ""));
    return origin.protocol === "https:" ? origin.origin : null;
  } catch {
    return null;
  }
}

function senderAddress(value) {
  const source = String(value || "").trim();
  const bracketed = source.match(/<([^<>]+)>$/);
  const address = String(bracketed?.[1] || source).trim().toLowerCase();
  return EMAIL_ADDRESS_PATTERN.test(address) ? address : null;
}

function productionSenderDomain(value) {
  const address = senderAddress(value);
  if (!address) return null;
  const domain = address.split("@").at(-1);
  if (!domain || domain === "resend.dev" || domain.endsWith(".resend.dev")) return null;
  return domain;
}

export function publicPasswordAuthConfiguration(env) {
  const passwordPepperConfigured = String(env.PASSWORD_PEPPER || "").length >= 16;
  const turnstileSiteKey = String(env.TURNSTILE_SITE_KEY || "").trim();
  const turnstileSecretKey = String(env.TURNSTILE_SECRET_KEY || "").trim();
  const turnstileEnabled = Boolean(turnstileSiteKey && turnstileSecretKey);
  const resendApiKey = String(env.RESEND_API_KEY || "").trim();
  const emailFrom = String(env.AUTH_EMAIL_FROM || "").trim();
  const senderDomain = productionSenderDomain(emailFrom);
  const origin = httpsOrigin(env.ADMIN_ORIGIN);
  const emailDeliveryEnabled = Boolean(resendApiKey && senderDomain && origin);
  const verifiedRegistrationEnabled = passwordPepperConfigured && turnstileEnabled && emailDeliveryEnabled;
  const localModeRequested = String(env.PUBLIC_PASSWORD_AUTH_MODE || "").trim().toLowerCase() === "local";

  // Local mode is an explicit development-only compatibility switch. Production
  // uses secure mode and fails new registration closed until mail + Turnstile are ready.
  // Resend's resend.dev sender is intentionally rejected for public registration:
  // it is a testing sender and cannot deliver to arbitrary users.
  const enabled = passwordPepperConfigured;
  const localMode = enabled && localModeRequested;
  const registrationEnabled = localMode || verifiedRegistrationEnabled;

  return {
    enabled,
    localMode,
    registrationEnabled,
    emailVerificationRequired: verifiedRegistrationEnabled && !localMode,
    passwordResetEnabled: verifiedRegistrationEnabled && !localMode,
    securitySetupRequired: enabled && !localMode && !verifiedRegistrationEnabled ? true : undefined,
    turnstileEnabled: enabled && turnstileEnabled,
    turnstileSiteKey: enabled && turnstileEnabled ? turnstileSiteKey : null,
    turnstileSecretKey: enabled && turnstileEnabled ? turnstileSecretKey : null,
    resendApiKey: enabled && emailDeliveryEnabled ? resendApiKey : null,
    emailFrom: enabled && emailDeliveryEnabled ? emailFrom : null,
    senderDomain: enabled && emailDeliveryEnabled ? senderDomain : null,
    origin,
  };
}

export const __test = { httpsOrigin, senderAddress, productionSenderDomain };
