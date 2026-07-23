import assert from "node:assert/strict";
import test from "node:test";

import {
  __test,
  normalizeRealtimeSelectors,
  parseRealtimeSelectors,
} from "../src/realtime-multi-selector-api.js";

test("realtime selectors keep wildcard and legacy single targets compatible", () => {
  assert.equal(normalizeRealtimeSelectors("*"), "*");
  assert.equal(normalizeRealtimeSelectors("@buyers"), "@buyers");
  assert.equal(normalizeRealtimeSelectors("-1001234567890"), "-1001234567890");
});

test("realtime selectors accept arrays, JSON and comma separated values", () => {
  assert.equal(
    normalizeRealtimeSelectors(["@buyers", "-1001234567890", "@support"]),
    "@buyers,-1001234567890,@support",
  );
  assert.equal(
    normalizeRealtimeSelectors('["@buyers","-1001234567890"]'),
    "@buyers,-1001234567890",
  );
  assert.equal(
    normalizeRealtimeSelectors("@buyers, -1001234567890\n@support"),
    "@buyers,-1001234567890,@support",
  );
  assert.deepEqual(parseRealtimeSelectors("@buyers,-1001234567890"), ["@buyers", "-1001234567890"]);
});

test("realtime selectors deduplicate usernames without changing the first value", () => {
  assert.equal(normalizeRealtimeSelectors(["@Buyers", "@buyers", "-1001", "-1001"]), "@Buyers,-1001");
});

test("wildcard cannot be mixed with concrete conversations", () => {
  assert.throws(
    () => normalizeRealtimeSelectors(["*", "@buyers"]),
    (error) => error?.status === 422 && error?.code === "validation_failed",
  );
});

test("realtime rules accept more than fifty freely mixed selectors", () => {
  const targets = Array.from({ length: 80 }, (_, index) => String(index + 1));
  const normalized = normalizeRealtimeSelectors(targets);
  assert.equal(normalized.split(",").length, 80);
});

test("realtime rules are limited by safe serialized payload size instead of category or count", () => {
  const targets = Array.from({ length: 2_000 }, (_, index) => `1${String(index).padStart(19, "0")}`);
  assert.throws(
    () => normalizeRealtimeSelectors(targets),
    (error) => error?.status === 422
      && error?.code === "validation_failed"
      && error?.message.includes("内容过长"),
  );
  assert.equal(__test.MAX_SERIALIZED_LENGTH, 32_000);
});
