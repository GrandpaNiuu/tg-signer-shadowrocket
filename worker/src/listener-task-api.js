import { HttpError, json, methodNotAllowed, readJson } from "./http.js";
import { withInspectionDispatchGuard } from "./realtime-repository.js";
import { handleRunnerApi } from "./runner-api-v2.js";

function objectBody(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "Listener request body is invalid.");
  }
  return value;
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function secureEqual(left, right) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  if (a.length !== b.length) return false;
  let different = 0;
  for (let index = 0; index < a.length; index += 1) different |= a[index] ^ b[index];
  return different === 0;
}

async function verifyListener(request, env) {
  const configured = String(env.LISTENER_API_TOKEN || "").trim();
  if (configured.length < 32) {
    throw new HttpError(503, "listener_not_configured", "常驻 Listener 尚未配置。");
  }
  const header = String(request.headers.get("authorization") || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!supplied || !await secureEqual(supplied, configured)) {
    throw new HttpError(401, "listener_unauthorized", "Listener authentication failed.");
  }
}

function normalizedInstanceId(value) {
  const output = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(output)) {
    throw new HttpError(422, "validation_failed", "Listener instance id is invalid.");
  }
  return output;
}

function headerInstanceId(request) {
  return normalizedInstanceId(request.headers.get("x-listener-instance-id"));
}

function listenerOwner(instanceId) {
  return `listener:${instanceId}`;
}

async function nextListenerRunId(repository, timestamp) {
  const dueThrough = new Date(Date.parse(timestamp) + 5_000).toISOString();
  const row = await repository.db.prepare(`SELECT r.id
    FROM task_runs r
    JOIN tasks t ON t.id = r.task_id
    JOIN accounts a ON a.id = COALESCE(r.account_id_snapshot, t.account_id)
    JOIN users u ON u.id = a.user_id AND u.role = 'admin' AND u.status = 'active'
    JOIN skills current_skill ON current_skill.id = t.skill_id
    JOIN skills execution_skill ON execution_skill.skill_key = COALESCE(r.skill_key_snapshot, current_skill.skill_key)
    WHERE r.status = 'queued' AND r.dispatch_status = 'pending'
      AND r.scheduled_for <= ?
      AND t.enabled = 1 AND a.enabled = 1 AND a.status = 'connected' AND execution_skill.enabled = 1
      AND (r.next_dispatch_at IS NULL OR r.next_dispatch_at <= ?)
      AND EXISTS (
        SELECT 1 FROM realtime_rules rr
        WHERE rr.account_id = a.id AND rr.user_id = a.user_id AND rr.enabled = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM bot_inspections i
        WHERE i.account_id = a.id AND i.status IN ('queued', 'running') AND i.expires_at > ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM account_leases lease
        WHERE lease.account_id = a.id AND lease.leased_until > ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM media_upload_leases media_lease
        WHERE media_lease.account_id = a.id AND media_lease.leased_until > ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_runs active
        JOIN tasks active_task ON active_task.id = active.task_id
        WHERE COALESCE(active.account_id_snapshot, active_task.account_id) = a.id
          AND active.id <> r.id
          AND (active.status IN ('claimed', 'running')
            OR (active.status = 'queued' AND active.dispatch_status IN ('dispatching', 'dispatched')))
      )
    ORDER BY r.scheduled_for, r.created_at, r.id
    LIMIT 1`).bind(dueThrough, timestamp, timestamp, timestamp, timestamp).first();
  return row?.id || null;
}

function runnerContext(context) {
  return {
    uuid: context.uuid || (() => crypto.randomUUID()),
    now: context.now || (() => new Date()),
    fetch: context.fetch || globalThis.fetch,
  };
}

function syntheticRunnerRequest(request, path, bodyText) {
  const target = new URL(path, request.url);
  return new Request(target.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });
}

async function claimRun(request, env, repository, context) {
  const body = objectBody(await readJson(request, 4_000));
  const instanceId = normalizedInstanceId(body.instance_id);
  const headerId = request.headers.get("x-listener-instance-id");
  if (headerId && normalizedInstanceId(headerId) !== instanceId) {
    throw new HttpError(409, "listener_instance_mismatch", "Listener instance id does not match the authenticated client.");
  }
  const timestamp = runnerContext(context).now().toISOString();
  const runId = await nextListenerRunId(repository, timestamp);
  if (!runId) return json({ data: null });

  const guarded = withInspectionDispatchGuard(repository);
  const synthetic = syntheticRunnerRequest(request, `/api/runner/runs/${encodeURIComponent(runId)}/claim`, "{}");
  try {
    return await handleRunnerApi(
      synthetic,
      env,
      guarded,
      runnerContext(context),
      { run_id: listenerOwner(instanceId) },
    );
  } catch (error) {
    if (error?.code === "run_not_claimable" || error?.status === 409) return json({ data: null });
    throw error;
  }
}

async function forwardRunCallback(request, env, repository, context, runId, action) {
  const instanceId = headerInstanceId(request);
  const bodyText = await request.text();
  const guarded = withInspectionDispatchGuard(repository);
  const synthetic = syntheticRunnerRequest(
    request,
    `/api/runner/runs/${encodeURIComponent(runId)}/${action}`,
    bodyText || "{}",
  );
  return handleRunnerApi(
    synthetic,
    env,
    guarded,
    runnerContext(context),
    { run_id: listenerOwner(instanceId) },
  );
}

export async function handleListenerTaskApi(request, env, repository, context = {}) {
  const url = new URL(request.url);
  const prefix = "/api/listener/v1/runs";
  if (!url.pathname.startsWith(prefix)) return null;
  await verifyListener(request, env);
  const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (parts.length === 1 && parts[0] === "claim") {
    return claimRun(request, env, repository, context);
  }
  if (parts.length === 2 && parts[1] === "attempts") {
    return forwardRunCallback(request, env, repository, context, parts[0], "attempts");
  }
  if (parts.length === 2 && parts[1] === "complete") {
    return forwardRunCallback(request, env, repository, context, parts[0], "complete");
  }
  throw new HttpError(404, "not_found", "Listener task route not found.");
}

export const __test = {
  listenerOwner,
  normalizedInstanceId,
  secureEqual,
};
