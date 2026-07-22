import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readSessionGuide() {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function sessionImportGuide");
  const end = app.indexOf("function openAccountWizard", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return { app, end, guide: app.slice(start, end) };
}

function readSessionHelper() {
  return readFile(new URL("../assets/make_session.py", import.meta.url), "utf8");
}

test("browser code does not persist data or use inline executable content", async () => {
  const [html, app, headers] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../_headers", import.meta.url), "utf8"),
  ]);
  assert.equal(/localStorage|sessionStorage|indexedDB/.test(`${html}\n${app}`), false);
  assert.equal(/\sstyle=/.test(`${html}\n${app}`), false);
  assert.equal(/\son[a-z]+=/.test(html), false);
  assert.match(headers, /Content-Security-Policy:/);
  assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/);
  assert.match(headers, /img-src[^;]*blob:/);
  assert.match(headers, /media-src[^;]*blob:/);
});

test("account edit controls never render stored credentials and support explicit clears", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function editAccountFields");
  const end = app.indexOf("function openEditAccount", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fields = app.slice(start, end);
  for (const name of ["phone", "proxy_host", "proxy_port", "proxy_username", "proxy_password"]) {
    assert.match(fields, new RegExp(`name=\\"${name}\\"[^>]*data-sensitive[^>]*value=\\"\\"`));
  }
  assert.doesNotMatch(fields, /name="api_id"|name="api_hash"/);
  assert.match(fields, /设置/);
  assert.match(fields, /name="session"[^>]*data-sensitive/);
  assert.match(fields, /name="clear_session"/);
  assert.match(fields, /name="clear_proxy"/);
  assert.doesNotMatch(fields, /phone_masked|account\.phone|account\.api|account\.session|account\.proxy/);
});

test("new account login asks for a phone number instead of per-account API credentials", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function accountFields");
  const end = app.indexOf("function openTelegramApplicationSetup", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fields = app.slice(start, end);
  assert.match(fields, /name="phone"/);
  assert.match(fields, /name="session"/);
  assert.doesNotMatch(fields, /API_ID|API_HASH|name="api_id"|name="api_hash"/);

  const wizardStart = app.indexOf("function openAccountWizard", end);
  const wizardEnd = app.indexOf("function accountPayload", wizardStart);
  const wizard = app.slice(wizardStart, wizardEnd);
  assert.match(wizard, /手机号登录/);
  assert.match(wizard, /输入手机号/);
});

test("missing platform credentials fall back to Session import instead of blocking account creation", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /function openTelegramApplicationSetup/);
  assert.match(app, /id="telegram-application-setup-form"/);
  assert.match(app, /https:\/\/my\.telegram\.org\/apps/);
  assert.match(app, /needsTelegramApplicationSetup\(store\.get\(\)\.settings\)/);
  assert.match(app, /credentialsMissing/);
  assert.match(app, /mode = "import"/);
  assert.match(app, /data-mode="login"[^>]*disabled/);
  assert.match(app, /telegram_application_not_configured/);
  assert.match(app, /openAccountWizard\("import"\)/);
});

test("Session import teaches new users the compatible and safe local workflow", async () => {
  const [{ app, end, guide }, helper] = await Promise.all([readSessionGuide(), readSessionHelper()]);

  assert.match(guide, /第一次使用 Session/);
  assert.match(guide, /Kurigram \/ Pyrogram/);
  assert.match(guide, /href="\/assets\/make_session\.py"[^>]*download/);
  assert.match(guide, /py -m pip install --upgrade kurigram/);
  assert.match(guide, /python3 -m pip install --upgrade kurigram/);
  assert.doesNotMatch(guide, /pip install[^<\n]*tgcrypto/i);
  assert.match(guide, /在线 Session 生成网站或机器人/);
  assert.match(guide, /Telegram 设置.*设备/);
  assert.match(guide, /API_ID.*API_HASH/s);
  assert.doesNotMatch(guide, /name="api_(?:id|hash)"/);
  assert.doesNotMatch(guide, /localStorage|sessionStorage|indexedDB/);
  assert.match(guide, /只与 Telegram 通信/);
  assert.match(guide, /点击.*加密导入.*Session.*本平台/s);
  assert.doesNotMatch(guide, /不会上传凭据/);

  assert.match(helper, /from getpass import getpass/);
  assert.match(helper, /in_memory=True/);
  assert.match(helper, /export_session_string/);
  assert.doesNotMatch(helper, /requests|subprocess|os\.environ|https?:\/\//);

  const wizard = app.slice(end, app.indexOf("function accountPayload", end));
  assert.match(wizard, /sessionImportGuide\(\)/);
});

test("the Session guide restores the pinned legacy tg-signer login path as the easiest option", async () => {
  const { guide } = await readSessionGuide();
  assert.match(guide, /首选.*tg-signer/s);
  assert.match(guide, /无需手动填写 API_ID/);
  assert.match(guide, /tg-signer 0\.9\.0b2/);
  assert.match(guide, /95a98572dcef5e0b96fc17e6a2331c8f4dc9d886/);
  assert.match(guide, /--proxy &quot;socks5:\/\/127\.0\.0\.1:10808&quot;/);
  assert.match(guide, /--session_dir/);
  assert.match(guide, /new-account\.session_string/);
  assert.match(guide, /Set-Clipboard/);
  assert.match(guide, /NewGuid\(\)/);
  assert.match(guide, /icacls\.exe.*\/inheritance:r.*\/grant:r/s);
  assert.match(guide, /try \{.*finally \{/s);
  assert.match(guide, /finally \{.*Remove-Item -LiteralPath \$sessionRoot/s);
  assert.match(guide, /Set-Clipboard -Value &quot;&quot;/);
  assert.match(guide, /自带的客户端配置/);
  assert.match(guide, /不是绕过 Telegram 协议/);
  assert.match(guide, /第三方.*将来可能受 Telegram 限制/s);
});

test("the downloadable Session helper handles blocked Telegram networks without hiding credential mistakes", async () => {
  const [{ guide }, helper] = await Promise.all([readSessionGuide(), readSessionHelper()]);
  assert.match(helper, /API_ID（不是手机号/);
  assert.match(helper, /def read_proxy/);
  assert.match(helper, /"scheme"/);
  assert.match(helper, /"hostname"/);
  assert.match(helper, /proxy=proxy/);
  assert.match(helper, /127\.0\.0\.1/);
  assert.match(helper, /10808/);
  assert.match(helper, /except OSError/);

  assert.match(guide, /Connection timed out|网络超时/);
  assert.match(guide, /127\.0\.0\.1:10808/);
});

test("the downloadable Session helper remains compatible with older supported Python 3 versions", async () => {
  const helper = await readSessionHelper();
  assert.match(helper, /from typing import Dict, Optional/);
  assert.doesNotMatch(helper, /dict\[[^\]]+\]|\| None/);
});

test("the Session guide explains the common Windows errors before users retry unsafe workarounds", async () => {
  const { guide } = await readSessionGuide();
  assert.match(guide, /No module named pip/);
  assert.match(guide, /Microsoft Visual C\+\+/);
  assert.match(guide, /can't open file/);
  assert.match(guide, /from.*PowerShell/s);
});

test("notification settings render only blank sensitive inputs with explicit clear controls", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const name of ["notification_bot_token", "notification_chat_id"]) {
    assert.match(app, new RegExp(`name=\\"${name}\\"[^>]*data-sensitive[^>]*value=\\"\\"`));
  }
  assert.match(app, /name="clear_notification_bot_token"/);
  assert.match(app, /name="clear_notification_chat_id"/);
  assert.match(app, /https:\/\/t\.me\/BotFather/);
  assert.match(app, /data-action="discover-notification-chats"/);
  assert.match(app, /data-action="test-notification"/);
  assert.match(app, /通知只影响任务结果提醒/);
  assert.doesNotMatch(app, /value="\$\{settings\.notification_(?:bot_token|chat_id)/);
});

test("global Telegram application settings use blank secret inputs and explain legacy reuse", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const name of ["telegram_api_id", "telegram_api_hash"]) {
    assert.match(app, new RegExp(`name=\\"${name}\\"[^>]*data-sensitive[^>]*value=\\"\\"`));
  }
  assert.match(app, /telegram_application_source/);
  assert.match(app, /旧账号/);
  assert.doesNotMatch(app, /value="\$\{settings\.telegram_(?:api_id|api_hash)/);
});

test("transient Telegram login errors keep polling the current account", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function renderLoginFlow");
  const end = app.indexOf("async function pollLoginFlow", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const loginFlow = app.slice(start, end);
  assert.match(loginFlow, /status === "starting" && flow\.last_error/);
  assert.match(loginFlow, /Runner 会自动重试，无需重新添加账号/);
  assert.match(loginFlow, /shouldPoll = true/);
});

test("the application shell is gated by an authenticated user before data loads", async () => {
  const [html, app, api] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/api.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="auth-gate"[^>]*hidden/);
  assert.match(app, /href="\/api\/auth\/github\/start"/);
  assert.match(app, /api\.authConfig\(\)/);
  assert.match(html, /id="app"[^>]*hidden/);
  assert.match(html, /id="logout-button"/);
  assert.doesNotMatch(html, /Cloudflare Access/);
  assert.match(api, /baseUrl: "\/api\/auth"/);
  assert.match(api, /request\("\/me"\)/);
  assert.match(api, /request\("\/logout", \{ method: "POST"/);
  assert.match(app, /async function bootstrap\(\)/);
  assert.match(app, /if \(await loadIdentity\(\)\)/);
  assert.doesNotMatch(app, /loadIdentity\(\);\s*refreshRoute\(\);/);
});

test("logout redirects only after the server revokes the session", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf('document.querySelector("#logout-button")');
  const end = app.indexOf('document.addEventListener("keydown"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const logout = app.slice(start, end);
  assert.match(logout, /await api\.logout\(\);\s*location\.replace\("\/"\);/);
  assert.match(logout, /catch \(error\)/);
  assert.match(logout, /event\.currentTarget\.disabled = false/);
});

test("the public auth gate supports immediate or verified email registration without browser persistence", async () => {
  const [html, app, headers] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../_headers", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="auth-content"/);
  assert.match(app, /email-register-form/);
  assert.match(app, /email-login-form/);
  assert.match(app, /forgot-password-form/);
  assert.match(app, /reset-password-form/);
  assert.match(app, /api\.registerEmail/);
  assert.match(app, /api\.loginEmail/);
  assert.match(app, /api\.verifyEmail/);
  assert.match(app, /api\.resetPassword/);
  assert.match(app, /email_verification_required/);
  assert.match(app, /password_reset_enabled/);
  assert.match(app, /当前邮箱仅作为登录名/);
  assert.match(headers, /script-src[^\n]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(headers, /frame-src[^\n]*https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(`${html}\n${app}`, /localStorage|sessionStorage|indexedDB/);
});
