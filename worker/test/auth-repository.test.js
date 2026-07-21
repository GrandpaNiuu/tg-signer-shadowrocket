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

test("authentication boundary remains optional for unrelated repositories", () => {
  const repository = { value: 1 };
  assert.equal(withEmailVerificationLifecycle(repository), repository);
  assert.equal(withGithubProfilePersistence(repository), repository);
  assert.throws(() => authenticationRepository(null), /Repository is unavailable/);
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
