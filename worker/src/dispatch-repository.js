const DISPATCH_ERROR_PREFIX = /^\[([a-z0-9_]{1,100})\]\s/;

function bindRepositoryMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function dispatchErrorCode(message) {
  return DISPATCH_ERROR_PREFIX.exec(String(message || ""))?.[1] || null;
}

async function persistDispatchFailure(repository, runId, timestamp, code, message) {
  const nextDispatchAt = new Date(Date.parse(timestamp) + 60_000).toISOString();
  const scoped = Boolean(repository.userId);
  const statement = repository.db.prepare(`UPDATE task_runs SET dispatch_status = 'pending', dispatch_reserved_at = NULL,
    next_dispatch_at = ?, error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND status = 'queued' AND dispatch_status = 'dispatching'${scoped ? " AND user_id = ?" : ""}`)
    .bind(
      nextDispatchAt,
      code,
      message,
      timestamp,
      runId,
      ...(scoped ? [repository.userId] : []),
    );
  await statement.run();
}

export function withDispatchErrorCodes(repository) {
  if (!repository || typeof repository.markRunDispatchFailed !== "function") return repository;

  return new Proxy(repository, {
    get(target, property) {
      if (property !== "markRunDispatchFailed") return bindRepositoryMember(target, property);

      return async (runId, timestamp, message) => {
        const code = dispatchErrorCode(message);
        if (!code || !target.db?.prepare) {
          return target.markRunDispatchFailed(runId, timestamp, message);
        }
        // Persist the retry schedule and stable error code atomically. Calling the
        // legacy method first would create a second D1 write and an avoidable
        // intermediate `dispatch_retry` state.
        return persistDispatchFailure(target, runId, timestamp, code, message);
      };
    },
  });
}

export const __test = {
  dispatchErrorCode,
  persistDispatchFailure,
};
