import assert from "node:assert/strict";
import test from "node:test";

import { statusText } from "../src/format.js";

test("reconnect_required is shown as an explicit re-login state", () => {
  assert.equal(statusText("reconnect_required"), "需要重新登录");
});

test("the early needs_reauth name remains readable for compatibility", () => {
  assert.equal(statusText("needs_reauth"), "需要重新登录");
});

test("login_pending remains distinct from reconnect_required", () => {
  assert.equal(statusText("login_pending"), "登录中");
  assert.notEqual(statusText("login_pending"), statusText("reconnect_required"));
});
