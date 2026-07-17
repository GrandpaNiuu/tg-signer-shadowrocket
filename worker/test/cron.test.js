import assert from "node:assert/strict";
import test from "node:test";

import { assertCron, cronMatches, nextCronDate } from "../src/cron.js";

test("timezone-aware cron computes midnight Beijing from UTC", () => {
  const next = nextCronDate("0 0 * * *", "Asia/Shanghai", new Date("2026-07-18T15:59:10.000Z"));
  assert.equal(next.toISOString(), "2026-07-18T16:00:00.000Z");
});

test("cron supports lists, ranges, and steps", () => {
  assert.equal(cronMatches("*/15 9-10 * * 1,3,5", "UTC", new Date("2026-07-17T09:30:00.000Z")), true);
  assert.equal(cronMatches("*/15 9-10 * * 1,3,5", "UTC", new Date("2026-07-18T09:30:00.000Z")), false);
});

test("cron validation rejects malformed or out-of-range expressions", () => {
  assert.throws(() => assertCron("0 0 * *"), /five fields/);
  assert.throws(() => assertCron("61 0 * * *"), /minute/);
  assert.throws(() => assertCron("* * * * *", "Not/AZone"), /timezone/);
});
