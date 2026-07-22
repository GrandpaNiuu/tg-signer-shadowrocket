const documentRef = globalThis.document;
const authContent = documentRef?.querySelector("#auth-content") || null;
const authMessage = documentRef?.querySelector("#auth-message") || null;

const COPY = Object.freeze({
  loginIntro: "输入注册邮箱和密码，并完成人机验证。连续多次失败后，系统会暂时限制尝试。",
  registerIntro: "注册后可以绑定自己的 Telegram 账号，并单独管理定时消息、机器人操作和执行记录。不同用户的数据相互隔离。",
  passwordHelp: "至少 12 个字符。建议使用独立的长密码或多个无关词语组合，不要使用其他网站已经使用过的密码。",
  turnstileHelp: "请完成人机验证。验证结果短时间内有效；页面停留较久或验证过期后，需要重新完成验证。",
  privacyHelp: "邮箱仅用于登录验证、安全通知和密码找回。",
  forgotHelp: "为保护账号隐私，页面不会显示邮箱是否已经注册。若账号存在，我们会发送密码重置邮件。",
  resetHelp: "设置完成后，所有旧登录会话都会退出，需要使用新密码重新登录。",
  verificationMessage: "请求已提交。为保护账号隐私，页面不会显示该邮箱是否已经注册。新用户请检查邮箱中的 6 位验证码；已有账号请返回登录或使用“忘记密码”。",
  verificationHelp: "输入邮件中的 6 位验证码。验证码 10 分钟内有效，连续输错 5 次后失效。",
  verificationStatus: "邮件通常会在几分钟内送达。收到后输入验证码；没有收到时按下方步骤检查或重新发送。",
  resendHelp: "仍未收到时，请先完成邮件分类检查，再通过人机验证重新发送。",
});

function authMode(hash = globalThis.location?.hash) {
  return String(hash || "#/login").replace(/^#\/?/, "").split("?", 1)[0] || "login";
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function buildSection(key, title, description) {
  const section = documentRef.createElement("div");
  section.className = "auth-section-head";
  section.dataset.authGuidance = key;
  const heading = documentRef.createElement("h2");
  heading.textContent = title;
  const paragraph = documentRef.createElement("p");
  paragraph.textContent = description;
  section.append(heading, paragraph);
  return section;
}

function prependSection(form, key, title, description) {
  if (!form || form.querySelector(`[data-auth-guidance="${key}"]`)) return;
  form.prepend(buildSection(key, title, description));
}

function insertHelpBefore(target, key, description) {
  if (!target || target.parentElement?.querySelector(`[data-auth-guidance="${key}"]`)) return;
  const help = documentRef.createElement("p");
  help.className = "field-help";
  help.dataset.authGuidance = key;
  help.textContent = description;
  target.insertAdjacentElement("beforebegin", help);
}

function insertHelpAfter(target, key, description) {
  if (!target || target.parentElement?.querySelector(`[data-auth-guidance="${key}"]`)) return;
  const help = documentRef.createElement("p");
  help.className = "field-help";
  help.dataset.authGuidance = key;
  help.textContent = description;
  target.insertAdjacentElement("afterend", help);
}

function updateSecureLoginNotice() {
  const notice = authContent?.querySelector('[data-auth-security-notice="secure-email-ready"]');
  const content = notice?.querySelector("span:nth-child(2)");
  if (!content || content.dataset.authGuidanceUpdated === "true") return;
  const heading = documentRef.createElement("strong");
  heading.textContent = "邮箱登录";
  content.replaceChildren(heading, documentRef.createElement("br"), documentRef.createTextNode(COPY.loginIntro));
  content.dataset.authGuidanceUpdated = "true";
}

function updateDefaultHeader(mode) {
  if (!authMessage) return;
  const value = authMessage.textContent.trim();
  if (mode === "login" && [
    "登录后管理自己的 Telegram 账号与自动消息任务。",
    "登录或注册后管理自己的自动消息任务。",
    "登录或注册后管理 Telegram 账号、定时消息与机器人命令。",
  ].includes(value)) {
    setText(authMessage, "使用邮箱或 GitHub 登录，管理自己的 Telegram 自动消息。");
  }
  if (mode === "register" && value === "创建独立工作区，随后绑定自己的 Telegram 账号。") {
    setText(authMessage, "创建账号后绑定自己的 Telegram 账号，并独立管理自动消息。");
  }
}

function applyLoginGuidance() {
  const form = authContent?.querySelector("#email-login-form");
  if (!form) return;
  prependSection(form, "login-intro", "邮箱登录", COPY.loginIntro);
  insertHelpBefore(form.querySelector("[data-turnstile]"), "turnstile-login", COPY.turnstileHelp);
  updateSecureLoginNotice();
}

function applyRegistrationGuidance() {
  const form = authContent?.querySelector("#email-register-form");
  if (!form) return;
  prependSection(form, "register-intro", "创建邮箱账号", COPY.registerIntro);
  const passwordField = form.querySelector('input[name="password"]')?.closest(".field");
  setText(passwordField?.querySelector(".field-help"), COPY.passwordHelp);
  insertHelpBefore(form.querySelector("[data-turnstile]"), "turnstile-register", COPY.turnstileHelp);
  insertHelpAfter(form.querySelector('button[type="submit"]'), "registration-privacy", COPY.privacyHelp);
}

function applyForgotPasswordGuidance() {
  const form = authContent?.querySelector("#forgot-password-form");
  if (!form) return;
  setText(form.querySelector(".auth-section-head p"), COPY.forgotHelp);
  insertHelpBefore(form.querySelector("[data-turnstile]"), "turnstile-forgot", COPY.turnstileHelp);
}

function applyResetPasswordGuidance() {
  const form = authContent?.querySelector("#reset-password-form");
  if (!form) return;
  setText(form.querySelector(".auth-section-head p"), COPY.resetHelp);
  const passwordField = form.querySelector('input[name="password"]')?.closest(".field");
  insertHelpAfter(passwordField?.querySelector("input"), "reset-password-help", COPY.passwordHelp);
  insertHelpBefore(form.querySelector("[data-turnstile]"), "turnstile-reset", COPY.turnstileHelp);
}

function applyVerificationGuidance() {
  const form = authContent?.querySelector("#email-verification-code-form");
  if (!form) return;
  setText(authMessage, COPY.verificationMessage);
  const sections = form.querySelectorAll(".auth-section-head");
  setText(sections[0]?.querySelector("h2"), "第一步：输入验证码");
  setText(sections[0]?.querySelector("p"), COPY.verificationHelp);
  setText(sections[1]?.querySelector("h3, h2"), "第三步：重新发送");
  setText(sections[1]?.querySelector("p"), COPY.resendHelp);
  const status = form.querySelector("[data-verification-status]");
  if (status && /注册请求已受理|账号已经创建|验证码已发送/.test(status.textContent)) {
    setText(status, COPY.verificationStatus);
  }
}

function applyGuidance() {
  if (!authContent) return;
  const mode = authMode();
  updateDefaultHeader(mode);
  applyLoginGuidance();
  applyRegistrationGuidance();
  applyForgotPasswordGuidance();
  applyResetPasswordGuidance();
  applyVerificationGuidance();
}

if (authContent) {
  const observer = new MutationObserver(applyGuidance);
  observer.observe(authContent, { childList: true, subtree: true });
  window.addEventListener("hashchange", applyGuidance);
  applyGuidance();
}

export const __test = { COPY, authMode };
