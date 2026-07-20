import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { refreshDelayForRoute } from "../src/live-refresh.js";

test("dashboard and execution records continue polling for scheduled runs", () => {
  assert.equal(refreshDelayForRoute("accounts", []), 60_000);
  assert.equal(refreshDelayForRoute("runs", [{ status: "running" }]), 3_000);
  assert.equal(refreshDelayForRoute("runs", [{ status: "success" }]), 20_000);
  assert.equal(refreshDelayForRoute("runs", []), 20_000);
  assert.equal(refreshDelayForRoute("dashboard", []), 20_000);
  assert.equal(refreshDelayForRoute("accounts", [], { blocked: true }), 0);
  assert.equal(refreshDelayForRoute("dashboard", [], { blocked: true }), 0);
});

test("unchanged Telegram login polling preserves the open modal DOM", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function renderLoginFlow");
  const end = app.indexOf("async function pollLoginFlow", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const loginFlow = app.slice(start, end);

  assert.match(loginFlow, /loginFlowRenderKey\(flow\)/);
  assert.match(loginFlow, /modalRoot\.dataset\.loginFlowRenderKey === renderKey/);
  assert.match(loginFlow, /scheduleLoginPoll\(id\);\s*return;/);
});
