const documentRef = globalThis.document;
const authGate = documentRef?.querySelector("#auth-gate") || null;
const authContent = documentRef?.querySelector("#auth-content") || null;
const authMessage = documentRef?.querySelector("#auth-message") || null;
const CODE_PATTERN = /^\d{6}$/;
const RESEND_SECONDS = 60;

let observer = null;
let scheduled = false;
let countdownTimer = null;
let pendingLogin = null;

function text(value) { return String(value ?? ""); }
function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function verificationEmailFromLocation(hash = globalThis.location?.hash) {
  const [path, query = ""] = text(hash || "#/login").replace(/^#\/?/, "").split("?", 2);
  if (path !== "register") return "";
  return new URLSearchParams(query).get("verification_email")?.trim() || "";
}

async function request(path, body) {
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
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "请求未完成，请稍后重试。");
    error.code = payload?.error?.code || "request_failed";
    error.status = response.status;
    throw error;
  }
  return payload?.data ?? payload ?? null;
}

function setStatus(message, kind = "") {
  const node = authContent?.querySelector("[data-verification-status]");
  if (!node) return;
  node.textContent = message || "";
  node.className = `field-help${kind === "error" ? " field-error" : ""}`;
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function startCountdown(seconds = RESEND_SECONDS) {
  stopCountdown();
  let remaining = seconds;
  const button = authContent?.querySelector('[data-email-code-action="resend"]');
  if (!button) return;
  const update = () => {
    if (!button.isConnected) return stopCountdown();
    button.disabled = remaining > 0;
    button.textContent = remaining > 0 ? `${remaining} 秒后可重新发送` : "重新发送验证码";
    if (remaining <= 0) return stopCountdown();
    remaining -= 1;
  };
  update();
  countdownTimer = setInterval(update, 1000);
}

function renderVerificationForm(email, { sent = false, message = "" } = {}) {
  if (!authContent || !email) return;
  observer?.disconnect();
  try {
    if (authMessage) authMessage.textContent = `6 位验证码已发送到 ${email}，请输入后完成注册。`;
    authContent.innerHTML = `<form id="email-verification-code-form" class="auth-form" novalidate>
      <div class="auth-section-head"><h2>输入邮箱验证码</h2><p>验证码为 6 位数字，10 分钟内有效。重新发送后旧验证码立即失效。</p></div>
      <div class="field"><label for="auth-verification-email">邮箱</label><input id="auth-verification-email" name="email" type="email" maxlength="254" value="${escapeHtml(email)}" readonly></div>
      <div class="field"><label class="required" for="auth-verification-code">6 位验证码</label><input id="auth-verification-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="000000" required></div>
      <p class="field-help" data-verification-status aria-live="polite">${escapeHtml(message)}</p>
      <button class="button primary auth-button" type="submit">验证并激活账号</button>
      <button class="auth-link" type="button" data-email-code-action="resend">重新发送验证码</button>
      <button class="auth-link" type="button" data-email-code-action="login">返回登录</button>
    </form>`;
  } finally {
    observer?.observe(authContent, { childList: true, subtree: true });
  }
  authContent.querySelector('input[name="code"]')?.focus();
  if (sent) startCountdown();
}

function applyPendingLogin() {
  if (!pendingLogin || !authContent) return false;
  const form = authContent.querySelector("#email-login-form");
  if (!form) return false;
  const emailInput = form.querySelector('input[name="email"]');
  if (emailInput && !emailInput.value) emailInput.value = pendingLogin.email;
  if (authMessage) authMessage.textContent = pendingLogin.message;
  form.querySelector('input[name="password"]')?.focus();
  return true;
}

function goToLogin(email, message) {
  pendingLogin = { email, message };
  stopCountdown();
  const loginTab = authContent?.querySelector('[data-auth-mode="login"]');
  if (loginTab) {
    loginTab.click();
    queueMicrotask(scheduleApply);
    return;
  }
  globalThis.location.hash = "#/login";
}

function reloadAuthenticatedDashboard() {
  history.replaceState(null, "", "/#/dashboard");
  globalThis.location.reload();
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const email = verificationEmailFromLocation();
    if (email && !authContent?.querySelector("#email-verification-code-form")) {
      renderVerificationForm(email);
      return;
    }
    applyPendingLogin();
  });
}

async function submitLogin(event, form) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const payload = {
    email: text(data.get("email")).trim(),
    password: text(data.get("password")),
    turnstile_token: text(data.get("turnstile_token")),
  };
  pendingLogin = null;
  if (button) { button.disabled = true; button.textContent = "正在登录…"; }
  try {
    const operation = request("/api/auth/email/login", payload);
    const passwordInput = form.querySelector('input[name="password"]');
    const tokenInput = form.querySelector('input[name="turnstile_token"]');
    if (passwordInput) passwordInput.value = "";
    if (tokenInput) tokenInput.value = "";
    payload.password = "";
    payload.turnstile_token = "";
    await operation;
    reloadAuthenticatedDashboard();
  } catch (error) {
    payload.password = "";
    payload.turnstile_token = "";
    const passwordInput = form.querySelector('input[name="password"]');
    const tokenInput = form.querySelector('input[name="turnstile_token"]');
    if (passwordInput) passwordInput.value = "";
    if (tokenInput) tokenInput.value = "";
    if (error.code === "email_verification_required") {
      history.replaceState(null, "", `/#/register?verification_email=${encodeURIComponent(payload.email)}`);
      renderVerificationForm(payload.email, { sent: true, message: error.message });
      return;
    }
    if (authMessage) authMessage.textContent = error.message;
    globalThis.turnstile?.reset?.();
    if (button) { button.disabled = false; button.textContent = "邮箱登录"; }
  }
}

async function submitRegistration(event, form) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const payload = {
    display_name: text(data.get("display_name")).trim(),
    email: text(data.get("email")).trim(),
    password: text(data.get("password")),
    turnstile_token: text(data.get("turnstile_token")),
  };
  if (button) { button.disabled = true; button.textContent = "正在发送验证码…"; }
  try {
    const result = await request("/api/auth/email/register", payload);
    const passwordInput = form.querySelector('input[name="password"]');
    if (passwordInput) passwordInput.value = "";
    if (result?.status !== "verification_required") {
      reloadAuthenticatedDashboard();
      return;
    }
    const email = payload.email;
    payload.password = "";
    payload.turnstile_token = "";
    history.replaceState(null, "", `/#/register?verification_email=${encodeURIComponent(email)}`);
    renderVerificationForm(email, { sent: true, message: "账号已经创建，验证码已发送。请输入验证码完成激活。" });
  } catch (error) {
    const email = payload.email;
    payload.password = "";
    payload.turnstile_token = "";
    const password = form.querySelector('input[name="password"]');
    const token = form.querySelector('input[name="turnstile_token"]');
    if (password) password.value = "";
    if (token) token.value = "";
    if (error.code === "account_exists") {
      goToLogin(email, "该邮箱账号已经存在。请直接登录；如果尚未完成邮箱验证，登录后会自动进入验证码步骤。");
      return;
    }
    if (authMessage) authMessage.textContent = error.message;
    globalThis.turnstile?.reset?.();
    if (button) { button.disabled = false; button.textContent = "创建账号"; }
  }
}

async function submitVerificationCode(event, form) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const data = new FormData(form);
  const email = text(data.get("email")).trim();
  const code = text(data.get("code")).trim();
  const button = form.querySelector('button[type="submit"]');
  if (!CODE_PATTERN.test(code)) return setStatus("请输入邮件中的 6 位数字验证码。", "error");
  if (button) { button.disabled = true; button.textContent = "正在验证…"; }
  try {
    await request("/api/auth/email/verify-code", { email, code });
    const codeInput = form.querySelector('input[name="code"]');
    if (codeInput) codeInput.value = "";
    goToLogin(email, "邮箱验证成功。请使用刚才设置的密码登录。");
  } catch (error) {
    const codeInput = form.querySelector('input[name="code"]');
    if (codeInput) { codeInput.value = ""; codeInput.focus(); }
    setStatus(error.message, "error");
    if (button) { button.disabled = false; button.textContent = "验证并激活账号"; }
  }
}

async function resendVerificationCode(button) {
  const email = verificationEmailFromLocation();
  if (!email) return;
  button.disabled = true;
  button.textContent = "正在发送…";
  try {
    const result = await request("/api/auth/email/resend-code", { email });
    setStatus("新的验证码已发送，旧验证码已失效。请检查收件箱和垃圾邮件。");
    startCountdown(Number(result?.resend_after_seconds) || RESEND_SECONDS);
  } catch (error) {
    setStatus(error.message, "error");
    button.disabled = false;
    button.textContent = "重新发送验证码";
  }
}

if (authGate && authContent) {
  observer = new MutationObserver(scheduleApply);
  observer.observe(authContent, { childList: true, subtree: true });
  scheduleApply();

  documentRef.addEventListener("submit", (event) => {
    const form = event.target;
    if (form?.id === "email-login-form") return submitLogin(event, form);
    if (form?.id === "email-register-form") return submitRegistration(event, form);
    if (form?.id === "email-verification-code-form") return submitVerificationCode(event, form);
  }, true);

  documentRef.addEventListener("click", (event) => {
    const button = event.target.closest("[data-email-code-action]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.dataset.emailCodeAction === "resend") resendVerificationCode(button);
    if (button.dataset.emailCodeAction === "login") {
      goToLogin(verificationEmailFromLocation(), "请输入邮箱和密码登录。");
    }
  }, true);

  window.addEventListener("hashchange", scheduleApply);
}

export const __test = {
  CODE_PATTERN,
  RESEND_SECONDS,
  verificationEmailFromLocation,
};
