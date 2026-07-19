import test from "node:test";
import assert from "node:assert/strict";

import { refreshDelayForRoute } from "../src/live-refresh.js";

test("account health refreshes periodically while active runs refresh quickly", () => {
  assert.equal(refreshDelayForRoute("accounts", []), 60_000);
  assert.equal(refreshDelayForRoute("runs", [{ status: "running" }]), 3_000);
  assert.equal(refreshDelayForRoute("runs", [{ status: "success" }]), 30_000);
  assert.equal(refreshDelayForRoute("runs", []), 30_000);
  assert.equal(refreshDelayForRoute("dashboard", []), 0);
  assert.equal(refreshDelayForRoute("accounts", [], { blocked: true }), 0);
});
