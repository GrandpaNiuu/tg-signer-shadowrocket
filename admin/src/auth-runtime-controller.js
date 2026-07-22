import { turnstileActionForMode } from "./auth-presentation.js";

const documentRef = globalThis.document;
const authMessage = documentRef?.querySelector("#auth-message") || null;
let submissionInFlight = false;

function authMode() {
  return String(globalThis.location?.hash || "#/login").replace(/^#\/?/, "").split("?", 1)[0] || "login";
}

function turnstileContainer(value) {
  if (typeof Element !== "undefined" && value instanceof Element) return value;
  if (typeof value === "string") return documentRef?.querySelector(value) || null;
  return null;
}

function installTurnstileActionWrapper() {
  const turnstile = globalThis.turnstile;
  if (!turnstile?.render || turnstile.render.__authContextWrapped) return Boolean(turnstile?.render);
  const originalRender = turnstile.render.bind(turnstile);
  const wrappedRender = (container, options = {}) => {
    const widgetId = originalRender(container, {
      ...options,
      action: options.action || turnstileActionForMode(authMode()),
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
}

function watchTurnstile() {
  if (installTurnstileActionWrapper()) return;
  const head = documentRef?.head;
  if (!head) return;

  const attach = (script) => {
    if (!(script instanceof HTMLScriptElement)
      || !script.src.startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) return;
    script.addEventListener("load", installTurnstileActionWrapper, { once: true });
  };

  [...(documentRef.scripts || [])].forEach(attach);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) attach(node);
    }
    if (installTurnstileActionWrapper()) observer.disconnect();
  });
  observer.observe(head, { childList: true });

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (installTurnstileActionWrapper() || attempts >= 200) {
      clearInterval(timer);
      observer.disconnect();
    }
  }, 50);
}

function setMessage(message) {
  if (authMessage) authMessage.textContent = message;
}

function parseError(payload, response) {
  const error = payload?.error || {};
  const requestId = String(error.request_id || response?.headers?.get?.("x-request-id") || "").trim();
  const result = new Error(String(error.message || "请求未完成，请稍后重试。"));
  result.code = String(error.code || "request_failed");
  result.status = Number(response?.status || 0);
  result.requestId = requestId;
  return result;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-requested-with": "tg-checkin-admin",
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw parseError(payload, response);
  return payload?.data ?? payload ?? null;
}

function resetTurnstile(form) {
  const token = form?.querySelector('input[name="turnstile_token"]');
  if (token) token.value = "";
  const container = form?.querySelector("[data-turnstile]");
  const widgetId = container?.dataset?.turnstileWidgetId;
  try {
    if (widgetId !== undefined && widgetId !== "") globalThis.turnstile?.reset?.(widgetId);
    else if (container) globalThis.turnstile?.reset?.(container);
    else globalThis.turnstile?.reset?.();
  } catch {
    try { globalThis.turnstile?.reset?.(); } catch { /* Refresh remains available. */ }
  }
}

function requireTurnstile(form, token) {
  if (!form.querySelector('input[name="turnstile_token"]')) return true;
  if (token) return true;
  setMessage("请先完成人机验证，再提交。若验证框已显示通过，请刷新页面后重新验证一次。");
  return false;
}

function setButton(button, disabled, text) {
  if (!button?.isConnected) return;
  button.disabled = disabled;
  button.textContent = text;
}

function formattedError(error) {
  const message = error instanceof Error ? error.message : "请求未完成，请稍后重试。";
  return error?.requestId ? `${message}（请求 ${String(error.requestId).slice(0, 8)}）` : message;
}

async function sessionEstablished() {
  for (const delay of [0, 150, 450]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
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
      // Brief retries cover propagation between edge isolates.
    }
  }
  return false;
}

function verificationRoute(email) {
  globalThis.location.hash = `/register?verification_email=${encodeURIComponent(email)}`;
}

function openAuthenticatedDashboard() {
  // Hash-only navigation keeps the current document alive. The legacy hashchange
  // listener then sees the hidden app shell and renders the login page again.
  // Replace the route and reload so bootstrap reads the new session cookie and
  // switches the shell into its authenticated state exactly once.
  globalThis.history.replaceState(null, "", "/#/dashboard");
  globalThis.location.reload();
}

async function handleLogin(form) {
  if (submissionInFlight) return;
  if (!form.checkValidity()) return form.reportValidity();
  const data = new FormData(form);
  const email = String(data.get("email") || "").trim();
  const password = String(data.get("password") || "");
  const turnstileToken = String(data.get("turnstile_token") || "");
  if (!requireTurnstile(form, turnstileToken)) return;

  const button = form.querySelector('button[type="submit"]');
  submissionInFlight = true;
  setButton(button, true, "正在登录…");
  setMessage("正在验证账号、人机验证和登录会话，请稍候。");
  try {
    await post("/api/auth/email/login", {
      email,
      password,
      turnstile_token: turnstileToken,
    });
    if (!await sessionEstablished()) {
      const advice = location.protocol === "https:"
        ? "请确认浏览器允许本站 Cookie。"
        : "邮箱登录会话只能通过 HTTPS 保存，请使用正式 HTTPS 地址。";
      throw new Error(`账号验证成功，但登录会话未建立。${advice}`);
    }
    const passwordInput = form.querySelector('input[name="password"]');
    if (passwordInput) passwordInput.value = "";
    setMessage("登录成功，正在打开后台…");
    openAuthenticatedDashboard();
  } catch (error) {
    if (error?.code === "email_verification_required") {
      verificationRoute(email);
      return;
    }
    setMessage(`${formattedError(error)} 密码已保留，只需重新完成人机验证。`);
    resetTurnstile(form);
    setButton(button, false, "邮箱登录");
    form.querySelector('input[name="password"]')?.focus();
  } finally {
    submissionInFlight = false;
  }
}

async function handleRegistration(form) {
  if (submissionInFlight) return;
  if (!form.checkValidity()) return form.reportValidity();
  const data = new FormData(form);
  const password = String(data.get("password") || "");
  const confirmation = String(data.get("password_confirm") || "");
  if (!confirmation || password !== confirmation) {
    setMessage("两次输入的密码不一致，请检查后重新提交。");
    form.querySelector('input[name="password_confirm"]')?.focus();
    return;
  }

  const email = String(data.get("email") || "").trim();
  const turnstileToken = String(data.get("turnstile_token") || "");
  if (!requireTurnstile(form, turnstileToken)) return;

  const button = form.querySelector('button[type="submit"]');
  submissionInFlight = true;
  setButton(button, true, "正在创建账号…");
  setMessage("正在验证注册信息和人机验证，请稍候。");
  try {
    const result = await post("/api/auth/email/register", {
      display_name: String(data.get("display_name") || "").trim(),
      email,
      password,
      turnstile_token: turnstileToken,
    });
    if (result?.status === "verification_required") {
      verificationRoute(email);
      return;
    }
    if (await sessionEstablished()) {
      for (const name of ["password", "password_confirm"]) {
        const input = form.querySelector(`input[name="${name}"]`);
        if (input) input.value = "";
      }
      setMessage("账号创建成功，正在打开后台…");
      openAuthenticatedDashboard();
      return;
    }
    throw new Error("账号已创建，但登录会话未建立。请使用 HTTPS 并允许本站 Cookie。");
  } catch (error) {
    setMessage(`${formattedError(error)} 已填写的注册资料和密码已保留，只需重新完成人机验证。`);
    resetTurnstile(form);
    setButton(button, false, "创建账号");
  } finally {
    submissionInFlight = false;
  }
}

function interceptAuthSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id !== "email-login-form" && form.id !== "email-register-form") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (form.id === "email-login-form") handleLogin(form);
  else handleRegistration(form);
}

watchTurnstile();
documentRef?.addEventListener("submit", interceptAuthSubmit, true);

export const __test = {
  authMode,
  installTurnstileActionWrapper,
  openAuthenticatedDashboard,
};
