import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const securityUrl = new URL("../src/auth-security.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

async function securitySource() {
  return readFile(securityUrl, "utf8");
}

test("email login is intercepted before the legacy form handler can clear the password", async () => {
  const source = await securitySource();
  assert.match(source, /authGate\.addEventListener\("submit", interceptEmailLogin, \{ capture: true \}\)/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /form\.id !== "email-login-form"/);
});

test("email login confirms that the browser session exists before opening the dashboard", async () => {
  const source = await securitySource();
  assert.match(source, /fetch\("\/api\/auth\/email\/login"/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /async function confirmedEmailSession\(\)/);
  assert.match(source, /fetch\("\/api\/auth\/me"/);
  assert.match(source, /location\.replace\("\/#\/dashboard"\)/);
});

test("a failed login keeps the password and only resets the one-time Turnstile challenge", async () => {
  const source = await securitySource();
  assert.match(source, /密码已保留，只需重新完成人机验证后再次提交/);
  assert.match(source, /resetLoginTurnstile\(form\)/);
  assert.match(source, /turnstile\.reset\(widgetId \|\| container\)/);
  assert.doesNotMatch(source, /catch \(error\) \{[\s\S]{0,500}clearLoginSecrets\(form\)/);
});

test("the admin shell cache-busts the repaired email login controller", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /src="\/src\/auth-security\.js\?v=20260723-2"/);
});
