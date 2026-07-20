import { ACCOUNT_STATUSES, RUN_STATUSES } from "./states.js";

const SESSION_RECONNECT_ERROR_CODES = new Set([
  "session_invalid",
]);

function bindRepositoryMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function completionRequiresReconnect(completion) {
  return completion?.status === RUN_STATUSES.FAILED
    && SESSION_RECONNECT_ERROR_CODES.has(String(completion?.error_code || ""));
}

async function updateReconnectState(repository, runId, githubRunId, completion, now) {
  const execution = await repository.getExecution(runId);
  if (!execution || String(execution.github_run_id || "") !== String(githubRunId || "")) return;
  if (execution.status !== RUN_STATUSES.FAILED) return;
  if (!SESSION_RECONNECT_ERROR_CODES.has(String(execution.error_code || ""))) return;
  if (!execution.account_id) return;

  await repository.updateAccount(execution.account_id, {
    changes: {
      status: ACCOUNT_STATUSES.RECONNECT_REQUIRED,
      last_error: completion.error_message || execution.error_message || "Telegram Session is invalid. Please sign in again.",
      last_connected_at: null,
      updated_at: completion.updated_at || now().toISOString(),
    },
    secrets: [],
    clearSecrets: [],
  });
}

export function withRunnerSessionState(repository, now = () => new Date()) {
  if (!repository || typeof repository.completeRun !== "function") return repository;

  return new Proxy(repository, {
    get(target, property) {
      if (property !== "completeRun") return bindRepositoryMember(target, property);

      return async (runId, githubRunId, completion) => {
        const completed = await target.completeRun(runId, githubRunId, completion);
        if (completionRequiresReconnect(completion)) {
          await updateReconnectState(target, runId, githubRunId, completion, now);
        }
        return completed;
      };
    },
  });
}

export const __test = {
  completionRequiresReconnect,
  updateReconnectState,
};
