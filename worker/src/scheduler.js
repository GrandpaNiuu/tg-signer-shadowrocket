import { nextCronDate } from "./cron.js";
import { dispatchWorkflow } from "./github.js";
import { sanitizedError } from "./redaction.js";

export const DISPATCH_ERROR_CODES = Object.freeze({
  HTTP: "github_dispatch_http_error",
  NETWORK: "github_dispatch_network_error",
  TIMEOUT: "github_dispatch_timeout",
  CONFIG: "github_dispatch_config_error",
  STATE_UPDATE: "github_dispatch_state_update_failed",
});

function plusSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1_000).toISOString();
}

function emptyReconciliation() {
  return {
    cancelled_unavailable: 0,
    reset_dispatches: 0,
    expired_runs: 0,
    expired_queued: 0,
  };
}

function dispatchFailureMessage(code, message) {
  return `[${code}] ${message}`;
}

function classifyDispatchException(error) {
  if (error?.name === "AbortError") return DISPATCH_ERROR_CODES.TIMEOUT;
  if (error?.code === "github_config_missing") return DISPATCH_ERROR_CODES.CONFIG;
  return DISPATCH_ERROR_CODES.NETWORK;
}

function withHiddenProperty(object, name, value) {
  Object.defineProperty(object, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: true,
  });
  return object;
}

function dispatchFailureResult(reason, errorCode, run) {
  return withHiddenProperty({ dispatched: false, reason, run }, "error_code", errorCode);
}

function acceptedDispatchResult(run, reason = undefined) {
  return {
    dispatched: true,
    run,
    ...(reason ? { reason } : {}),
  };
}

export function makeRun(task, { id, triggerType, scheduledFor, now, dedupeKey = null }) {
  return {
    id,
    task_id: task.id,
    trigger_type: triggerType,
    scheduled_for: scheduledFor,
    dedupe_key: dedupeKey
      || (triggerType === "schedule" ? `schedule:${task.id}:${scheduledFor}` : `${triggerType}:${id}`),
    max_attempts: Number(task.retry || 0) + 1,
    // A queued run may wait behind other tasks for the same Telegram account.
    // The execution lease is computed separately when the runner claims it.
    claim_expires_at: plusSeconds(now, 24 * 60 * 60),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

async function dispatchRun(env, fetchImpl, runId) {
  return dispatchWorkflow(env, fetchImpl, {
    workflow: env.TASK_RUNNER_WORKFLOW_FILE || "task-runner.yml",
    inputs: { run_id: runId },
  });
}

async function persistDispatchFailure(repository, run, now, errorCode, message) {
  await repository.markRunDispatchFailed(
    run.id,
    now().toISOString(),
    dispatchFailureMessage(errorCode, message),
  );
}

export async function dispatchNextForAccount(accountId, env, dependencies) {
  if (!accountId) return { dispatched: false, reason: "account_missing" };
  const reservedAt = dependencies.now().toISOString();
  const run = await dependencies.repository.reserveNextDispatch(accountId, reservedAt);
  if (!run) return { dispatched: false, reason: "busy_or_empty" };

  let response;
  try {
    response = await dispatchRun(env, dependencies.fetch, run.id);
  } catch (error) {
    const errorCode = classifyDispatchException(error);
    await persistDispatchFailure(
      dependencies.repository,
      run,
      dependencies.now,
      errorCode,
      sanitizedError(error, 500),
    );
    return dispatchFailureResult("github_error", errorCode, run);
  }

  if (!response.ok) {
    const errorCode = DISPATCH_ERROR_CODES.HTTP;
    await persistDispatchFailure(
      dependencies.repository,
      run,
      dependencies.now,
      errorCode,
      `GitHub workflow dispatch returned HTTP ${response.status}.`,
    );
    return dispatchFailureResult("github_error", errorCode, run);
  }

  try {
    const updated = await dependencies.repository.markRunDispatched(
      run.id,
      dependencies.now().toISOString(),
    );
    // The Runner can claim the run before the scheduler records the 204 response.
    // In that race, the dispatch is accepted and the state has already advanced.
    return acceptedDispatchResult(run, updated === false ? "state_already_advanced" : undefined);
  } catch (error) {
    // GitHub has already accepted the workflow. Never reset the run to pending here,
    // because doing so can dispatch the same Telegram action a second time.
    const result = acceptedDispatchResult(run, "state_update_failed");
    withHiddenProperty(result, "warning_code", DISPATCH_ERROR_CODES.STATE_UPDATE);
    withHiddenProperty(result, "warning", sanitizedError(error, 500));
    return result;
  }
}

export async function dispatchPendingRuns(env, dependencies, limit = 20) {
  const timestamp = dependencies.now().toISOString();
  const accountIds = await dependencies.repository.listDispatchableAccountIds(timestamp, limit);
  const failuresByCode = {};
  const warningsByCode = {};
  const summary = withHiddenProperty(
    { candidates: accountIds.length, dispatched: 0, failed: 0 },
    "failures_by_code",
    failuresByCode,
  );
  withHiddenProperty(summary, "warnings_by_code", warningsByCode);

  for (const accountId of accountIds) {
    const result = await dispatchNextForAccount(accountId, env, dependencies);
    if (result.dispatched) {
      summary.dispatched += 1;
      if (result.warning_code) {
        warningsByCode[result.warning_code] = (warningsByCode[result.warning_code] || 0) + 1;
      }
    } else if (result.reason === "github_error") {
      summary.failed += 1;
      const code = result.error_code || "github_dispatch_error";
      failuresByCode[code] = (failuresByCode[code] || 0) + 1;
    }
  }
  return summary;
}

export async function enqueueAndDispatch(task, env, dependencies, {
  triggerType,
  scheduledFor,
  nextRunAt,
  dedupeKey = null,
}) {
  const now = dependencies.now();
  const run = makeRun(task, {
    id: dependencies.uuid(),
    triggerType,
    scheduledFor,
    now,
    dedupeKey,
  });
  const created = await dependencies.repository.enqueueRun({ run, nextRunAt });
  if (!created) {
    const existing = await dependencies.repository.getRunByDedupeKey(run.dedupe_key);
    return existing
      ? { created: false, dispatched: false, run: existing, reason: "duplicate" }
      : { created: false, dispatched: false, run, reason: "not_executable" };
  }
  const dispatch = await dispatchNextForAccount(task.account_id, env, dependencies);
  return {
    created: true,
    dispatched: Boolean(dispatch.dispatched && dispatch.run?.id === run.id),
    run,
    reason: dispatch.reason,
  };
}

export async function runScheduler(env, dependencies) {
  const current = dependencies.now();
  const configuredLead = Number(env.SCHEDULE_DISPATCH_LEAD_SECONDS || 120);
  const leadSeconds = Number.isFinite(configuredLead)
    ? Math.min(180, Math.max(120, Math.floor(configuredLead)))
    : 120;
  const dueThrough = new Date(current.getTime() + leadSeconds * 1_000);
  const staleDispatchBefore = new Date(current.getTime() - 10 * 60_000).toISOString();
  let reconciliation = emptyReconciliation();
  if (dependencies.repository.reconcileRuns) {
    reconciliation = {
      ...reconciliation,
      ...await dependencies.repository.reconcileRuns(current.toISOString(), staleDispatchBefore),
    };
  }
  const dueTasks = await dependencies.repository.getDueTasks(dueThrough.toISOString(), 100);
  const summary = withHiddenProperty({
    mode: "d1",
    due: dueTasks.length,
    queued: 0,
    dispatched: 0,
    failed: 0,
  }, "reconciliation", reconciliation);
  for (const task of dueTasks) {
    let scheduledFor = task.next_run_at;
    // A lead window can contain more than one once-per-minute occurrence. Advance
    // every occurrence now so a low second (for example :05) is not first
    // dispatched by the Worker tick only five seconds before it is due.
    for (let occurrence = 0; occurrence < 4; occurrence += 1) {
      const scheduledDate = new Date(scheduledFor);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate > dueThrough) break;
      const nextRunAt = nextCronDate(task.cron, task.timezone, scheduledDate).toISOString();
      const run = makeRun(task, {
        id: dependencies.uuid(),
        triggerType: "schedule",
        scheduledFor,
        now: current,
      });
      if (!await dependencies.repository.enqueueRun({ run, nextRunAt })) break;
      summary.queued += 1;
      scheduledFor = nextRunAt;
    }
  }
  const dispatch = await dispatchPendingRuns(env, dependencies, 100);
  summary.dispatched = dispatch.dispatched;
  summary.failed = dispatch.failed;
  withHiddenProperty(summary, "warnings_by_code", dispatch.warnings_by_code);
  return withHiddenProperty(summary, "failures_by_code", dispatch.failures_by_code);
}
