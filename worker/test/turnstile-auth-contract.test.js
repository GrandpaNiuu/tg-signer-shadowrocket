import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/email-auth.js", import.meta.url);

async function source() {
  return readFile(sourceUrl, "utf8");
}

test("every sensitive email authentication flow uses a distinct Turnstile action", async () => {
  const content = await source();
  assert.match(content, /from "\.\/turnstile\.js"/);
  const actions = [...content.matchAll(/"(email_register|email_login|forgot_password|reset_password)",\s*fetchImpl/g)]
    .map((match) => match[1]);
  assert.deepEqual(actions, ["email_register", "email_login", "forgot_password", "reset_password"]);
  assert.doesNotMatch(content, /async function verifyTurnstile\(/);
  assert.match(content, /origin: config\.origin/);
  assert.match(content, /secret: config\.turnstileSecret/);
});
