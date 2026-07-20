import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("admin shell loads secure authentication and platform broadcast guidance", async () => {
  const index = await source("index.html");
  assert.match(index, /src="\/src\/auth-security\.js"/);
  assert.match(index, /src="\/src\/notification-guidance\.js"/);
});

test("registration guidance distinguishes available GitHub registration from closed email registration", async () => {
  const [security, presentation] = await Promise.all([
    source("src/auth-security.js"),
    source("src/auth-presentation.js"),
  ]);
  assert.match(security, /registrationPresentation/);
  assert.match(security, /邮箱注册尚未开放/);
  assert.match(security, /已有邮箱账号？返回登录/);
  assert.match(presentation, /GitHub 注册已开放/);
  assert.match(presentation, /已有邮箱账号仍可返回登录/);
  assert.match(presentation, /邮箱新注册和自助找回密码尚未完成安全配置/);
});

test("notification guidance explains the administrator-wide broadcast scope", async () => {
  const content = await source("src/notification-guidance.js");
  assert.match(content, /全平台任务结果通知/);
  assert.match(content, /所有用户工作区的任务结果/);
  assert.match(content, /查看执行详情/);
  assert.match(content, /成功消息保持简洁/);
});
