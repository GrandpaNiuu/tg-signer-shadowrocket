import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  __test,
  normalizeSelectedTargets,
  parseSelectedTargets,
  serializeSelectedTargets,
} from "../src/realtime-multi-dialog-picker.js";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("realtime picker serializes multiple conversations without breaking legacy values", () => {
  assert.deepEqual(parseSelectedTargets("*"), ["*"]);
  assert.deepEqual(parseSelectedTargets("@buyers,-1001234567890"), ["@buyers", "-1001234567890"]);
  assert.deepEqual(parseSelectedTargets('["@buyers","@support"]'), ["@buyers", "@support"]);
  assert.equal(serializeSelectedTargets(["@buyers"]), "@buyers");
  assert.equal(serializeSelectedTargets(["@buyers", "-1001234567890"]), "@buyers,-1001234567890");
});

test("wildcard is exclusive and concrete selections are deduplicated", () => {
  assert.deepEqual(normalizeSelectedTargets(["@Buyers", "@buyers", "-1001", "-1001"]), ["@Buyers", "-1001"]);
  assert.deepEqual(normalizeSelectedTargets(["@buyers", "*"]), ["*"]);
});

test("automatic reply and monitoring presentations both explain multi-selection", () => {
  const reply = __test.presentation("keyword_reply");
  const monitor = __test.presentation("group_monitor");
  assert.match(reply.help, /同时选择多个/);
  assert.match(monitor.help, /同时选择多个/);
  assert.equal(reply.writableOnly, true);
  assert.equal(monitor.writableOnly, false);
  assert.equal(__test.dialogAllowed({ peer_type: "private", is_writable: true }, reply), true);
  assert.equal(__test.dialogAllowed({ peer_type: "channel", is_writable: false }, reply), false);
  assert.equal(__test.dialogAllowed({ peer_type: "channel", is_writable: false }, monitor), true);
});

test("admin shell loads multi-picker before the legacy single picker", async () => {
  const index = await source("index.html");
  assert.match(index, /assets\/realtime-multi-dialog-picker\.css\?v=20260723-1/);
  assert.match(index, /src\/realtime-multi-dialog-picker\.js\?v=20260723-1/);
  const multi = index.indexOf("/src/realtime-multi-dialog-picker.js");
  const legacy = index.indexOf("/src/dialog-picker.js");
  assert.ok(multi >= 0 && legacy > multi);
});
