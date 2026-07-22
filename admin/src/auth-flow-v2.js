import { turnstileActionForMode } from "./auth-presentation.js";

const documentRef = globalThis.document;
const authContent = documentRef?.querySelector("#auth-content") || null;
const authMessage = documentRef?.querySelector("#auth-message") || null;
const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 6_000;
const RESEND_SECONDS = 60;
const RESEND_ACTION = "resend_verification";
const CODE_PATTERN = /^\d{6}$/;

let submissionInFlight = false;
let observer = null;
let applyScheduled = false;
let authConfigPromise = null;
let turnstileScriptPromise = null;
let verificationWidgetId = null;
let resendInFlight = false;
let resendTimer = null;

function text(value) { return String(value ?? ""); }
function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function routeInfo() {
  const [path, query = ""] = text(globalThis.location?.hash || "#/login")
    .replace(/^#\/?/, "")
    .split("?", 2);
  return { path: path || "login", params: new URLSearchParams(query) };
}

function authMode() { return routeInfo().path; }

function verificationRouteInfo() {
  const { path, params } = routeInfo();
  if (path !== "register") return null;
  const email = params.get("verification_email_v2")?.trim() || "";
  if (!email) return null;
  return { email, sent: params.get("sent") === "1" };
}

function verifiedLoginEmail() {
  const { path, params } = routeInfo();
  return path === "login" ? (params.get("verified_email")?.trim() || "") : "";
}

function setMessage(message) {
  if (authMessage) authMessage.textContent = message;
}

function parseError(payload, response) {
  const source = payload?.error || {};
  const requestId = text(source.request_id || response?.headers?.get?.("x-request-id")).trim();
  const error = new Error(text(source.message || "请求未完成，请稍后重试。"));
  error.code = text(source.code || "request_failed");
  error.status = Number(response?.status || 0);
  error.requestId = requestId;
  return error;
}

function timeoutError() {
  const error = new Error("请求超时，服务器没有及时响应。请稍后重新提交。");
  error.code = "request_timeout";
  return error;
}

async function request(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) throw parseError(payload, response);
    return payload?.data ?? payload ?? null;
  } catch (error) {
    if (error?.name === "AbortError") throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formattedError(error) {
  const message = error instanceof Error ? error.message : "请求未完成，请稍后重试。";
  return error?.requestId ? `${message}（请求 ${text(error.requestId).slice(0, 8)}）` : message;
}

function setButton(button, disabled, label) {
  if (!button?.isConnected) return;
  button.disabled = disabled;
  button.textContent = label;
}

function turnstileContainer(value) {
  if (typeof Element !== "undefined" && value instanceof Element) return value;
  if (typeof value === "string") return documentRef?.querySelector(value) || null;
  return null;
}

function installTurnstileWrapper() {
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
      element.dataset.turnstileWidgetId = text(widgetId);
    }
    return widgetId;
  };
  Object.defineProperty(wrappedRender, "__authContextWrapped", { value: true });
  turnstile.render = wrappedRender;
  return true;
}

function watchTurnstile() {
  if (installTurnstileWrapper()) return;
  const head = documentRef?.head;
  if (!head) return;
  const attach = (script) => {
    if (!(script instanceof HTMLScriptElement)
      || !script.src.startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) return;
    script.addEventListener("load", installTurnstileWrapper, { once: true });
  };
  [...(documentRef.scripts || [])].forEach(attach);
  const scriptObserver = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) attach(node);
    if (installTurnstileWrapper()) scriptObserver.disconnect();
  });
  scriptObserver.observe(head, { childList: true });
}

function loadTurnstileScript() {
  if (globalThis.turnstile?.render) return Promise.resolve(globalThis.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = [...(documentRef?.scripts || [])]
      .find((script) => script.src.startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js"));
    const script = existing || documentRef?.createElement("script");
    if (!script) return reject(new Error("Turnstile loader unavailable"));
    const finish = () => globalThis.turnstile?.render
      ? resolve(globalThis.turnstile)
      : reject(new Error("Turnstile failed to load"));
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile failed to load")), { once: true });
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      documentRef.head?.append(script);
    }
    setTimeout(finish, 10_000);
  });
  return turnstileScriptPromise;
}

async function loadAuthConfig() {
  if (authConfigPromise) return authConfigPromise;
  authConfigPromise = fetch("/api/auth/config", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  }).then(async (response) => response.ok ? ((await response.json())?.data || {}) : {})
    .catch(() => ({}));
  return authConfigPromise;
}

function resetFormTurnstile(form) {
  const field = form?.querySelector('input[name="turnstile_token"]');
  if (field) field.value = "";
  const container = form?.querySelector("[data-turnstile]");
  const widgetId = container?.dataset?.turnstileWidgetId;
  try {
    if (widgetId) globalThis.turnstile?.reset?.(widgetId);
    else if (container) globalThis.turnstile?.reset?.(container);
    else globalThis.turnstile?.reset?.();
  } catch {
    try { globalThis.turnstile?.reset?.(); } catch { /* Page refresh remains available. */ }
  }
}

function requireTurnstile(form, token) {
  if (!form.querySelector('input[name="turnstile_token"]') || token) return true;
  setMessage("请先完成人机验证，再提交。");
  return false;
}

async function sessionEstablished() {
  const started = Date.now();
  while (Date.now() - started < SESSION_TIMEOUT_MS) {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (response.ok) {
        const payload = await response.json();
        const identity = payload?.data ?? payload;
        if (identity?.authenticated) return true;
      }
    } catch { /* Retry briefly. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function openAuthenticatedDashboard(message) {
  // A hash-only location.replace keeps the current document and triggers the
  // legacy hashchange handler, which renders the login gate again while the
  // authenticated application shell is still hidden. Reloading after replacing
  // the route lets bootstrap read the new session cookie and open the dashboard.
  setMessage(message);
  history.replaceState(null, "", "/#/dashboard");
  globalThis.location.reload();
}

function setVerificationRoute(email, { sent = false } = {}) {
  stopResendTimer();
  const query = new URLSearchParams({ verification_email_v2: email });
  if (sent) query.set("sent", "1");
  history.replaceState(null, "", `/#/register?${query.toString()}`);
  renderVerification(email, { sent });
}

function ensurePasswordConfirmation() {
  const form = authContent?.querySelector("#email-register-form");
  if (!form || form.querySelector('input[name="password_confirm"]')) return;
  const password = form.querySelector('input[name="password"]');
  const field = password?.closest(".field");
  if (!field) return;
  const confirmation = documentRef.createElement("div");
  confirmation.className = "field";
  confirmation.innerHTML = '<label class="required" for="auth-register-password-confirm-v2">确认密码</label><input id="auth-register-password-confirm-v2" name="password_confirm" type="password" minlength="12" maxlength="1024" autocomplete="new-password" data-sensitive required>';
  field.insertAdjacentElement("afterend", confirmation);
}

async function handleLogin(form) {
  if (submissionInFlight) return;
  if (!form.checkValidity()) return form.reportValidity();
  const data = new FormData(form);
  const email = text(data.get("email")).trim();
  const password = text(data.get("password"));
  const turnstileToken = text(data.get("turnstile_token"));
  if (!requireTurnstile(form, turnstileToken)) return;

  const button = form.querySelector('button[type="submit"]');
  submissionInFlight = true;
  setButton(button, true, "正在登录…");
  setMessage("正在验证账号，请稍候。最长等待 20 秒。");
  try {
    await request("/api/auth/email/login", { email, password, turnstile_token: turnstileToken });
    if (!await sessionEstablished()) {
      throw new Error("账号验证成功，但登录会话未建立。请确认浏览器允许本站 Cookie。");
    }
    const passwordInput = form.querySelector('input[name="password"]');
    if (passwordInput) passwordInput.value = "";
    openAuthenticatedDashboard("登录成功，正在打开后台…");
  } catch (error) {
    if (error?.code === "email_verification_required") {
      const sent = /已经发送|新的验证码/.test(text(error.message));
      setVerificationRoute(email, { sent });
      return;
    }
    setMessage(`${formattedError(error)} 密码已保留。`);
    resetFormTurnstile(form);
    setButton(button, false, "邮箱登录");
    form.querySelector('input[name="password"]')?.focus();
  } finally {
    submissionInFlight = false;
  }
}

async function handleRegistration(form) {
  if (submissionInFlight) return;
  ensurePasswordConfirmation();
  if (!form.checkValidity()) return form.reportValidity();
  const data = new FormData(form);
  const password = text(data.get("password"));
  const confirmation = text(data.get("password_confirm"));
  if (!confirmation || password !== confirmation) {
    setMessage("两次输入的密码不一致。");
    form.querySelector('input[name="password_confirm"]')?.focus();
    return;
  }
  const email = text(data.get("email")).trim();
  const turnstileToken = text(data.get("turnstile_token"));
  if (!requireTurnstile(form, turnstileToken)) return;

  const button = form.querySelector('button[type="submit"]');
  submissionInFlight = true;
  setButton(button, true, "正在创建账号…");
  setMessage("正在创建账号并发送验证码，请稍候。最长等待 20 秒。");
  try {
    const result = await request("/api/auth/email/register", {
      display_name: text(data.get("display_name")).trim(),
      email,
      password,
      turnstile_token: turnstileToken,
    });
    if (result?.status === "verification_required") {
      setVerificationRoute(email, { sent: true });
      return;
    }
    if (!await sessionEstablished()) throw new Error("账号已创建，但登录会话未建立。");
    for (const name of ["password", "password_confirm"]) {
      const input = form.querySelector(`input[name="${name}"]`);
      if (input) input.value = "";
    }
    openAuthenticatedDashboard("账号创建成功，正在打开后台…");
  } catch (error) {
    setMessage(`${formattedError(error)} 已填写的注册资料和密码已保留。`);
    resetFormTurnstile(form);
    setButton(button, false, "创建账号");
  } finally {
    submissionInFlight = false;
  }
}

function verificationStatus(message, kind = "") {
  const node = authContent?.querySelector("[data-v2-verification-status]");
  if (!node) return;
  node.textContent = message || "";
  node.className = `field-help${kind === "error" ? " field-error" : ""}`;
}

function stopResendTimer() {
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = null;
}

function startResendCooldown(seconds = RESEND_SECONDS) {
  stopResendTimer();
  let remaining = Math.max(0, Number(seconds) || RESEND_SECONDS);
  const button = authContent?.querySelector('[data-v2-auth-action="resend"]');
  if (!button) return;
  const update = () => {
    if (!button.isConnected) return stopResendTimer();
    button.disabled = remaining > 0;
    button.textContent = remaining > 0 ? `${remaining} 秒后可重新获取验证码` : "重新获取验证码";
    if (remaining <= 0) return stopResendTimer();
    remaining -= 1;
  };
  update();
  resendTimer = setInterval(update, 1000);
}

function clearVerificationChallenge() {
  const container = authContent?.querySelector("[data-v2-verification-turnstile]");
  const field = authContent?.querySelector('input[name="resend_turnstile_token"]');
  if (field) field.value = "";
  try {
    if (verificationWidgetId !== null) globalThis.turnstile?.reset?.(verificationWidgetId);
  } catch { /* Ignore stale widgets. */ }
  if (container) container.hidden = true;
}

async function sendVerificationCode(button) {
  if (resendInFlight) return;
  const form = button.closest("form");
  const email = text(form?.querySelector('input[name="email"]')?.value).trim();
  const token = text(form?.querySelector('input[name="resend_turnstile_token"]')?.value).trim();
  if (!email || !token) return;
  resendInFlight = true;
  setButton(button, true, "正在发送…");
  verificationStatus("正在发送验证码，请稍候。");
  try {
    const result = await request("/api/auth/email/resend-code", {
      email,
      turnstile_token: token,
    });
    verificationStatus("新验证码已发送，请检查收件箱、垃圾邮件和推广邮件。");
    clearVerificationChallenge();
    startResendCooldown(Number(result?.resend_after_seconds) || RESEND_SECONDS);
  } catch (error) {
    verificationStatus(formattedError(error), "error");
    const field = form?.querySelector('input[name="resend_turnstile_token"]');
    if (field) field.value = "";
    try { globalThis.turnstile?.reset?.(verificationWidgetId); } catch { /* Retry remains available. */ }
    setButton(button, false, "重新获取验证码");
  } finally {
    resendInFlight = false;
  }
}

async function showVerificationChallenge(button) {
  const container = authContent?.querySelector("[data-v2-verification-turnstile]");
  const field = authContent?.querySelector('input[name="resend_turnstile_token"]');
  if (!container || !field) return;
  container.hidden = false;
  verificationStatus("完成人机验证后会自动发送验证码，无需再次点击。");
  if (verificationWidgetId !== null) {
    try { globalThis.turnstile?.reset?.(verificationWidgetId); } catch { verificationWidgetId = null; }
    return;
  }
  const config = await loadAuthConfig();
  if (!config?.turnstile_site_key) {
    verificationStatus("人机验证配置暂时不可用。", "error");
    return;
  }
  try {
    const turnstile = await loadTurnstileScript();
    verificationWidgetId = turnstile.render(container, {
      sitekey: config.turnstile_site_key,
      theme: "light",
      action: RESEND_ACTION,
      callback: (token) => {
        field.value = token;
        sendVerificationCode(button);
      },
      "expired-callback": () => { field.value = ""; },
      "error-callback": () => {
        field.value = "";
        verificationStatus("人机验证加载失败，请重新尝试。", "error");
      },
    });
  } catch {
    verificationStatus("人机验证暂时无法加载，请刷新页面后重试。", "error");
  }
}

function renderVerification(email, { sent = false } = {}) {
  if (!authContent || !email) return;
  observer?.disconnect();
  stopResendTimer();
  verificationWidgetId = null;
  try {
    setMessage(sent
      ? "验证码已经发送。请输入邮件中的 6 位数字完成注册。"
      : "该邮箱尚未验证。点击“获取验证码”后输入邮件中的 6 位数字。");
    authContent.innerHTML = `<form id="email-verification-code-form-v2" class="auth-form" novalidate>
      <div class="auth-section-head"><h2>验证邮箱</h2><p>${sent ? "验证码 10 分钟内有效。没有收到时可重新获取。" : "先获取验证码，再输入邮件中的 6 位数字。"}</p></div>
      <div class="field"><label for="auth-verification-email-v2">邮箱</label><input id="auth-verification-email-v2" name="email" type="email" maxlength="254" value="${escapeHtml(email)}" readonly></div>
      <div class="field"><label class="required" for="auth-verification-code-v2">6 位验证码</label><input id="auth-verification-code-v2" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="000000" required></div>
      <p class="field-help" data-v2-verification-status aria-live="polite">${sent ? "验证码已发送，请检查收件箱、垃圾邮件和推广邮件。" : ""}</p>
      <button class="button primary auth-button" type="submit">验证并激活账号</button>
      <div class="auth-section-head"><p>没有收到验证码？</p></div>
      <button class="auth-link" type="button" data-v2-auth-action="resend">${sent ? `${RESEND_SECONDS} 秒后可重新获取验证码` : "获取验证码"}</button>
      <div class="turnstile-slot" data-v2-verification-turnstile aria-label="获取验证码人机验证" hidden></div>
      <input type="hidden" name="resend_turnstile_token" data-sensitive value="">
      <button class="auth-link" type="button" data-v2-auth-action="login">返回登录</button>
    </form>`;
  } finally {
    observer?.observe(authContent, { childList: true, subtree: true });
  }
  authContent.querySelector('input[name="code"]')?.focus();
  if (sent) startResendCooldown();
}

async function verifyCode(form) {
  if (submissionInFlight) return;
  const email = text(form.querySelector('input[name="email"]')?.value).trim();
  const code = text(form.querySelector('input[name="code"]')?.value).trim();
  if (!CODE_PATTERN.test(code)) {
    verificationStatus("请输入邮件中的 6 位数字验证码。", "error");
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  submissionInFlight = true;
  setButton(button, true, "正在验证…");
  try {
    await request("/api/auth/email/verify-code", { email, code });
    history.replaceState(null, "", `/#/login?verified_email=${encodeURIComponent(email)}`);
    globalThis.location.reload();
  } catch (error) {
    verificationStatus(formattedError(error), "error");
    const input = form.querySelector('input[name="code"]');
    if (input) { input.value = ""; input.focus(); }
    setButton(button, false, "验证并激活账号");
  } finally {
    submissionInFlight = false;
  }
}

function applyRouteState() {
  const verification = verificationRouteInfo();
  if (verification) {
    if (!authContent?.querySelector("#email-verification-code-form-v2")) renderVerification(verification.email, verification);
    return;
  }
  ensurePasswordConfirmation();
  const email = verifiedLoginEmail();
  if (email) {
    const form = authContent?.querySelector("#email-login-form");
    const input = form?.querySelector('input[name="email"]');
    if (input && !input.value) input.value = email;
    if (form) setMessage("邮箱验证成功，请输入密码登录。");
  }
}

function scheduleApply() {
  if (applyScheduled) return;
  applyScheduled = true;
  queueMicrotask(() => {
    applyScheduled = false;
    applyRouteState();
  });
}

function interceptSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (!["email-login-form", "email-register-form", "email-verification-code-form-v2"].includes(form.id)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (form.id === "email-login-form") handleLogin(form);
  else if (form.id === "email-register-form") handleRegistration(form);
  else verifyCode(form);
}

function interceptClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-v2-auth-action]") : null;
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (target.dataset.v2AuthAction === "resend") showVerificationChallenge(target);
  if (target.dataset.v2AuthAction === "login") {
    stopResendTimer();
    history.replaceState(null, "", "/#/login");
    globalThis.location.reload();
  }
}

watchTurnstile();
documentRef?.addEventListener("submit", interceptSubmit, true);
documentRef?.addEventListener("click", interceptClick, true);

if (authContent) {
  observer = new MutationObserver(scheduleApply);
  observer.observe(authContent, { childList: true, subtree: true });
  globalThis.addEventListener("hashchange", scheduleApply);
  scheduleApply();
}

export const __test = {
  CODE_PATTERN,
  REQUEST_TIMEOUT_MS,
  RESEND_SECONDS,
  routeInfo,
  verificationRouteInfo,
  openAuthenticatedDashboard,
};
