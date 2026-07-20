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

export const __test = { inspectionActive };
