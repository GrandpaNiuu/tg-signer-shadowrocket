import {
  githubButtonLabel,
  loginSecurityMessage,
  registrationPresentation,
  turnstileActionForMode,
} from "./auth-presentation.js";

const authGate = document.querySelector("#auth-gate");
const authContent = document.querySelector("#auth-content");
const authMessage = document.querySelector("#auth-message");
let authConfiguration = null;
let observer = null;
let applyScheduled = false;
let emailLoginInFlight = false;

function authMode() {
  return String(location.hash || "#/login").replace(/^#\/?/, "").split("?", 1)[0] || "login";
}

function turnstileAction() {
  return turnstileActionForMode(authMode());
}

function turnstileContainer(value) {
  if (value instanceof Element) return value;
  if (typeof value === "string") return document.querySelector(value);
  return null;
}

function wrapTurnstileRender() {
  const turnstile = globalThis.turnstile;
  if (!turnstile?.render || turnstile.render.__authContextWrapped) return Boolean(turnstile?.render);
  try {
    const originalRender = turnstile.render.bind(turnstile);
    const wrappedRender = (container, options = {}) => {
      const widgetId = originalRender(container, {
        ...options,
        action: turnstileAction(),
      });
      const element = turnstileContainer(container);
      if (element && widgetId !== undefined && widgetId !== null) {
        element.dataset.turnstileWidgetId = String(widgetId);
      }
      return widgetId;
    };
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

function loginRequestError(payload, response) {
  const error = payload?.error || {};
  const requestId = String(error.request_id || response.headers.get("x-request-id") || "").trim();
  const message = String(error.message || "登录未完成，请稍后重试。");
  return requestId ? `${message}（请求 ${requestId.slice(0, 8)}）` : message;
}

function setLoginMessage(message) {
  if (authMessage) authMessage.textContent = message;
}

function clearLoginSecrets(form) {
  const password = form?.querySelector('input[name="password"]');
  const token = form?.querySelector('input[name="turnstile_token"]');
  if (password) password.value = "";
  if (token) token.value = "";
}

function resetLoginTurnstile(form) {
  const token = form?.querySelector('input[name="turnstile_token"]');
  if (token) token.value = "";
  const container = form?.querySelector("[data-turnstile]");
  const turnstile = globalThis.turnstile;
  if (!container || !turnstile?.reset) return;
  const widgetId = container.dataset.turnstileWidgetId;
  try {
    turnstile.reset(widgetId || container);
  } catch {
    try { turnstile.reset(container); } catch { /* A page refresh remains available. */ }
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function confirmedEmailSession() {
  for (const delay of [0, 150, 450]) {
    if (delay) await wait(delay);
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const identity = payload?.data ?? payload;
      if (identity?.authenticated) return true;
    } catch {
      // Retry briefly because the login response and the identity check may cross different edge isolates.
    }
  }
  return false;
}

async function submitEmailLogin(form) {
  if (emailLoginInFlight) return;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const data = new FormData(form);
  const email = String(data.get("email") || "").trim();
  const password = String(data.get("password") || "");
  const turnstileToken = String(data.get("turnstile_token") || "");
  const tokenField = form.querySelector('input[name="turnstile_token"]');
  if (tokenField && !turnstileToken) {
    setLoginMessage("请先完成人机验证，再提交邮箱和密码。");
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  const originalLabel = button?.textContent || "邮箱登录";
  emailLoginInFlight = true;
  if (button) {
    button.disabled = true;
    button.textContent = "正在登录…";
  }
  setLoginMessage("正在验证账号并建立安全登录会话，请稍候。");

  try {
    const response = await fetch("/api/auth/email/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-requested-with": "tg-checkin-admin",
      },
      body: JSON.stringify({ email, password, turnstile_token: turnstileToken }),
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) throw new Error(loginRequestError(payload, response));

    const authenticated = await confirmedEmailSession();
    if (!authenticated) {
      const protocolAdvice = location.protocol === "https:"
        ? "请确认浏览器允许本站 Cookie，然后重新验证。"
        : "邮箱登录会话要求通过 HTTPS 保存，请使用正式 HTTPS 地址访问后台。";
      throw new Error(`账号密码已通过验证，但浏览器没有建立登录会话。${protocolAdvice}`);
    }

    clearLoginSecrets(form);
    location.replace("/#/dashboard");
  } catch (error) {
    const message = error instanceof Error ? error.message : "登录未完成，请稍后重试。";
    setLoginMessage(`${message} 密码已保留，只需重新完成人机验证后再次提交。`);
    resetLoginTurnstile(form);
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
    form.querySelector('input[name="password"]')?.focus();
  } finally {
    emailLoginInFlight = false;
  }
}

function interceptEmailLogin(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== "email-login-form") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  submitEmailLogin(form);
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
  window.addEventListener("hashchange", () => {
    if (authMode() !== "login") clearLoginSecrets(authContent.querySelector("#email-login-form"));
    scheduleAuthenticationState();
  });
  window.addEventListener("pagehide", () => clearLoginSecrets(authContent.querySelector("#email-login-form")));
  loadAuthenticationConfiguration();
}

if (authGate) {
  authGate.addEventListener("submit", interceptEmailLogin, { capture: true });
}
