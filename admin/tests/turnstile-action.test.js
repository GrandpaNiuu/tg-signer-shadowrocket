import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../src/", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("frontend labels each email authentication challenge with its server action", async () => {
  const [presentation, security] = await Promise.all([
    source("auth-presentation.js"),
    source("auth-security.js"),
  ]);
  assert.match(presentation, /login: "email_login"/);
  assert.match(presentation, /register: "email_register"/);
  assert.match(presentation, /"forgot-password": "forgot_password"/);
  assert.match(presentation, /"reset-password": "reset_password"/);
  assert.match(security, /turnstileActionForMode\(authMode\(\)\)/);
  assert.match(security, /action: turnstileAction\(\)/);
  assert.match(security, /turnstile\.render = wrappedRender/);
});
