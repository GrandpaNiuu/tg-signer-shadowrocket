import test from "node:test";
import assert from "node:assert/strict";

import { cronFromSchedulePreset, schedulePresetFromCron } from "../src/schedule-presets.js";

test("daily schedules round-trip between friendly fields and legacy Cron", () => {
  assert.deepEqual(schedulePresetFromCron("15 8 * * *"), {
    mode: "daily",
    minute: 15,
    hour: 8,
  });
  assert.equal(cronFromSchedulePreset({ mode: "daily", minute: 15, hour: 8 }), "15 8 * * *");
});

test("weekly, hourly, and interval schedules use beginner-friendly modes", () => {
  assert.deepEqual(schedulePresetFromCron("30 9 * * 1"), {
    mode: "weekly",
    minute: 30,
    hour: 9,
    weekday: 1,
  });
  assert.deepEqual(schedulePresetFromCron("20 * * * *"), {
    mode: "hourly",
    minute: 20,
  });
  assert.deepEqual(schedulePresetFromCron("*/15 * * * *"), {
    mode: "interval",
    interval: 15,
  });
  assert.equal(cronFromSchedulePreset({ mode: "weekly", minute: 30, hour: 9, weekday: 1 }), "30 9 * * 1");
  assert.equal(cronFromSchedulePreset({ mode: "hourly", minute: 20 }), "20 * * * *");
  assert.equal(cronFromSchedulePreset({ mode: "interval", interval: 15 }), "*/15 * * * *");
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
