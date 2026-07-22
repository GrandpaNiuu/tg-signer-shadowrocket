import { HttpError } from "./http.js";

export const REALTIME_HANDOFF_DELAY_SECONDS = 45;
export const REALTIME_HANDOFF_TTL_SECONDS = 10 * 60;

function requiredRepository(repository) {
  if (!repository || typeof repository !== "object") throw new Error("Repository is unavailable.");
  return repository;
}

function bindMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function isoOffset(timestamp, seconds) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error("Invalid realtime handoff timestamp.");
  return new Date(value + seconds * 1_000).toISOString();
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

async function activeRealtimeHandoff(repository, accountId, timestamp) {
  if (!repository.db?.prepare || !accountId) return null;
  return repository.db.prepare(`SELECT h.account_id, h.task_run_id, h.ready_at, h.expires_at
    FROM realtime_task_handoffs h
    JOIN task_runs r ON r.id = h.task_run_id
    WHERE h.account_id = ? AND h.expires_at > ?
      AND r.status IN ('queued', 'claimed', 'running')
    LIMIT 1`).bind(accountId, timestamp).first();
}

async function pendingRealtimeRun(repository, accountId) {
  if (!repository.db?.prepare || !accountId) return null;
  return repository.db.prepare(`SELECT r.id
    FROM task_runs r
    JOIN tasks t ON t.id = r.task_id
    WHERE COALESCE(r.account_id_snapshot, t.account_id) = ?
      AND r.status = 'queued' AND r.dispatch_status = 'pending'
    ORDER BY r.scheduled_for, r.created_at, r.id
    LIMIT 1`).bind(accountId).first();
}

async function pauseRealtimeRules(repository, accountId, runId, timestamp) {
  await repository.db.prepare(`INSERT OR IGNORE INTO realtime_task_handoff_rules
    (account_id, task_run_id, rule_id)
    SELECT ?, ?, id FROM realtime_rules
    WHERE account_id = ? AND enabled = 1`)
    .bind(accountId, runId, accountId).run();
  await repository.db.prepare(`UPDATE realtime_rules SET enabled = 0, updated_at = ?
    WHERE id IN (
      SELECT rule_id FROM realtime_task_handoff_rules WHERE task_run_id = ?
    )`).bind(timestamp, runId).run();
}

export async function prepareRealtimeTaskHandoff(repository, accountId, timestamp) {
  const target = requiredRepository(repository);

  // Check a handoff before checking enabled rules. Handoff creation temporarily
  // disables those rules so an old Listener also drops the Telegram connection.
  let handoff = await activeRealtimeHandoff(target, accountId, timestamp);
  if (handoff) {
    return {
      realtime: true,
      ready: Boolean(handoff.ready_at && handoff.ready_at <= timestamp),
      handoff,
    };
  }

  if (!await realtimeRuleActive(target, accountId)) {
    return { realtime: false, ready: true, handoff: null };
  }

  const pending = await pendingRealtimeRun(target, accountId);
  if (!pending?.id) return { realtime: true, ready: false, handoff: null };

  await target.db.prepare(`DELETE FROM realtime_task_handoffs
    WHERE account_id = ? AND (
      expires_at <= ? OR NOT EXISTS (
        SELECT 1 FROM task_runs r
        WHERE r.id = realtime_task_handoffs.task_run_id
          AND r.status IN ('queued', 'claimed', 'running')
      )
    )`).bind(accountId, timestamp).run();

  const readyAt = isoOffset(timestamp, REALTIME_HANDOFF_DELAY_SECONDS);
  const expiresAt = isoOffset(timestamp, REALTIME_HANDOFF_TTL_SECONDS);
  await target.db.prepare(`INSERT OR IGNORE INTO realtime_task_handoffs
    (account_id, task_run_id, ready_at, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(accountId, pending.id, readyAt, expiresAt, timestamp, timestamp).run();
  handoff = await activeRealtimeHandoff(target, accountId, timestamp);
  if (handoff) await pauseRealtimeRules(target, accountId, handoff.task_run_id, timestamp);

  return {
    realtime: true,
    ready: Boolean(handoff?.ready_at && handoff.ready_at <= timestamp),
    handoff,
  };
}

export async function findRealtimeTransitionBlockingRun(repository, accountId) {
  const target = requiredRepository(repository);
  if (!target.db?.prepare || !accountId) return null;
  return target.db.prepare(`SELECT r.id, r.status, r.dispatch_status
    FROM task_runs r
    LEFT JOIN tasks t ON t.id = r.task_id
    WHERE COALESCE(r.account_id_snapshot, t.account_id) = ?
      ${target.userId ? "AND r.user_id = ?" : ""}
      AND (
        r.status IN ('claimed', 'running')
        OR (r.status = 'queued' AND r.dispatch_status IN ('dispatching', 'dispatched'))
        OR EXISTS (
          SELECT 1 FROM realtime_task_handoffs h
          WHERE h.account_id = ? AND h.task_run_id = r.id
        )
      )
    LIMIT 1`).bind(accountId, ...(target.userId ? [target.userId] : []), accountId).first();
}

export async function assertRealtimeTransitionAllowed(repository, accountId) {
  const activeRun = await findRealtimeTransitionBlockingRun(repository, accountId);
  if (!activeRun) return;
  throw new HttpError(
    409,
    "listener_account_task_active",
    "这个账号的定时任务正在与 24 小时监听安全交接。任务结束后实时规则会自动恢复。",
  );
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
    repository.db.prepare(`DELETE FROM realtime_task_handoffs
      WHERE expires_at <= ? OR NOT EXISTS (
        SELECT 1 FROM task_runs r
        WHERE r.id = realtime_task_handoffs.task_run_id
          AND r.status IN ('queued', 'claimed', 'running')
      )`).bind(timestamp),
  ]);
  return true;
}

export function withInspectionDispatchGuard(repository) {
  const target = requiredRepository(repository);
  if (typeof target.reserveNextDispatch !== "function") return target;
  return new Proxy(target, {
    get(current, property) {
      if (property === "reserveNextDispatch") {
        return async (accountId, timestamp) => {
          if (await inspectionActive(current, accountId, timestamp)) return null;
          const handoff = await prepareRealtimeTaskHandoff(current, accountId, timestamp);
          if (handoff.realtime && !handoff.ready) return null;
          return current.reserveNextDispatch(accountId, timestamp);
        };
      }
      if (property === "listDispatchableAccountIds" && typeof current.listDispatchableAccountIds === "function") {
        return async (timestamp, limit = 20) => {
          const candidates = await current.listDispatchableAccountIds(timestamp, Math.min(100, Math.max(limit * 3, limit)));
          const available = [];
          for (const accountId of candidates) {
            if (await inspectionActive(current, accountId, timestamp)) continue;
            const handoff = await prepareRealtimeTaskHandoff(current, accountId, timestamp);
            if (handoff.realtime && !handoff.ready) continue;
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
  activeRealtimeHandoff,
  cleanupRealtimeHistory,
  cutoff,
  inspectionActive,
  isoOffset,
  pauseRealtimeRules,
  pendingRealtimeRun,
  realtimeRuleActive,
};
