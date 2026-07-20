function httpsOrigin(value) {
  try {
    const origin = new URL(String(value || ""));
    return origin.protocol === "https:" ? origin.origin : null;
  } catch {
    return null;
  }
}

export function publicPasswordAuthConfiguration(env) {
  const passwordPepperConfigured = String(env.PASSWORD_PEPPER || "").length >= 16;
  const turnstileSiteKey = String(env.TURNSTILE_SITE_KEY || "").trim();
  const turnstileSecretKey = String(env.TURNSTILE_SECRET_KEY || "").trim();
  const turnstileEnabled = Boolean(turnstileSiteKey && turnstileSecretKey);
  const resendApiKey = String(env.RESEND_API_KEY || "").trim();
  const emailFrom = String(env.AUTH_EMAIL_FROM || "").trim();
  const origin = httpsOrigin(env.ADMIN_ORIGIN);
  const emailDeliveryEnabled = Boolean(resendApiKey && emailFrom && origin);
  const verifiedRegistrationEnabled = passwordPepperConfigured && turnstileEnabled && emailDeliveryEnabled;
  const localModeRequested = String(env.PUBLIC_PASSWORD_AUTH_MODE || "").trim().toLowerCase() === "local";

  // Local mode is an explicit development-only compatibility switch. Production
  // uses secure mode and fails new registration closed until mail + Turnstile are ready.
  // Keeping this decision in one function also makes post-deployment auth smoke
  // checks evaluate the exact same contract that the public login page receives.
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
    origin,
  };
}
