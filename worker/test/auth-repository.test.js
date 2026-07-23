import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authenticationRepository,
  withEmailRegistrationUniqueness,
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

test("authentication boundary remains optional for unrelated repositories", () => {
  const repository = { value: 1 };
  assert.equal(withEmailVerificationLifecycle(repository), repository);
  assert.equal(withEmailRegistrationUniqueness(repository), repository);
  assert.equal(withGithubProfilePersistence(repository), repository);
  assert.throws(() => authenticationRepository(null), /Repository is unavailable/);
});

test("secure registration rejects an existing unverified account without replacing its password", async () => {
  let registrationCalls = 0;
  const repository = {
    async getUserByEmail() {
      return {
        id: "user-pending",
        status: "pending",
        email_verified_at: null,
      };
    },
    async createOrUpdatePendingEmailUser() {
      registrationCalls += 1;
      return null;
    },
  };
  const wrapped = withEmailRegistrationUniqueness(repository);
  await assert.rejects(() => wrapped.createOrUpdatePendingEmailUser({
    email_normalized: "user@example.com",
  }, { password_hash: "replacement" }), (error) => error?.status === 409
    && error?.code === "account_pending_verification"
    && /不能重复注册/.test(error?.message));
  assert.equal(registrationCalls, 0);
});

test("secure registration reports an already verified account as existing", async () => {
  const repository = {
    async getUserByEmail() {
      return {
        id: "user-active",
        status: "active",
        email_verified_at: "2026-07-23T00:00:00.000Z",
      };
    },
    async createOrUpdatePendingEmailUser() {
      throw new Error("must not be called");
    },
  };
  const wrapped = withEmailRegistrationUniqueness(repository);
  await assert.rejects(() => wrapped.createOrUpdatePendingEmailUser({
    email_normalized: "user@example.com",
  }, {}), (error) => error?.status === 409
    && error?.code === "account_exists"
    && /直接登录/.test(error?.message));
});

test("secure registration delegates exactly once for a new email", async () => {
  let registrationCalls = 0;
  const expected = { user: { id: "user-new" }, verification_required: true };
  const repository = {
    async getUserByEmail() { return null; },
    async createOrUpdatePendingEmailUser(user) {
      registrationCalls += 1;
      assert.equal(user.email_normalized, "new@example.com");
      return expected;
    },
  };
  const wrapped = withEmailRegistrationUniqueness(repository);
  assert.equal(await wrapped.createOrUpdatePendingEmailUser({
    email_normalized: "new@example.com",
  }, {}), expected);
  assert.equal(registrationCalls, 1);
});

test("GitHub login preserves an existing custom display name", async () => {
  let stored = {
    id: "legacy-admin",
    display_name: "自定义管理员",
    github_login: "GrandpaNiuu",
    github_name: "Original GitHub Name",
  };
  const repository = {
    db: {
      prepare(sql) {
        assert.match(sql, /UPDATE users SET display_name = \?, github_name = \?/);
        return {
          bind(displayName, githubName, timestamp, id) {
            return {
              async run() {
                stored = { ...stored, id, display_name: displayName, github_name: githubName, updated_at: timestamp };
              },
            };
          },
        };
      },
    },
    async getUser() { return { ...stored }; },
    async getUserByGithubId() { return { ...stored }; },
    async upsertGithubUser(input) {
      stored = {
        ...stored,
        display_name: input.github_name,
        github_name: input.github_name,
        github_login: input.github_login || stored.github_login,
      };
      return { ...stored };
    },
  };
  const wrapped = withGithubProfilePersistence(repository);
  const result = await wrapped.upsertGithubUser({
    is_admin: true,
    github_user_id: "123",
    github_login: "GrandpaNiuu",
    github_name: "New GitHub Name",
    timestamp: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(result.display_name, "自定义管理员");
  assert.equal(result.github_name, "自定义管理员");
  assert.equal(stored.display_name, "自定义管理员");
});

test("GitHub login does not treat provider names as custom profile names", () => {
  assert.equal(__test.customGithubDisplayName({
    display_name: "GrandpaNiuu",
    github_login: "GrandpaNiuu",
    github_name: "Grandpa Niu",
  }), "");
  assert.equal(__test.customGithubDisplayName({
    display_name: "Grandpa Niu",
    github_login: "GrandpaNiuu",
    github_name: "Grandpa Niu",
  }), "");
  assert.equal(__test.customGithubDisplayName({
    display_name: "GrandpaNiuu",
    github_login: null,
    github_name: null,
  }, {
    github_login: "GrandpaNiuu",
    github_name: "Grandpa Niu",
  }), "");
  assert.equal(__test.customGithubDisplayName({
    display_name: "平台昵称",
    github_login: "GrandpaNiuu",
    github_name: "Grandpa Niu",
  }, {
    github_login: "GrandpaNiuu",
    github_name: "Updated GitHub Name",
  }), "平台昵称");
});

test("generic repository facade delegates authentication logic to the domain module", async () => {
  const content = await readFile(facadeUrl, "utf8");
  assert.match(content, /from "\.\/auth-repository\.js"/);
  assert.match(content, /export \{ authenticationRepository \}/);
  assert.doesNotMatch(content, /auth_tokens|consumeVerificationToken|createVerificationToken/);
});
