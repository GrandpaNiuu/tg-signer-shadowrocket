import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  __test,
  dialogMatchesFilter,
  normalizeSelectedTargets,
  parseSelectedTargets,
  serializeSelectedTargets,
} from "../src/realtime-multi-dialog-picker.js";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("realtime picker serializes arbitrary mixed conversations without breaking legacy values", () => {
  assert.deepEqual(parseSelectedTargets("*"), ["*"]);
  assert.deepEqual(parseSelectedTargets("@buyers,-1001234567890"), ["@buyers", "-1001234567890"]);
  assert.deepEqual(parseSelectedTargets('["@buyers","@support"]'), ["@buyers", "@support"]);
  assert.equal(serializeSelectedTargets(["@buyers"]), "@buyers");
  assert.equal(serializeSelectedTargets(["@buyers", "-1001234567890"]), "@buyers,-1001234567890");

  const manyTargets = Array.from({ length: 80 }, (_, index) => String(index + 1));
  assert.equal(normalizeSelectedTargets(manyTargets).length, 80);
});

test("wildcard is exclusive and concrete selections are deduplicated", () => {
  assert.deepEqual(normalizeSelectedTargets(["@Buyers", "@buyers", "-1001", "-1001"]), ["@Buyers", "-1001"]);
  assert.deepEqual(normalizeSelectedTargets(["@buyers", "*", "-1001"]), ["*"]);
});

test("monitoring filters never restrict cross-type selected conversations", () => {
  const monitor = __test.presentation("group_monitor");
  const selected = new Set(["11", "-10022", "@notice"]);
  const friend = { target: "11", peer_type: "private", title: "客户 A", is_writable: true };
  const group = { target: "-10022", peer_type: "supergroup", title: "采购群", is_writable: true };
  const channel = { target: "@notice", peer_type: "channel", title: "公告频道", is_writable: false };

  assert.equal(dialogMatchesFilter(friend, { config: monitor, typeFilter: "all", selected }), true);
  assert.equal(dialogMatchesFilter(group, { config: monitor, typeFilter: "all", selected }), true);
  assert.equal(dialogMatchesFilter(channel, { config: monitor, typeFilter: "all", selected }), true);

  assert.equal(dialogMatchesFilter(friend, { config: monitor, typeFilter: "selected", selected }), true);
  assert.equal(dialogMatchesFilter(group, { config: monitor, typeFilter: "selected", selected }), true);
  assert.equal(dialogMatchesFilter(channel, { config: monitor, typeFilter: "selected", selected }), true);

  assert.equal(dialogMatchesFilter(friend, { config: monitor, typeFilter: "private", selected }), true);
  assert.equal(dialogMatchesFilter(group, { config: monitor, typeFilter: "private", selected }), false);
});

test("automatic reply and monitoring presentations explain free mixed selection", () => {
  const reply = __test.presentation("keyword_reply");
  const monitor = __test.presentation("group_monitor");
  assert.match(reply.help, /自由组合多选/);
  assert.match(monitor.help, /任意混合多选/);
  assert.equal(reply.writableOnly, true);
  assert.equal(monitor.writableOnly, false);
  assert.equal(__test.dialogAllowed({ peer_type: "private", is_writable: true }, reply), true);
  assert.equal(__test.dialogAllowed({ peer_type: "channel", is_writable: false }, reply), false);
  assert.equal(__test.dialogAllowed({ peer_type: "channel", is_writable: false }, monitor), true);
});

test("picker uses one flat list with type filters and no bulk-select overflow action", async () => {
  const script = await source("src/realtime-multi-dialog-picker.js");
  const css = await source("assets/realtime-multi-dialog-picker.css");
  assert.match(script, /data-multi-filters/);
  assert.match(script, /类型按钮只用于筛选/);
  assert.doesNotMatch(script, /选择当前结果/);
  assert.doesNotMatch(script, /当前结果超过/);
  assert.match(css, /\.realtime-multi-filter/);
  assert.match(css, /\.realtime-multi-choice\[data-selected="true"\]/);
  assert.doesNotMatch(css, /\.realtime-multi-list fieldset/);
});

test("admin shell loads refreshed free-selection assets before the legacy picker", async () => {
  const index = await source("index.html");
  assert.match(index, /assets\/realtime-multi-dialog-picker\.css\?v=20260723-3/);
  assert.match(index, /src\/realtime-multi-dialog-picker\.js\?v=20260723-2/);
  const multi = index.indexOf("/src/realtime-multi-dialog-picker.js");
  const legacy = index.indexOf("/src/dialog-picker.js");
  assert.ok(multi >= 0 && legacy > multi);
});
