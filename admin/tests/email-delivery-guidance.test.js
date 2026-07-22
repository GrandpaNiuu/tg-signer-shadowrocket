import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../index.html", import.meta.url);
const sourceUrl = new URL("../src/email-delivery-guidance.js", import.meta.url);

test("verification page explains spam-folder recovery and newest-code behavior", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /垃圾邮件 \/ Spam/);
  assert.match(source, /不是垃圾邮件/);
  assert.match(source, /只使用最新一封邮件中的验证码/);
  assert.match(source, /重新发送后旧验证码立即失效/);
  assert.match(source, /dataEmailDeliveryGuidance|emailDeliveryGuidance/);
});

test("production page loads the email delivery guidance controller", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /email-delivery-guidance\.js\?v=20260723-1/);
});
