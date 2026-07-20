import {
  githubButtonLabel,
  loginSecurityMessage,
  registrationPresentation,
  turnstileActionForMode,
} from "./auth-presentation.js";

const authContent = document.querySelector("#auth-content");
const authMessage = document.querySelector("#auth-message");
let authConfiguration = null;
let observer = null;
let applyScheduled = false;

function authMode() {
  return String(location.hash || "#/login").replace(/^#\/?/, "").split("?", 1)[0] || "login";
}

function turnstileAction() {
  return turnstileActionForMode(authMode());
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
  const scriptObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLScriptElement)
          || !node.src.startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) continue;
        node.addEventListener("load", () => {
          wrapTurnstileRender();
          scriptObserver.disconnect();
        }, { once: true });
      }
    }
  });
  scriptObserver.observe(head, { childList: true });
  window.addEventListener("load", () => {
    if (wrapTurnstileRender()) scriptObserver.disconnect();
  }, { once: true });
}

function securityNotice(kind, title, text, key) {
  const notice = document.createElement("div");
  notice.className = `notice ${kind}`;
  notice.dataset.authSecurityNotice = key;
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = kind === "warning" ? "!" : "✓";
  const content = document.createElement("span");
  const heading = document.createElement("strong");
  heading.textContent = title;
  content.append(heading, document.createElement("br"), document.createTextNode(text));
  notice.append(icon, content);
  return notice;
}

function appendNoticeOnce(form, key, kind, title, text) {
  if (!form || form.querySelector(`[data-auth-security-notice="${key}"]`)) return;
  form.append(securityNotice(kind, title, text, key));
}

function registrationReplacementTarget() {
  return authContent?.querySelector("#email-register-form")
    || [...(authContent?.querySelectorAll(".notice.warning") || [])]
      .find((notice) => !notice.dataset.authSecurityNotice)
    || null;
}

function applyRegistrationState() {
  const presentation = registrationPresentation(authConfiguration);
  const divider = authContent.querySelector(".auth-divider");
  if (!presentation.showEmailDivider) divider?.remove();

  if (presentation.state === "open") {
    appendNoticeOnce(
      authContent.querySelector("#email-register-form"),
      "secure-email-ready",
      "success",
      presentation.title,
      presentation.message,
    );
    return;
  }

  if (authContent.querySelector("[data-auth-registration-summary]")) return;
  const target = registrationReplacementTarget();
  if (!target) return;

  const summary = document.createElement("div");
  summary.dataset.authRegistrationSummary = presentation.state;
  const primary = securityNotice(
    presentation.state === "github-only" ? "success" : "warning",
    presentation.title,
    presentation.message,
    "registration-primary",
  );
  summary.append(primary);

  if (presentation.state === "github-only" && authConfiguration.email_enabled) {
    summary.append(securityNotice(
      "warning",
      "邮箱注册尚未开放",
      "管理员需要完成邮箱验证、发件服务和人机验证配置后才能开放。",
      "registration-email-closed",
    ));
  }

  const back = document.createElement("button");
  back.className = "auth-link";
  back.type = "button";
  back.dataset.authMode = "login";
  back.textContent = "已有邮箱账号？返回登录";
  summary.append(back);
  target.replaceWith(summary);

  if (authMessage) {
    authMessage.textContent = presentation.state === "github-only"
      ? "使用 GitHub 创建独立工作区；邮箱新注册暂未开放。"
      : "当前没有可用的公开注册方式。";
  }
}

function observeAuthenticationContent() {
  if (!observer || !authContent) return;
  observer.observe(authContent, { childList: true });
}

function applyAuthenticationState() {
  if (!authConfiguration || !authContent) return;
  observer?.disconnect();
  try {
    const mode = authMode();
    const githubButton = authContent.querySelector(".github-button");
    if (githubButton) githubButton.textContent = githubButtonLabel(mode);

    const registerTab = authContent.querySelector('[data-auth-mode="register"]');
    if (registerTab && !authConfiguration.registration_enabled) {
      registerTab.title = authConfiguration.github_enabled
        ? "GitHub 注册可用；邮箱注册暂未开放"
        : "公开注册暂未开放";
      registerTab.setAttribute("aria-description", registerTab.title);
    }

    if (mode === "register") {
      applyRegistrationState();
      return;
    }

    if (mode === "login") {
      const message = loginSecurityMessage(authConfiguration);
      if (message) {
        const secure = authConfiguration.registration_enabled === true;
        appendNoticeOnce(
          authContent.querySelector("#email-login-form"),
          secure ? "secure-email-ready" : "security-setup",
          secure ? "success" : "warning",
          secure ? "邮箱安全注册已启用" : "邮箱注册尚未开放",
          message,
        );
      }
    }
  } finally {
    observeAuthenticationContent();
  }
}

function scheduleAuthenticationState() {
  if (applyScheduled) return;
  applyScheduled = true;
  queueMicrotask(() => {
    applyScheduled = false;
    applyAuthenticationState();
  });
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
    scheduleAuthenticationState();
  } catch {
    // The main application already renders connection errors.
  }
}

watchTurnstileLoader();

if (authContent) {
  observer = new MutationObserver(scheduleAuthenticationState);
  observeAuthenticationContent();
  window.addEventListener("hashchange", scheduleAuthenticationState);
  loadAuthenticationConfiguration();
}
