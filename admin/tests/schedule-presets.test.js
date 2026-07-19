import test from "node:test";
import assert from "node:assert/strict";

import { cronFromSchedulePreset, schedulePresetFromCron } from "../src/schedule-presets.js";

test("daily schedules round-trip between friendly fields and legacy Cron", () => {
  assert.deepEqual(schedulePresetFromCron("15 8 * * *"), {
    mode: "daily",
    second: 0,
    minute: 15,
    hour: 8,
  });
  assert.equal(cronFromSchedulePreset({ mode: "daily", second: 9, minute: 15, hour: 8 }), "9 15 8 * * *");
});

test("weekly, hourly, and interval schedules use beginner-friendly modes", () => {
  assert.deepEqual(schedulePresetFromCron("30 9 * * 1"), {
    mode: "weekly",
    second: 0,
    minute: 30,
    hour: 9,
    weekday: 1,
  });
  assert.deepEqual(schedulePresetFromCron("20 * * * *"), {
    mode: "hourly",
    second: 0,
    minute: 20,
  });
  assert.deepEqual(schedulePresetFromCron("*/15 * * * *"), {
    mode: "interval",
    second: 0,
    interval: 15,
  });
  assert.equal(cronFromSchedulePreset({ mode: "weekly", second: 7, minute: 30, hour: 9, weekday: 1 }), "7 30 9 * * 1");
  assert.equal(cronFromSchedulePreset({ mode: "hourly", second: 7, minute: 20 }), "7 20 * * * *");
  assert.equal(cronFromSchedulePreset({ mode: "interval", second: 7, interval: 15 }), "7 */15 * * * *");
});

test("recognizes six-field friendly schedules", () => {
  assert.deepEqual(schedulePresetFromCron("42 15 8 * * *"), {
    mode: "daily",
    second: 42,
    minute: 15,
    hour: 8,
  });
});

test("advanced Cron remains editable and friendly fields reject invalid times", () => {
  assert.deepEqual(schedulePresetFromCron("5 8,20 * * 1-5"), {
    mode: "custom",
    cron: "5 8,20 * * 1-5",
  });
  assert.equal(cronFromSchedulePreset({ mode: "custom", cron: "5 8,20 * * 1-5" }), "5 8,20 * * 1-5");
  assert.throws(() => cronFromSchedulePreset({ mode: "daily", minute: 60, hour: 8 }), RangeError);
  assert.throws(() => cronFromSchedulePreset({ mode: "weekly", minute: 0, hour: 8, weekday: 7 }), RangeError);
});
