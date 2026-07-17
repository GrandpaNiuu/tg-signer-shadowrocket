import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createD1Repository } from "../src/repository.js";

class D1StatementAdapter {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1StatementAdapter(this.database, this.sql, bindings);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) || null;
  }

  async all() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.bindings),
      meta: { changes: 0 },
    };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  execute() {
    return /^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)
      ? this.all()
      : this.run();
  }
}

export class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createTestRepository() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  const db = new D1Adapter(sqlite);
  return { sqlite, db, repository: createD1Repository(db) };
}

export async function seedAccount(repository, {
  id = "account-1",
  name = "Primary",
  timestamp = "2026-07-18T00:00:00.000Z",
  status = "connected",
} = {}) {
  return repository.createAccount({
    account: {
      id,
      name,
      phone_masked: "+86*******5678",
      status,
      enabled: 1,
      last_connected_at: status === "connected" ? timestamp : null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    secrets: [],
  });
}

export async function seedTask(repository, {
  id = "task-1",
  accountId = "account-1",
  skillKey = "send_text",
  timestamp = "2026-07-18T00:00:00.000Z",
  cron = "0 * * * *",
} = {}) {
  const skill = await repository.getSkillByKey(skillKey);
  return repository.createTask({
    id,
    name: id,
    account_id: accountId,
    skill_id: skill.id,
    bot: "@example_bot",
    command: skillKey === "tg_signer" ? "daily_sign" : "/checkin",
    cron,
    timezone: "UTC",
    retry: 1,
    timeout_seconds: 120,
    thread_id: null,
    delete_after_seconds: null,
    enabled: 1,
    next_run_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
}
