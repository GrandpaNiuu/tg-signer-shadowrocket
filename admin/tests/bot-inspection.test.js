import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assetUrl = new URL("../src/bot-inspection.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);
const workerUrl = new URL("../../worker/src/realtime-automation.js", import.meta.url);

test("bot inspection is mounted in the common task form for every workspace role", async () => {
  const source = await readFile(assetUrl, "utf8");
  assert.match(source, /#task-form/);
  assert.match(source, /#task-command/);
  assert.match(source, /普通用户和管理员都可使用/);
  assert.match(source, /data-bot-inspection-controls/);
  assert.doesNotMatch(source, /isAdministrator|data-admin-only/);
  assert.doesNotMatch(source, /querySelector\("\[data-guided-signin-builder\]"\)/);
});

test("inspection can switch the draft to button sign-in and fill the detected button", async () => {
  const source = await readFile(assetUrl, "utf8");
  assert.match(source, /item\.value === "tg_signer"/);
  assert.match(source, /select\.dispatchEvent\(new Event\("change"/);
  assert.match(source, /#guided-button-text/);
  assert.match(source, /suggested_button_text/);
  assert.match(source, /\/api\/v1\/bot-inspections/);
});

test("the production admin shell loads the universal inspection asset after task guidance", async () => {
  const html = await readFile(indexUrl, "utf8");
  const guidance = html.indexOf("/src/skill-guidance.js");
  const realtime = html.indexOf("/src/realtime-automation.js");
  const inspection = html.indexOf("/src/bot-inspection.js");
  assert.ok(guidance > 0 && realtime > guidance && inspection > realtime);
});

test("Worker inspection creation remains user-scoped and is not administrator-only", async () => {
  const source = await readFile(workerUrl, "utf8");
  const creationStart = source.indexOf("async function createInspection");
  const creationEnd = source.indexOf("async function inspections", creationStart);
  const creation = source.slice(creationStart, creationEnd);
  assert.match(creation, /context\.identity\?\.user_id \|\| repository\.userId/);
  assert.match(creation, /ownedConnectedAccount\(repository, userId, accountId\)/);
  assert.doesNotMatch(creation, /requireAdministrator/);

  const workspaceStart = source.indexOf("export async function handleWorkspaceRealtimeApi");
  const workspaceEnd = source.indexOf("async function digest", workspaceStart);
  const workspace = source.slice(workspaceStart, workspaceEnd);
  assert.ok(workspace.indexOf("inspections(request") < workspace.indexOf('context.identity?.role !== "admin"'));
});
