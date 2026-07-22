import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/email-verification-code.js";

const indexUrl = new URL("../index.html", import.meta.url);
const sourceUrl = new URL("../src/email-verification-code.js", import.meta.url);

test("verification route keeps only the pending email and never stores a code", () => {
  assert.equal(__test.verificationEmailFromLocation("#/register?verification_email=user%40example.com"), "user@example.com");
  assert.equal(__test.verificationEmailFromLocation("#/login"), "");
  assert.equal(__test.CODE_PATTERN.test("123456"), true);
  assert.equal(__test.CODE_PATTERN.test("12345a"), false);
});

test("registration and code verification are intercepted before the legacy submit handler", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /addEventListener\("submit"[\s\S]*true\)/);
  assert.match(source, /stopImmediatePropagation\(\)/);
  assert.match(source, /\/api\/auth\/email\/verify-code/);
  assert.match(source, /\/api\/auth\/email\/resend-code/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("production page loads the email verification code controller", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /email-verification-code\.js\?v=20260722-1/);
});
