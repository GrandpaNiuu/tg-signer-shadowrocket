import assert from "node:assert/strict";
import test from "node:test";

import { findEvidence, validateTakeoverEvidence } from "./d1-takeover-audit.mjs";

function validEvidence(overrides = {}) {
  return {
    account_count: 2,
    connected_account_count: 1,
    connected_session_account_count: 1,
    task_count: 3,
    successful_run_count: 4,
    ...overrides,
  };
}

test("findEvidence locates the inventory row in Wrangler JSON output", () => {
  const row = validEvidence();
  assert.equal(findEvidence([{ results: [{ meta: {}, results: [row] }] }]), row);
});

test("valid takeover evidence returns only normalized counts", () => {
  assert.deepEqual(validateTakeoverEvidence({ result: validEvidence() }), validEvidence());
});

test("empty fresh-install inventory is rejected only by legacy takeover validation", () => {
  assert.throws(
    () => validateTakeoverEvidence(validEvidence({
      account_count: 0,
      connected_account_count: 0,
      connected_session_account_count: 0,
      task_count: 0,
      successful_run_count: 0,
    })),
    /no connected migrated Telegram account/,
  );
});

test("a connected account without an encrypted Session blocks takeover", () => {
  assert.throws(
    () => validateTakeoverEvidence(validEvidence({ connected_session_account_count: 0 })),
    /no encrypted Session record/,
  );
});

test("takeover requires a migrated task and successful Runner canary", () => {
  assert.throws(
    () => validateTakeoverEvidence(validEvidence({ successful_run_count: 0 })),
    /successful D1 Runner canary/,
  );
});

test("missing or malformed inventory fields are rejected", () => {
  assert.throws(() => validateTakeoverEvidence({ result: { account_count: 1 } }), /complete inventory row/);
  assert.throws(
    () => validateTakeoverEvidence(validEvidence({ task_count: "not-a-number" })),
    /invalid task_count/,
  );
  assert.throws(
    () => validateTakeoverEvidence(validEvidence({ account_count: -1 })),
    /invalid account_count/,
  );
});
