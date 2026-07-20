import { HttpError } from "./http.js";

function requiredRepository(repository) {
  if (!repository || typeof repository !== "object") throw new Error("Repository is unavailable.");
  return repository;
}

function bindMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

async function inspectionActive(repository, accountId, timestamp) {
  if (!repository.db?.prepare || !accountId) return false;
  const row = await repository.db.prepare(`SELECT 1 AS active FROM bot_inspections
    WHERE account_id = ? AND status IN ('queued', 'running') AND expires_at > ? LIMIT 1`)
    .bind(accountId, timestamp).first();
  return Boolean(row?.active);
}

async function realtimeRuleActive(repository, accountId) {
  if (!repository.db?.prepare || !accountId) return false;
  const row = await repository.db.prepare(`SELECT 1 AS active FROM realtime_rules
    WHERE account_id = ? AND enabled = 1 LIMIT 1`).bind(accountId).first();
  return Boolean(row?.active);
}

function realtimeAccountConflict() {
  return new HttpError(
    409,
    "account_reserved_for_realtime_listener",
    "这个 Telegram 账号正在用于 24 小时实时服务，不能同时运行普通定时任务。请停用实时规则，或为普通任务选择其他账号。",
  );
}

export function withRealtimeTaskGuard(repository) {
  const target = requiredRepository(repository);
  if (typeof target.createTask !== "function" && typeof target.updateTask !== "function") return target;
  return new Proxy(target, {
    get(current, property) {
      if (property === "createTask" && typeof current.createTask === "function") {
        return async (task, signerImportSecret = null) => {
          if (task?.enabled && await realtimeRuleActive(current, task.account_id)) {
            throw realtimeAccountConflict();
          }
          return current.createTask(task, signerImportSecret);
        };
      }
      if (property === "updateTask" && typeof current.updateTask === "function") {
        return async (id, values, options = {}) => {
          const existing = typeof current.getTask === "function" ? await current.getTask(id) : null;
          const accountId = values?.account_id ?? existing?.account_id;
          const enabled = values?.enabled ?? existing?.enabled;
          if (enabled && await realtimeRuleActive(current, accountId)) {
            throw realtimeAccountConflict();
          }
          return current.updateTask(id, values, options);
        };
      }
      return bindMember(current, property);
    },
  });
}

export function withInspectionDispatchGuard(repository) {
  const target = requiredRepository(repository);
  if (typeof target.reserveNextDispatch !== "function") return target;
  return new Proxy(target, {
    get(current, property) {
      if (property === "reserveNextDispatch") {
        return async (accountId, timestamp) => {
          if (await inspectionActive(current, accountId, timestamp)) return null;
          return current.reserveNextDispatch(accountId, timestamp);
        };
      }
      if (property === "listDispatchableAccountIds" && typeof current.listDispatchableAccountIds === "function") {
        return async (timestamp, limit = 20) => {
          const candidates = await current.listDispatchableAccountIds(timestamp, Math.min(100, Math.max(limit * 2, limit)));
          const available = [];
          for (const accountId of candidates) {
            if (!await inspectionActive(current, accountId, timestamp)) available.push(accountId);
            if (available.length >= limit) break;
          }
          return available;
        };
      }
      return bindMember(current, property);
    },
  });
}

export const __test = { inspectionActive, realtimeRuleActive };
