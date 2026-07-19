import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskTransferError,
  buildTaskExport,
  copyTaskDraft,
  parseTaskImport,
} from "../src/task-transfer.js";

const account = { id: "account-1", name: "主账号", session: "never-export-this" };
const skill = { key: "send_text", enabled: true };
const task = {
  id: "task-private-id",
  user_id: "user-private-id",
  name: "每日签到",
  account_id: account.id,
  account_name: account.name,
  skill_key: "send_text",
  bot: "@checkin_bot",
  command: "/checkin",
  cron: "15 8 * * *",
  timezone: "Asia/Shanghai",
  retry: 1,
  timeout_seconds: 120,
  thread_id: null,
  delete_after_seconds: null,
  enabled: true,
  tg_signer_import: "never-export-this-either",
  has_tg_signer_import: true,
};

test("exports portable task configuration without ids or secrets", () => {
  const document = buildTaskExport([task], [account], {
    now: () => new Date("2026-07-19T08:00:00.000Z"),
  });

  assert.deepEqual(document, {
    format: "telegram-checkin-tasks",
    version: 1,
    exported_at: "2026-07-19T08:00:00.000Z",
    tasks: [{
      name: "每日签到",
      account_ref: "account-1",
      source_account_id: "account-1",
      account_name: "主账号",
      skill_key: "send_text",
      bot: "@checkin_bot",
      command: "/checkin",
      cron: "15 8 * * *",
      timezone: "Asia/Shanghai",
      retry: 1,
      timeout_seconds: 120,
      thread_id: null,
      delete_after_seconds: null,
      enabled: true,
    }],
  });
  const serialized = JSON.stringify(document);
  assert.doesNotMatch(serialized, /private-id|never-export-this/);
});

test("imports by portable account name and skill key, always disabled", () => {
  const document = buildTaskExport([task], [account]);
  const result = parseTaskImport(JSON.stringify(document), {
    accounts: [account],
    skills: [skill],
  });

  assert.deepEqual(result.tasks, [{
    name: "每日签到",
    account_id: "account-1",
    skill_key: "send_text",
    bot: "@checkin_bot",
    command: "/checkin",
    cron: "15 8 * * *",
    timezone: "Asia/Shanghai",
    retry: 1,
    timeout_seconds: 120,
    thread_id: null,
    delete_after_seconds: null,
    enabled: false,
  }]);
  assert.match(result.warnings.join(" "), /默认停用/);
});

test("rejects unknown accounts, skills, and formats", () => {
  const document = buildTaskExport([task], [account]);
  assert.throws(
    () => parseTaskImport(document, { accounts: [], skills: [skill] }),
    (error) => error instanceof TaskTransferError && /账号/.test(error.message),
  );
  assert.throws(
    () => parseTaskImport(document, { accounts: [account], skills: [] }),
    (error) => error instanceof TaskTransferError && /Skill/.test(error.message),
  );
  assert.throws(
    () => parseTaskImport({ ...document, format: "something-else" }, { accounts: [account], skills: [skill] }),
    TaskTransferError,
  );
});

test("more than 100 tasks round-trip and duplicate account names can be explicitly mapped", () => {
  const manyTasks = Array.from({ length: 101 }, (_, index) => ({
    ...task,
    id: `task-${index}`,
    name: `任务 ${index + 1}`,
  }));
  const document = buildTaskExport(manyTasks, [account]);
  assert.equal(parseTaskImport(document, { accounts: [account], skills: [skill] }).tasks.length, 101);

  const foreignDocument = structuredClone(document);
  foreignDocument.tasks[0].source_account_id = "another-workspace-account";
  const duplicateAccounts = [
    { id: "local-1", name: "主账号" },
    { id: "local-2", name: "主账号" },
  ];
  let mappingError;
  try {
    parseTaskImport({ ...foreignDocument, tasks: [foreignDocument.tasks[0]] }, {
      accounts: duplicateAccounts,
      skills: [skill],
    });
  } catch (error) {
    mappingError = error;
  }
  assert.equal(mappingError instanceof TaskTransferError, true);
  assert.deepEqual(mappingError.unresolvedAccounts, [{ account_ref: "account-1", account_name: "主账号" }]);
  const mapped = parseTaskImport({ ...foreignDocument, tasks: [foreignDocument.tasks[0]] }, {
    accounts: duplicateAccounts,
    skills: [skill],
    accountMapping: { "account-1": "local-2" },
  });
  assert.equal(mapped.tasks[0].account_id, "local-2");
});

test("application-generated exports larger than 1 MB still round-trip", () => {
  const largeTasks = Array.from({ length: 600 }, (_, index) => ({
    ...task,
    id: `large-task-${index}`,
    name: `大任务 ${index + 1}`,
    command: `/${"x".repeat(1_998)}`,
  }));
  const serialized = JSON.stringify(buildTaskExport(largeTasks, [account]));
  assert.ok(new TextEncoder().encode(serialized).length > 1_000_000);
  assert.equal(parseTaskImport(serialized, { accounts: [account], skills: [skill] }).tasks.length, 600);
});

test("task copies never inherit ids or tg_signer secrets and start disabled", () => {
  const draft = copyTaskDraft({ ...task, skill_key: "tg_signer" });
  assert.equal(draft.name, "每日签到（副本）");
  assert.equal(draft.enabled, false);
  assert.equal(draft.has_tg_signer_import, false);
  assert.equal(Object.hasOwn(draft, "id"), false);
  assert.equal(Object.hasOwn(draft, "tg_signer_import"), false);
});
