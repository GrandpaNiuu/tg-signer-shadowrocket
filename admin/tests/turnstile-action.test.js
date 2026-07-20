import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/auth-security.js", import.meta.url);

async function source() {
  return readFile(sourceUrl, "utf8");
}

test("frontend labels each email authentication challenge with its server action", async () => {
  const content = await source();
  assert.match(content, /login: "email_login"/);
  assert.match(content, /register: "email_register"/);
  assert.match(content, /"forgot-password": "forgot_password"/);
  assert.match(content, /"reset-password": "reset_password"/);
  assert.match(content, /action: turnstileAction\(\)/);
  assert.match(content, /turnstile\.render = wrappedRender/);
});
