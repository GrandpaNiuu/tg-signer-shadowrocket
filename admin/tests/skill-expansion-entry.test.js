import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/skill-expansion-entry.js";

const indexUrl = new URL("../index.html", import.meta.url);
const sourceUrl = new URL("../src/skill-expansion-entry.js", import.meta.url);

test("only media sending receives a new task entry point", () => {
  assert.deepEqual([...__test.ACTIVE_SKILLS], ["send_media"]);
  for (const key of ["account_audit", "bot_flow", "chat_snapshot"]) {
    assert.equal(__test.RETIRED_SKILLS.has(key), true);
    assert.equal(__test.DEFINITIONS[key], undefined);
  }
});

test("the media card explains the actual task inputs and outcome", () => {
  const definition = __test.DEFINITIONS.send_media;
  assert.ok(definition.button.startsWith("创建"));
  assert.ok(definition.defaultName.length > 0);
  assert.match(definition.summary, /图片、文档或视频/);
  assert.match(definition.required, /执行账号、发送目标、源媒体消息、执行时间/);
  assert.match(definition.example, /每天/);
});

test("entry script retries route rendering instead of relying on one MutationObserver pass", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /retryPending/);
  assert.match(source, /OPEN_TIMEOUT_MS/);
  assert.match(source, /add\.click\(\)/);
  assert.match(source, /select\.dispatchEvent\(new Event\("change"/);
});

test("production page cache-busts the repaired media form scripts and styles", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /skill-expansion\.css\?v=20260722-3/);
  assert.match(index, /skill-expansion\.js\?v=20260722-3/);
  assert.match(index, /skill-expansion-entry\.js\?v=20260722-3/);
});
