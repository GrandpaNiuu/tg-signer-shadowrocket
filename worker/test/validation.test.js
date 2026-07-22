import assert from "node:assert/strict";
import test from "node:test";

import { settingsInput, taskInput, validateTaskRuntime } from "../src/validation.js";

function task(overrides = {}) {
  return taskInput({
    name: "Check in",
    account_id: "account-1",
    skill_key: "send_text",
    bot: "@example_bot",
    command: "/checkin",
    cron: "0 * * * *",
    retry: 1,
    timeout_seconds: 120,
    ...overrides,
  });
}

test("task runtime budget fits the 25-minute workflow including wait and callback overhead", () => {
  assert.doesNotThrow(() => validateTaskRuntime(task({ retry: 0, timeout_seconds: 900 })));
  assert.throws(
    () => validateTaskRuntime(task({ retry: 5, timeout_seconds: 900 })),
    (error) => error.status === 422
      && error.details.fields.includes("retry")
      && error.details.fields.includes("timeout_seconds"),
  );
});

test("retired legacy scheduler mode cannot be written back", () => {
  assert.deepEqual(settingsInput({ values: { scheduler_mode: "d1" } }), { scheduler_mode: "d1" });
  assert.deepEqual(
    settingsInput({ values: { notifications_enabled: false } }),
    { notifications_enabled: true },
  );
  assert.throws(
    () => settingsInput({ values: { scheduler_mode: "legacy" } }),
    (error) => error.status === 422 && error.details.fields.includes("values.scheduler_mode"),
  );
});

test("send_text delete-after leaves a ten-second callback safety margin", () => {
  assert.doesNotThrow(() => validateTaskRuntime(task({ timeout_seconds: 120, delete_after_seconds: 109 })));
  assert.throws(
    () => validateTaskRuntime(task({ timeout_seconds: 120, delete_after_seconds: 110 })),
    (error) => error.status === 422 && error.details.fields.includes("delete_after_seconds"),
  );
});

test("tg_signer import is accepted only for tg_signer and null can clear it", () => {
  const signer = task({ skill_key: "tg_signer", tg_signer_import: "eyJ0YXNrIjp7fX0=" });
  assert.doesNotThrow(() => validateTaskRuntime(signer));
  assert.throws(
    () => validateTaskRuntime(task({ tg_signer_import: "secret-import" })),
    (error) => error.status === 422 && error.details.fields.includes("tg_signer_import"),
  );
  assert.doesNotThrow(() => validateTaskRuntime(task({ tg_signer_import: null })));
});
