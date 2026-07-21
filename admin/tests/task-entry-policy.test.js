import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policyUrl = new URL("../src/task-entry-policy.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("task management hides direct creation and routes users to the Skill catalog", async () => {
  const source = await readFile(policyUrl, "utf8");
  assert.match(source, /\[data-action=\"add-task\"\]/);
  assert.match(source, /button\.hidden = true/);
  assert.match(source, /href = \"#\/skills\"/);
  assert.match(source, /选择任务类型/);
  assert.match(source, /新增功能统一从“任务类型”开始/);
});

test("the production shell loads the task entry policy after the Skill hub", async () => {
  const html = await readFile(indexUrl, "utf8");
  const hub = html.indexOf("/src/automation-skill-hub.js");
  const policy = html.indexOf("/src/task-entry-policy.js");
  assert.ok(hub > 0 && policy > hub);
});
