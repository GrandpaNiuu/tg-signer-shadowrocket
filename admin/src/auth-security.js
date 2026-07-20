const authContent = document.querySelector("#auth-content");
let authConfiguration = null;
let applying = false;

const TURNSTILE_ACTIONS = Object.freeze({
  login: "email_login",
  register: "email_register",
  "forgot-password": "forgot_password",
  "reset-password": "reset_password",
});

function authMode() {
  return String(location.hash || "#/login").replace(/^#\/?/, "").split("?", 1)[0] || "login";
}

function turnstileAction() {
  return TURNSTILE_ACTIONS[authMode()] || "email_login";
}

function wrapTurnstileRender() {
  const turnstile = globalThis.turnstile;
  if (!turnstile?.render || turnstile.render.__authContextWrapped) return Boolean(turnstile?.render);
  try {
    const originalRender = turnstile.render.bind(turnstile);
    const wrappedRender = (container, options = {}) => originalRender(container, {
      ...options,
      action: turnstileAction(),
    });
    Object.defineProperty(wrappedRender, "__authContextWrapped", { value: true });
    turnstile.render = wrappedRender;
    return true;
  } catch {
    return false;
  }
}

function watchTurnstileLoader() {
  if (wrapTurnstileRender()) return;
  const head = document.head;
  if (!head) return;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLScriptElement)
          || !node.src.startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) continue;
        node.addEventListener("load", () => {
          wrapTurnstileRender();
          observer.disconnect();
        }, { once: true });
      }
    }
  });
  observer.observe(head, { childList: true });
  window.addEventListener("load", () => {
    if (wrapTurnstileRender()) observer.disconnect();
  }, { once: true });
}

function securityNotice(kind, text, key) {
  const notice = document.createElement("div");
  notice.className = `notice ${kind}`;
  notice.dataset.authSecurityNotice = key;
  notice.innerHTML = `<span aria-hidden="true">${kind === "warning" ? "!" : "✓"}</span><span>${text}</span>`;
  return notice;
}

function appendNoticeOnce(form, key, kind, text) {
  if (!form || form.querySelector(`[data-auth-security-notice="${key}"]`)) return;
  form.append(securityNotice(kind, text, key));
}

function applyAuthenticationState() {
  if (applying || !authConfiguration || !authContent) return;
  applying = true;
  try {
    const mode = authMode();
    const registerTab = authContent.querySelector('[data-auth-mode="register"]');
    if (registerTab && !authConfiguration.registration_enabled) {
      registerTab.title = "邮箱注册将在邮件验证和人机验证配置完成后开放";
      registerTab.setAttribute("aria-description", "邮箱注册暂时关闭");
    }

    if (mode === "register" && authConfiguration.email_enabled && !authConfiguration.registration_enabled) {
      const form = authContent.querySelector("#email-register-form");
      if (form) {
        const notice = securityNotice(
          "warning",
          "邮箱新注册暂时关闭。平台管理员完成邮件验证和人机验证配置后才会开放；目前可以使用 GitHub 注册，已有邮箱用户仍可返回登录。",
          "registration-closed",
        );
        const back = document.createElement("button");
        back.className = "auth-link";
        back.type = "button";
        back.dataset.authMode = "login";
        back.textContent = "返回邮箱登录";
        form.replaceWith(notice, back);
      }
      return;
    }

    if (mode === "login" && authConfiguration.security_setup_required) {
      appendNoticeOnce(
        authContent.querySelector("#email-login-form"),
        "security-setup",
        "warning",
        "已有邮箱账号可以继续登录；为防止未验证账号和机器人注册，新的邮箱注册已暂时关闭。",
      );
      return;
    }

    if (["login", "register"].includes(mode)
      && authConfiguration.registration_enabled
      && authConfiguration.email_verification_required
      && authConfiguration.turnstile_site_key) {
      appendNoticeOnce(
        authContent.querySelector(mode === "register" ? "#email-register-form" : "#email-login-form"),
        "secure-email-ready",
        "success",
        "邮箱注册需要人机验证和邮件确认；验证完成后可以使用找回密码功能。",
      );
    }
  } finally {
    applying = false;
  }
}

async function loadAuthenticationConfiguration() {
  try {
    const response = await fetch("/api/auth/config", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const payload = response.ok ? await response.json() : null;
    authConfiguration = payload?.data || null;
    applyAuthenticationState();
  } catch {
    // The main application already renders connection errors.
  }
}

watchTurnstileLoader();

if (authContent) {
  new MutationObserver(applyAuthenticationState).observe(authContent, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => queueMicrotask(applyAuthenticationState));
  loadAuthenticationConfiguration();
}
