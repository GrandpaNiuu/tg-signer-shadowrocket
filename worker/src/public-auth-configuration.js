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
  const localMode = String(env.PUBLIC_PASSWORD_AUTH_MODE || "").trim().toLowerCase() === "local";
  const fullEmailMode = passwordPepperConfigured && turnstileEnabled && emailDeliveryEnabled;
  const enabled = passwordPepperConfigured && (localMode || fullEmailMode);

  return {
    enabled,
    localMode: enabled && localMode,
    emailVerificationRequired: enabled && !localMode,
    passwordResetEnabled: enabled && !localMode && emailDeliveryEnabled,
    turnstileEnabled: enabled && turnstileEnabled,
    turnstileSiteKey: enabled && turnstileEnabled ? turnstileSiteKey : null,
    turnstileSecretKey: enabled && turnstileEnabled ? turnstileSecretKey : null,
    resendApiKey: enabled && emailDeliveryEnabled ? resendApiKey : null,
    emailFrom: enabled && emailDeliveryEnabled ? emailFrom : null,
    origin,
  };
}

