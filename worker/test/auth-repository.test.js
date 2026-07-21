import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authenticationRepository,
  withEmailVerificationLifecycle,
  withGithubProfilePersistence,
  __test,
} from "../src/auth-repository.js";

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

test("GitHub login preserves an existing custom display name", async () => {
  let stored = {
    id: "legacy-admin",
    display_name: "自定义管理员",
    github_name: "Original GitHub Name",
  };
  const repository = {
    db: {
      prepare(sql) {
        assert.match(sql, /UPDATE users SET display_name/);
        return {
          bind(name, timestamp, id) {
            return {
              async run() {
                stored = { ...stored, id, display_name: name, updated_at: timestamp };
              },
            };
          },
        };
      },
    },
    async getUser() { return { ...stored }; },
    async getUserByGithubId() { return { ...stored }; },
    async upsertGithubUser(input) {
      stored = { ...stored, display_name: input.github_name, github_name: input.github_name };
      return { ...stored };
    },
  };
  const wrapped = withGithubProfilePersistence(repository);
  const result = await wrapped.upsertGithubUser({
    is_admin: true,
    github_user_id: "123",
    github_name: "New GitHub Name",
    timestamp: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(result.display_name, "自定义管理员");
  assert.equal(stored.display_name, "自定义管理员");
});

test("authenticated sessions prefer the platform display name", async () => {
  const repository = {
    async getUserSession() {
      return { display_name: "平台昵称", github_name: "GitHub Name" };
    },
  };
  const wrapped = withGithubProfilePersistence(repository);
  const session = await wrapped.getUserSession("hash", "timestamp");
  assert.equal(session.github_name, "平台昵称");
  assert.equal(__test.preferPlatformDisplayName(null), null);
});

test("generic repository facade delegates authentication logic to the domain module", async () => {
  const content = await readFile(facadeUrl, "utf8");
  assert.match(content, /from "\.\/auth-repository\.js"/);
  assert.match(content, /export \{ authenticationRepository \}/);
  assert.doesNotMatch(content, /auth_tokens|consumeVerificationToken|createVerificationToken/);
});
