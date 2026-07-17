import test from "node:test";
import assert from "node:assert/strict";
import { createStore, filterRows, listFrom, routeFromHash } from "../src/state.js";

test("normalizes unknown routes to dashboard", () => {
  assert.equal(routeFromHash("#/accounts"), "accounts");
  assert.equal(routeFromHash("#/runs?id=1"), "runs");
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
