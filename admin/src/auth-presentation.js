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
      message: "注册后可绑定自己的 Telegram 账号，并独立管理定时消息、机器人操作和执行记录。注册需要人机验证和 6 位邮件验证码。",
    };
  }

  if (githubEnabled) {
    return {
      state: "github-only",
      showEmailDivider: false,
      title: "GitHub 注册已开放",
      message: emailEnabled
        ? "邮箱新注册暂未开放；已有邮箱账号可以返回登录，或使用 GitHub 创建账号。"
        : "当前可使用 GitHub 创建账号；邮箱注册暂未启用。",
    };
  }

  return {
    state: "closed",
    showEmailDivider: false,
    title: "当前无法创建账号",
    message: "当前暂时无法创建新账号，请稍后再试或联系平台管理员。",
  };
}

export function loginSecurityMessage(config = {}) {
  if (config.email_enabled !== true) return null;
  if (config.security_setup_required === true) {
    return "已有邮箱账号可以继续登录；邮箱新注册和密码找回暂未开放。";
  }
  if (config.registration_enabled === true
    && config.email_verification_required === true
    && config.password_reset_enabled === true) {
    return "输入注册邮箱和密码，并完成人机验证。连续多次失败后，系统会暂时限制尝试。";
  }
  return null;
}
