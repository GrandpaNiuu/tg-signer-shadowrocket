import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  filterRows,
  identityDisplayName,
  listFrom,
  needsTelegramApplicationSetup,
  routeFromHash,
} from "../src/state.js";

test("uses the GitHub login when an account has no public profile name", () => {
  assert.equal(identityDisplayName({ name: null, login: "GrandpaNiuu", role: "admin" }), "GrandpaNiuu");
  assert.equal(identityDisplayName({ name: "  Grandpa Niu  ", login: "GrandpaNiuu" }), "Grandpa Niu");
  assert.equal(identityDisplayName({ role: "admin" }), "管理员");
  assert.equal(identityDisplayName({ role: "user" }), "用户");
});

test("normalizes unknown routes to dashboard", () => {
  assert.equal(routeFromHash("#/accounts"), "accounts");
  assert.equal(routeFromHash("#/runs?id=1"), "runs");
  assert.equal(routeFromHash("#/users"), "users");
  assert.equal(routeFromHash("#/not-a-page"), "dashboard");
});

test("store notifies subscribers and keeps state in memory", () => {
  const store = createStore({ route: "tasks" });
  let seen;
  const unsubscribe = store.subscribe((state) => { seen = state.route; });
  store.set({ route: "runs" });
  assert.equal(seen, "runs");
  assert.equal(store.get().route, "runs");
  unsubscribe();
});

test("extracts collection envelopes and filters rows", () => {
  const rows = [{ id: 1, name: "主账号", status: "connected" }, { id: 2, name: "备用", status: "pending" }];
  assert.deepEqual(listFrom({ accounts: rows }, ["accounts"]), rows);
  assert.deepEqual(filterRows(rows, { query: "主", status: "connected" }), [rows[0]]);
  assert.deepEqual(filterRows(rows, { status: "failed" }), []);
});

test("requires one-time Telegram application setup before phone login", () => {
  assert.equal(needsTelegramApplicationSetup({}), true);
  assert.equal(needsTelegramApplicationSetup({ telegram_application_source: "missing" }), true);
  assert.equal(needsTelegramApplicationSetup({ telegram_application_configured: false }), true);
  assert.equal(needsTelegramApplicationSetup({ telegram_application_configured: true }), false);
  assert.equal(needsTelegramApplicationSetup({ telegram_application_source: "global" }), false);
  assert.equal(needsTelegramApplicationSetup({ telegram_application_source: "legacy_account" }), false);
});
