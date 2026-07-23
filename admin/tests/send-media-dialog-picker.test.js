import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/send-media-dialog-picker.js";

const indexUrl = new URL("../index.html", import.meta.url);
const sourceUrl = new URL("../src/send-media-dialog-picker.js", import.meta.url);

test("send-media picker targets the expanded content destination field", () => {
  assert.equal(__test.FORM_SELECTOR, "#task-form");
  assert.equal(__test.ACCOUNT_SELECTOR, "#task-account");
  assert.equal(__test.SKILL_SELECTOR, "#task-skill");
  assert.equal(__test.LEGACY_TARGET_SELECTOR, "#task-bot");
  assert.equal(__test.EXPANDED_TARGET_SELECTOR, '[data-skill-field="target"]');
  assert.equal(__test.LEGACY_PICKER_SELECTOR, '[data-dialog-picker="#task-bot"]');
});

test("admin loads the send-media bridge after the general dialog picker", async () => {
  const html = await readFile(indexUrl, "utf8");
  const picker = html.indexOf("/src/dialog-picker.js");
  const bridge = html.indexOf("/src/send-media-dialog-picker.js");
  assert.ok(picker >= 0);
  assert.ok(bridge > picker);
});

test("bridge moves the existing picker and mirrors values into expanded params", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /skill\.value === "send_media"/);
  assert.match(source, /expandedTarget\.type = "hidden"/);
  assert.match(source, /expandedField\.append\(picker\)/);
  assert.match(source, /dispatchValue\(current, legacyTarget\.value\)/);
  assert.match(source, /dispatchValue\(legacyTarget, expandedTarget\.value\)/);
});
