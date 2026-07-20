import assert from "node:assert/strict";
import test from "node:test";

import {
  adminWorkspaceRepository,
  authenticationRepository,
  runnerRepository,
  schedulerRepository,
} from "./src/repository-facade.js";

test("admin workspace access fails closed without user scoping", () => {
  assert.throws(
    () => adminWorkspaceRepository({}, { user_id: "user-1", role: "user" }),
    /User-scoped Repository is required/,
  );
});

test("admin workspace access scopes before applying dispatch behavior", async () => {
  const calls = [];
  const scoped = {
    async getAccounts() {
      calls.push("getAccounts");
      return [];
    },
  };
  const repository = {
    forUser(identity) {
      calls.push(["forUser", identity.user_id]);
      return scoped;
    },
  };

  const wrapped = adminWorkspaceRepository(repository, { user_id: "user-1", role: "user" });
  assert.deepEqual(await wrapped.getAccounts(), []);
  assert.deepEqual(calls, [["forUser", "user-1"], "getAccounts"]);
});

test("authentication facade preserves repositories without password login", () => {
  const repository = { getSettings() { return { ok: true }; } };
  assert.equal(authenticationRepository(repository), repository);
});

test("runner and scheduler facades retain ordinary Repository method binding", async () => {
  const repository = {
    value: "bound",
    async getSettings() {
      return this.value;
    },
  };

  assert.equal(await runnerRepository(repository).getSettings(), "bound");
  assert.equal(await schedulerRepository(repository).getSettings(), "bound");
});
