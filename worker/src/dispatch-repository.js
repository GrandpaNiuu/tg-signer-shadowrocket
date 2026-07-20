const DISPATCH_ERROR_PREFIX = /^\[([a-z0-9_]{1,100})\]\s/;

function bindRepositoryMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function dispatchErrorCode(message) {
  return DISPATCH_ERROR_PREFIX.exec(String(message || ""))?.[1] || null;
}

async function persistStableErrorCode(repository, runId, message) {
  const code = dispatchErrorCode(message);
  if (!code || !repository.db?.prepare) return;

  const scoped = Boolean(repository.userId);
  const statement = repository.db.prepare(`UPDATE task_runs SET error_code = ?
    WHERE id = ? AND error_message = ?${scoped ? " AND user_id = ?" : ""}`)
    .bind(code, runId, message, ...(scoped ? [repository.userId] : []));
  await statement.run();
}

export function withDispatchErrorCodes(repository) {
  if (!repository || typeof repository.markRunDispatchFailed !== "function") return repository;

  return new Proxy(repository, {
    get(target, property) {
      if (property !== "markRunDispatchFailed") return bindRepositoryMember(target, property);

      return async (runId, timestamp, message) => {
        const result = await target.markRunDispatchFailed(runId, timestamp, message);
        await persistStableErrorCode(target, runId, message);
        return result;
      };
    },
  });
}

export const __test = {
  dispatchErrorCode,
  persistStableErrorCode,
};
