import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/account-login-only.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("account entry policy removes legacy import, proxy fields, and credential notice", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /aria-label=\"添加方式\"/);
  assert.match(source, /\.session-guide/);
  assert.match(source, /includes\(\"代理\"\)/);
  assert.match(source, /Telegram 应用凭据由后台统一管理/);
  assert.match(source, /form\.dataset\.mode !== \"import\"/);
  assert.match(source, /手机号登录暂时不可用/);
});

test("phone-only account policy is loaded by the production page", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /\/src\/account-login-only\.js\?v=20260721-1/);
});
