import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../index.html", import.meta.url);
const sourceUrl = new URL("../src/email-delivery-guidance.js", import.meta.url);

test("verification page presents email recovery as the second clear step", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /第二步：检查邮件分类/);
  assert.match(source, /垃圾邮件 \/ Spam/);
  assert.match(source, /推广邮件/);
  assert.match(source, /不是垃圾邮件/);
  assert.match(source, /重新发送后只能使用最新验证码/);
  assert.match(source, /dataEmailDeliveryGuidance|emailDeliveryGuidance/);
});

test("production page loads the current email delivery guidance controller", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /email-delivery-guidance\.js\?v=20260723-2/);
});
