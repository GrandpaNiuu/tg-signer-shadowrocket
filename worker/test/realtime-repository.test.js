import assert from "node:assert/strict";
import test from "node:test";

import { withInspectionDispatchGuard } from "../src/realtime-repository.js";

function repositoryWithInspection(active) {
  const calls = { reserve: 0, list: 0 };
  const repository = {
    db: {
      prepare() {
        return {
          bind() {
            return {
              async first() { return active ? { active: 1 } : null; },
            };
          },
        };
      },
    },
    async reserveNextDispatch(accountId) {
      calls.reserve += 1;
      return { id: `run-${accountId}` };
    },
    async listDispatchableAccountIds() {
      calls.list += 1;
      return ["account-1", "account-2"];
    },
  };
  return { repository, calls };
}

test("active inspection blocks reservation for the same Telegram account", async () => {
  const { repository, calls } = repositoryWithInspection(true);
  const guarded = withInspectionDispatchGuard(repository);
  assert.equal(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), null);
  assert.equal(calls.reserve, 0);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), []);
  assert.equal(calls.list, 1);
});

test("normal task dispatch continues when no inspection is active", async () => {
  const { repository, calls } = repositoryWithInspection(false);
  const guarded = withInspectionDispatchGuard(repository);
  assert.deepEqual(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), { id: "run-account-1" });
  assert.equal(calls.reserve, 1);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), ["account-1", "account-2"]);
});
