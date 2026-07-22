export const TURNSTILE_ACTIONS = Object.freeze({
  login: "email_login",
  register: "email_register",
  "forgot-password": "forgot_password",
  "reset-password": "reset_password",
});

export function turnstileActionForMode(mode) {
  return TURNSTILE_ACTIONS[mode] || TURNSTILE_ACTIONS.login;
}

export function githubButtonLabel(mode) {
  return mode === "register" ? "使用 GitHub 注册" : "使用 GitHub 登录";
}

export function registrationPresentation(config = {}) {
  const githubEnabled = config.github_enabled === true;
  const emailEnabled = config.email_enabled === true;
  const emailRegistrationEnabled = emailEnabled && config.registration_enabled === true;
  const secureEmailReady = emailRegistrationEnabled
    && config.email_verification_required === true
    && config.password_reset_enabled === true
    && typeof config.turnstile_site_key === "string"
    && config.turnstile_site_key.length > 0;

  if (secureEmailReady) {
    return {
      state: "open",
      showEmailDivider: githubEnabled,
      title: "邮箱注册已开放",
      message: "邮箱注册需要完成人机验证和邮件确认，并输入邮件中的 6 位验证码；验证后可以使用找回密码。",
    };
  }

  if (githubEnabled) {
    return {
      state: "github-only",
      showEmailDivider: false,
      title: "GitHub 注册已开放",
      message: emailEnabled
        ? "邮箱新注册尚未开放；已有邮箱账号仍可返回登录。"
        : "当前使用 GitHub 创建账号；邮箱注册尚未启用。",
    };
  }

  return {
    state: "closed",
    showEmailDivider: false,
    title: "当前无法创建账号",
    message: "平台管理员尚未配置可用的公开注册方式。",
  };
}

export function loginSecurityMessage(config = {}) {
  if (config.email_enabled !== true) return null;
  if (config.security_setup_required === true) {
    return "已有邮箱账号可以继续登录；邮箱新注册和自助找回密码尚未完成安全配置。";
  }
  if (config.registration_enabled === true
    && config.email_verification_required === true
    && config.password_reset_enabled === true) {
    return "邮箱新注册需要人机验证和 6 位邮件验证码，并支持自助找回密码。";
  }
  return null;
}
