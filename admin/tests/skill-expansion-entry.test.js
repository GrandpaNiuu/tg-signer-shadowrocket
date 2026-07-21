import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/skill-expansion-entry.js";

const indexUrl = new URL("../index.html", import.meta.url);
const sourceUrl = new URL("../src/skill-expansion-entry.js", import.meta.url);

test("only usable expanded Skills receive creation entry points", () => {
  assert.deepEqual([...__test.ACTIVE_SKILLS].sort(), ["bot_flow", "chat_snapshot", "send_media"]);
  assert.equal(__test.RETIRED_SKILLS.has("account_audit"), true);
  assert.equal(__test.DEFINITIONS.account_audit, undefined);
});

test("each expanded Skill has concrete setup instructions and an example", () => {
  for (const key of __test.ACTIVE_SKILLS) {
    const definition = __test.DEFINITIONS[key];
    assert.ok(definition);
    assert.ok(definition.button.startsWith("创建"));
    assert.ok(definition.defaultName.length > 0);
    assert.ok(definition.summary.length > 10);
    assert.ok(definition.steps.length >= 4);
    assert.ok(definition.example.length > 10);
  }
});

test("entry script retries route rendering instead of relying on one MutationObserver pass", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /retryPending/);
  assert.match(source, /OPEN_TIMEOUT_MS/);
  assert.match(source, /add\.click\(\)/);
  assert.match(source, /select\.dispatchEvent\(new Event\("change"/);
});

test("production page cache-busts the repaired entry script and guidance styles", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /skill-expansion\.css\?v=20260722-2/);
  assert.match(index, /skill-expansion-entry\.js\?v=20260722-2/);
});
