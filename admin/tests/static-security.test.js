import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
});

test("account edit controls never render stored credentials and support explicit clears", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function editAccountFields");
  const end = app.indexOf("function openEditAccount", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fields = app.slice(start, end);
  for (const name of ["phone", "api_id", "api_hash", "proxy_host", "proxy_port", "proxy_username", "proxy_password"]) {
    assert.match(fields, new RegExp(`name=\\"${name}\\"[^>]*data-sensitive[^>]*value=\\"\\"`));
  }
  assert.match(fields, /name="session"[^>]*data-sensitive/);
  assert.match(fields, /name="clear_session"/);
  assert.match(fields, /name="clear_proxy"/);
  assert.doesNotMatch(fields, /phone_masked|account\.phone|account\.api|account\.session|account\.proxy/);
});

test("notification settings render only blank sensitive inputs with explicit clear controls", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  for (const name of ["notification_bot_token", "notification_chat_id"]) {
    assert.match(app, new RegExp(`name=\\"${name}\\"[^>]*data-sensitive[^>]*value=\\"\\"`));
  }
  assert.match(app, /name="clear_notification_bot_token"/);
  assert.match(app, /name="clear_notification_chat_id"/);
  assert.doesNotMatch(app, /value="\$\{settings\.notification_(?:bot_token|chat_id)/);
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

test("the administrator shell is gated by GitHub login before data loads", async () => {
  const [html, app, api] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/api.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="auth-gate"[^>]*hidden/);
  assert.match(html, /href="\/api\/auth\/github\/start"/);
  assert.match(html, /id="app"[^>]*hidden/);
  assert.match(html, /id="logout-button"/);
  assert.doesNotMatch(html, /Cloudflare Access/);
  assert.match(api, /baseUrl: "\/api\/auth"/);
  assert.match(api, /request\("\/session"\)/);
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
