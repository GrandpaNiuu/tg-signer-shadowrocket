import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("authentication controller loads before the legacy application handlers", async () => {
  const index = await source("index.html");
  const controller = index.indexOf('/src/auth-runtime-controller.js');
  const app = index.indexOf('/src/app.js');
  const verification = index.indexOf('/src/email-verification-code.js');
  assert.ok(controller >= 0);
  assert.ok(controller < app);
  assert.ok(controller < verification);
});

test("Turnstile action is attached before login and registration tokens are issued", async () => {
  const content = await source("src/auth-runtime-controller.js");
  assert.match(content, /action: options\.action \|\| turnstileActionForMode\(authMode\(\)\)/);
  assert.match(content, /email-login-form/);
  assert.match(content, /email-register-form/);
  assert.match(content, /documentRef\?\.addEventListener\("submit", interceptAuthSubmit, true\)/);
  assert.match(content, /event\.stopImmediatePropagation\(\)/);
});

test("failed login and registration preserve passwords and only reset Turnstile", async () => {
  const content = await source("src/auth-runtime-controller.js");
  assert.match(content, /密码已保留，只需重新完成人机验证/);
  assert.match(content, /注册资料和密码已保留，只需重新完成人机验证/);
  assert.match(content, /resetTurnstile\(form\)/);
  assert.match(content, /sessionEstablished\(\)/);
});
