import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { authenticationRepository, withEmailVerificationLifecycle } from "../src/auth-repository.js";

const facadeUrl = new URL("../src/repository-facade.js", import.meta.url);

test("authentication boundary preserves repository method binding", async () => {
  const repository = {
    marker: "bound",
    async createAuthToken(token) {
      this.created = token;
      return token;
    },
    async consumeEmailVerification() {
      return null;
    },
    boundValue() {
      return this.marker;
    },
  };
  const wrapped = withEmailVerificationLifecycle(repository);
  const token = { token_type: "password_reset", id: "token-1" };
  assert.equal(await wrapped.createAuthToken(token), token);
  assert.equal(repository.created, token);
  assert.equal(wrapped.boundValue(), "bound");
});

test("authentication boundary remains optional for non-email repositories", () => {
  const repository = { value: 1 };
  assert.equal(withEmailVerificationLifecycle(repository), repository);
  assert.throws(() => authenticationRepository(null), /Repository is unavailable/);
});

test("generic repository facade delegates authentication logic to the domain module", async () => {
  const content = await readFile(facadeUrl, "utf8");
  assert.match(content, /from "\.\/auth-repository\.js"/);
  assert.match(content, /export \{ authenticationRepository \}/);
  assert.doesNotMatch(content, /auth_tokens|consumeVerificationToken|createVerificationToken/);
});
