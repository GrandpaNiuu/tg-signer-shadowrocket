import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { __test, handleWorkspaceRealtimeApi } from "../src/realtime-automation.js";

const migrationUrl = new URL("../migrations/0100_realtime_automation.sql", import.meta.url);
const appUrl = new URL("../src/app.js", import.meta.url);
const apiUrl = new URL("../src/realtime-automation.js", import.meta.url);
const repositoryUrl = new URL("../src/realtime-repository.js", import.meta.url);
const facadeUrl = new URL("../src/repository-facade.js", import.meta.url);
const taskApiUrl = new URL("../src/listener-task-api.js", import.meta.url);

function isBlockingRun(run) {
  return ["claimed", "running"].includes(run.status)
    || (run.status === "queued" && ["dispatching", "dispatched"].includes(run.dispatch_status));
}

function realtimeRuleRepository({ taskRuns = [], rule = null } = {}) {
  let storedRule = rule ? { ...rule } : null;
  const sql = [];
  const account = {
    id: "account-1",
    user_id: "admin-1",
    name: "管理员账号",
    status: "connected",
    enabled: 1,
    session_secret_id: "session-secret",
  };
  return {
    userId: "admin-1",
    sql,
    get rule() { return storedRule; },
    db: {
      prepare(statement) {
        const source = String(statement);
        sql.push(source);
        return {
          bind(...bindings) {
            return {
              async first() {
                if (source.includes("FROM accounts WHERE id = ?")) return account;
                if (source.includes("FROM task_runs r")) return taskRuns.find(isBlockingRun) || null;
                if (source.includes("SELECT * FROM realtime_rules WHERE id = ?")) return storedRule;
                if (source.includes("SELECT r.*, a.name AS account_name FROM realtime_rules r")) {
                  return storedRule ? { ...storedRule, account_name: account.name } : null;
                }
                return null;
              },
              async run() {
                if (source.includes("INSERT INTO realtime_rules")) {
                  const [id, userId, accountId, kind, name, chatSelector, keyword, responseText,
                    caseSensitive, enabled, createdAt, updatedAt] = bindings;
                  storedRule = {
                    id,
                    user_id: userId,
                    account_id: accountId,
                    kind,
                    name,
                    chat_selector: chatSelector,
                    keyword,
                    response_text: responseText,
                    case_sensitive: caseSensitive,
                    enabled,
                    created_at: createdAt,
                    updated_at: updatedAt,
                    last_event_at: null,
                  };
                }
                if (source.includes("UPDATE realtime_rules SET account_id")) {
                  const [accountId, kind, name, chatSelector, keyword, responseText,
                    caseSensitive, enabled, updatedAt] = bindings;
                  storedRule = {
                    ...storedRule,
                    account_id: accountId,
                    kind,
                    name,
                    chat_selector: chatSelector,
                    keyword,
                    response_text: responseText,
                    case_sensitive: caseSensitive,
                    enabled,
                    updated_at: updatedAt,
                  };
                }
                return { meta: { changes: 1 } };
              },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    },
  };
}

function realtimeContext() {
  return {
    identity: { user_id: "admin-1", role: "admin" },
    uuid: () => "rule-1",
    now: () => new Date("2026-07-22T04:00:00.000Z"),
  };
}

function createRuleRequest(enabled = true) {
  return new Request("https://worker.example/api/v1/admin/realtime-rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account_id: "account-1",
      kind: "keyword_reply",
      name: "客服回复",
      chat_selector: "*",
      keyword: "价格",
      response_text: "请联系管理员。",
      enabled,
    }),
  });
}

test("Telegram targets accept usernames and numeric ids but wildcard is admin-only", () => {
  assert.equal(__test.normalizeTelegramTarget("@example_bot"), "@example_bot");
  assert.equal(__test.normalizeTelegramTarget("-1001234567890"), "-1001234567890");
  assert.throws(() => __test.normalizeTelegramTarget("*"), /@用户名/);
  assert.equal(__test.normalizeTelegramTarget("*", "chat_selector", { allowWildcard: true }), "*");
  assert.throws(() => __test.normalizeTelegramTarget("https://example.com"), /@用户名/);
});

test("keyword replies require both a keyword and fixed response", () => {
  assert.deepEqual(__test.ruleInput({
    account_id: "account-1",
    kind: "keyword_reply",
    name: "客服回复",
    chat_selector: "*",
    keyword: "价格",
    response_text: "请联系管理员。",
    enabled: true,
  }), {
    account_id: "account-1",
    kind: "keyword_reply",
    name: "客服回复",
    chat_selector: "*",
    keyword: "价格",
    response_text: "请联系管理员。",
    case_sensitive: false,
    enabled: true,
  });
  assert.throws(() => __test.ruleInput({
    account_id: "account-1",
    kind: "keyword_reply",
    name: "错误规则",
    chat_selector: "*",
    keyword: "",
    response_text: "回复",
  }), /必须填写关键词/);
  assert.throws(() => __test.ruleInput({
    account_id: "account-1",
    kind: "keyword_reply",
    name: "错误规则",
    chat_selector: "*",
    keyword: "价格",
    response_text: "",
  }), /必须填写回复内容/);
});

test("ordinary scheduled tasks and queued pending Listener runs allow realtime rule creation", async () => {
  const repository = realtimeRuleRepository({
    taskRuns: [{ id: "queued-listener-run", status: "queued", dispatch_status: "pending" }],
  });
  const response = await handleWorkspaceRealtimeApi(createRuleRequest(), {}, repository, realtimeContext());
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.data.account_id, "account-1");
  assert.equal(body.data.enabled, true);
  assert.equal(repository.sql.some((source) => /COUNT\(\*\).*FROM tasks/i.test(source)), false);
});

test("dispatching, dispatched, claimed, and running runs reject realtime rule state changes", async () => {
  const runs = [
    { id: "dispatching", status: "queued", dispatch_status: "dispatching" },
    { id: "dispatched", status: "queued", dispatch_status: "dispatched" },
    { id: "claimed", status: "claimed", dispatch_status: "dispatched" },
    { id: "running", status: "running", dispatch_status: "dispatched" },
  ];
  for (const run of runs) {
    const repository = realtimeRuleRepository({ taskRuns: [run] });
    await assert.rejects(
      () => handleWorkspaceRealtimeApi(createRuleRequest(), {}, repository, realtimeContext()),
      (error) => error?.status === 409 && error?.code === "listener_account_task_active",
      `${run.id} should block realtime rule creation`,
    );
  }
});

test("after task completion a realtime rule can be created, enabled, and modified", async () => {
  const repository = realtimeRuleRepository({
    taskRuns: [{ id: "completed", status: "success", dispatch_status: "dispatched" }],
  });
  const created = await handleWorkspaceRealtimeApi(createRuleRequest(false), {}, repository, realtimeContext());
  assert.equal(created.status, 201);
  assert.equal(repository.rule.enabled, 0);

  const updated = await handleWorkspaceRealtimeApi(new Request(
    "https://worker.example/api/v1/admin/realtime-rules/rule-1",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, name: "更新后的客服回复" }),
    },
  ), {}, repository, realtimeContext());
  const body = await updated.json();
  assert.equal(updated.status, 200);
  assert.equal(body.data.enabled, true);
  assert.equal(body.data.name, "更新后的客服回复");
});

test("listener bearer comparison is deterministic without exposing the secret", async () => {
  assert.equal(await __test.secureEqual("same-secret", "same-secret"), true);
  assert.equal(await __test.secureEqual("same-secret", "other-secret"), false);
});

test("bot inspection fails before creating data when the listener token is absent", async () => {
  const worker = createWorker({
    uuid: () => "request-id",
    repositoryFactory: () => ({}),
    verifyAdmin: async () => ({ authenticated: true, user_id: "user-1", role: "user" }),
  });
  const response = await worker.fetch(new Request("https://worker.example/api/v1/bot-inspections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: "account-1", target: "@example_bot" }),
  }), {});
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "listener_not_configured");
  assert.match(body.error.message, /常驻 Listener/);
});

test("realtime migration keeps user inspections and administrator rules separate", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of ["bot_inspections", "realtime_rules", "listener_instances", "listener_events"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /kind TEXT NOT NULL CHECK \(kind IN \('keyword_reply', 'group_monitor'\)\)/);
  assert.match(sql, /user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
});

test("realtime transition guard no longer depends on SQL text interception", async () => {
  const [apiSource, repositorySource, facadeSource] = await Promise.all([
    readFile(apiUrl, "utf8"),
    readFile(repositoryUrl, "utf8"),
    readFile(facadeUrl, "utf8"),
  ]);
  assert.doesNotMatch(apiSource, /SELECT COUNT\(\*\) AS total FROM tasks WHERE account_id/);
  assert.match(apiSource, /assertRealtimeTransitionAllowed/);
  assert.doesNotMatch(repositorySource, /normalizedSql|compatibilityDatabase|withRealtimeTaskGuard/);
  assert.doesNotMatch(facadeSource, /withRealtimeTaskGuard/);
});

test("Worker routes Listener task traffic before other Listener APIs", async () => {
  const app = await readFile(appUrl, "utf8");
  const taskIndex = app.indexOf('url.pathname.startsWith("/api/listener/v1/runs")');
  const listenerIndex = app.indexOf('url.pathname.startsWith("/api/listener/v1/")');
  const workspaceIndex = app.indexOf('url.pathname.startsWith("/api/v1/")');
  assert.ok(taskIndex > 0 && listenerIndex > taskIndex && workspaceIndex > listenerIndex);
  assert.match(app, /handleListenerTaskApi/);
  assert.match(app, /handleWorkspaceRealtimeApi/);
  assert.match(app, /realtime_listener/);
  assert.match(app, /listener_not_configured/);
});

test("only administrators can configure continuous monitoring and account validation", async () => {
  const source = await readFile(apiUrl, "utf8");
  const taskSource = await readFile(taskApiUrl, "utf8");
  assert.match(source, /只有平台管理员可以使用实时监听功能/);
  assert.match(source, /只有平台管理员可以运行账号连接检测/);
  assert.match(source, /每天最多识别 20 次机器人操作/);
  assert.match(taskSource, /u\.role = 'admin'/);
  assert.match(taskSource, /realtime_rules/);
  assert.match(taskSource, /listener:/);
  assert.doesNotMatch(source + taskSource, /child_process|eval\(|new Function/);
});
