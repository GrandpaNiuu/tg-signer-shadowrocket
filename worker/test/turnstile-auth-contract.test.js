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
  for (const action of ["email_register", "email_login", "forgot_password", "reset_password"]) {
    assert.equal(content.split(`"${action}"`).length - 1, 1, `${action} must appear exactly once`);
  }
  assert.doesNotMatch(content, /async function verifyTurnstile\(/);
  assert.match(content, /origin: config\.origin/);
  assert.match(content, /secret: config\.turnstileSecret/);
});
