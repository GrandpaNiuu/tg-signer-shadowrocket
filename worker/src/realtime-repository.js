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
  const row = await repository.db.prepare(`SELECT 1 AS active FROM realtime_rules r
    JOIN users u ON u.id = r.user_id AND u.role = 'admin' AND u.status = 'active'
    WHERE r.account_id = ? AND r.enabled = 1 LIMIT 1`).bind(accountId).first();
  return Boolean(row?.active);
}

async function dispatchedTaskActive(db, accountId) {
  if (!db?.prepare || !accountId) return false;
  const row = await db.prepare(`SELECT 1 AS active
    FROM task_runs r
    LEFT JOIN tasks t ON t.id = r.task_id
    WHERE COALESCE(r.account_id_snapshot, t.account_id) = ?
      AND (
        r.status IN ('claimed', 'running')
        OR (r.status = 'queued' AND r.dispatch_status IN ('dispatching', 'dispatched'))
      )
    LIMIT 1`).bind(accountId).first();
  return Boolean(row?.active);
}

function cutoff(timestamp, days) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error("Invalid realtime cleanup timestamp.");
  return new Date(value - days * 24 * 60 * 60 * 1_000).toISOString();
}

async function cleanupRealtimeHistory(repository, timestamp) {
  if (!repository.db?.batch || !repository.db?.prepare) return false;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || date.getUTCMinutes() !== 0) return false;
  await repository.db.batch([
    repository.db.prepare("DELETE FROM listener_events WHERE created_at < ?")
      .bind(cutoff(timestamp, 30)),
    repository.db.prepare(`DELETE FROM bot_inspections
      WHERE status IN ('success', 'failed', 'expired', 'cancelled') AND updated_at < ?`)
      .bind(cutoff(timestamp, 7)),
    repository.db.prepare("DELETE FROM listener_instances WHERE last_heartbeat_at < ?")
      .bind(cutoff(timestamp, 7)),
  ]);
  return true;
}

function normalizedSql(sql) {
  return String(sql || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function compatibilityDatabase(db) {
  if (!db?.prepare) return db;
  return new Proxy(db, {
    get(current, property) {
      if (property === "prepare") {
        return (sql) => {
          const query = normalizedSql(sql);
          if (query === "select count(*) as total from tasks where account_id = ? and enabled = 1") {
            return {
              bind(accountId) {
                return {
                  async first() {
                    if (await dispatchedTaskActive(current, accountId)) {
                      throw new HttpError(
                        409,
                        "listener_account_task_active",
                        "这个账号当前已有任务交给 GitHub Runner 或正在执行。请等待该任务结束后再启用 24 小时实时规则。",
                      );
                    }
                    return { total: 0 };
                  },
                };
              },
            };
          }
          return current.prepare(sql);
        };
      }
      return bindMember(current, property);
    },
  });
}

// Existing route code used a dedicated-account count query. Keep that route
// compatible while allowing tasks and realtime rules to coexist; dispatch is
// still separated so GitHub Actions never opens the same Session concurrently.
export function withRealtimeTaskGuard(repository) {
  const target = requiredRepository(repository);
  return new Proxy(target, {
    get(current, property) {
      if (property === "db") return compatibilityDatabase(current.db);
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
          if (await realtimeRuleActive(current, accountId)) return null;
          return current.reserveNextDispatch(accountId, timestamp);
        };
      }
      if (property === "listDispatchableAccountIds" && typeof current.listDispatchableAccountIds === "function") {
        return async (timestamp, limit = 20) => {
          const candidates = await current.listDispatchableAccountIds(timestamp, Math.min(100, Math.max(limit * 3, limit)));
          const available = [];
          for (const accountId of candidates) {
            if (await inspectionActive(current, accountId, timestamp)) continue;
            if (await realtimeRuleActive(current, accountId)) continue;
            available.push(accountId);
            if (available.length >= limit) break;
          }
          return available;
        };
      }
      return bindMember(current, property);
    },
  });
}

export function withRealtimeMaintenance(repository) {
  const target = requiredRepository(repository);
  if (typeof target.reconcileRuns !== "function") return target;
  return new Proxy(target, {
    get(current, property) {
      if (property === "reconcileRuns") {
        return async (timestamp, staleDispatchBefore) => {
          const result = await current.reconcileRuns(timestamp, staleDispatchBefore);
          await cleanupRealtimeHistory(current, timestamp);
          return result;
        };
      }
      return bindMember(current, property);
    },
  });
}

export const __test = {
  cleanupRealtimeHistory,
  cutoff,
  dispatchedTaskActive,
  inspectionActive,
  realtimeRuleActive,
};
