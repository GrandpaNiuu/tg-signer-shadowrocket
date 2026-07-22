import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("auth flow v2 loads before all legacy authentication handlers", async () => {
  const index = await source("index.html");
  const v2 = index.indexOf('/src/auth-flow-v2.js');
  const runtime = index.indexOf('/src/auth-runtime-controller.js');
  const app = index.indexOf('/src/app.js');
  const verification = index.indexOf('/src/email-verification-code.js');
  assert.ok(v2 >= 0);
  assert.ok(v2 < runtime);
  assert.ok(v2 < app);
  assert.ok(v2 < verification);
});

test("login and registration requests have a hard timeout and preserve form data", async () => {
  const content = await source("src/auth-flow-v2.js");
  assert.match(content, /const REQUEST_TIMEOUT_MS = 20_000/);
  assert.match(content, /controller\.abort\(\)/);
  assert.match(content, /最长等待 20 秒/);
  assert.match(content, /密码已保留/);
  assert.match(content, /注册资料和密码已保留/);
});

test("verification page uses one get-code action without a redundant third step", async () => {
  const content = await source("src/auth-flow-v2.js");
  assert.match(content, /data-v2-auth-action=\"resend\"/);
  assert.match(content, /获取验证码/);
  assert.match(content, /完成人机验证后会自动发送验证码，无需再次点击/);
  assert.match(content, /callback: \(token\) => \{[\s\S]*sendVerificationCode\(button\)/);
  assert.doesNotMatch(content, /第三步/);
});

test("v2 verification route does not activate the legacy verification renderer", async () => {
  const content = await source("src/auth-flow-v2.js");
  assert.match(content, /verification_email_v2/);
  assert.match(content, /email-verification-code-form-v2/);
  assert.match(content, /event\.stopImmediatePropagation\(\)/);
});
