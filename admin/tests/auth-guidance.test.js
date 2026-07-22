import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/auth-guidance.js";

const indexUrl = new URL("../index.html", import.meta.url);
const sourceUrl = new URL("../src/auth-guidance.js", import.meta.url);

test("authentication guidance explains each user action in plain language", () => {
  assert.match(__test.COPY.registerIntro, /绑定自己的 Telegram 账号/);
  assert.match(__test.COPY.registerIntro, /数据相互隔离/);
  assert.match(__test.COPY.passwordHelp, /至少 12 个字符/);
  assert.match(__test.COPY.passwordHelp, /不要使用其他网站已经使用过的密码/);
  assert.match(__test.COPY.turnstileHelp, /验证过期后/);
  assert.match(__test.COPY.forgotHelp, /不会显示邮箱是否已经注册/);
  assert.match(__test.COPY.privacyHelp, /登录验证、安全通知和密码找回/);
});

test("verification guidance uses a three-step hierarchy", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /第一步：输入验证码/);
  assert.match(source, /第三步：重新发送/);
  assert.match(source, /邮件通常会在几分钟内送达/);
  assert.match(source, /已有账号请返回登录或使用“忘记密码”/);
});

test("guidance controller follows the active authentication route", () => {
  assert.equal(__test.authMode("#/login"), "login");
  assert.equal(__test.authMode("#/register?verification_email=user%40example.com"), "register");
  assert.equal(__test.authMode("#/forgot-password"), "forgot-password");
});

test("production page loads the authentication guidance controller", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /auth-guidance\.js\?v=20260723-1/);
});
