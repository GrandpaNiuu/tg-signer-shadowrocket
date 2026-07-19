import { handleAdminApi } from "./admin-api.js";
import { createAdminAuth } from "./admin-auth.js";
import { verifyRunnerRequest } from "./auth.js";
import { errorResponse, json } from "./http.js";
import { createD1Repository } from "./repository.js";
import { handleRunnerApi } from "./runner-api.js";
import { runScheduler } from "./scheduler.js";

const REQUIRED_READY_CONFIG = Object.freeze([
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "RUNNER_OIDC_AUDIENCE",
  "TASK_RUNNER_WORKFLOW_FILE",
  "LOGIN_WORKFLOW_FILE",
  "ADMIN_ORIGIN",
]);

function defaultUuid() {
  return crypto.randomUUID();
}

async function withRequestId(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);

  const contentType = headers.get("content-type") || "";
  if (response.status >= 400 && contentType.includes("application/json")) {
    try {
      const payload = await response.clone().json();
      if (payload && typeof payload === "object" && payload.error && !payload.request_id) {
        return new Response(JSON.stringify({ ...payload, request_id: requestId }), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } catch {
      // Keep the original response body when an endpoint returns invalid JSON.
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function checkReadiness(env) {
  const missingConfiguration = REQUIRED_READY_CONFIG.filter(
    (name) => !String(env[name] || "").trim(),
  );
  const credentials = String(env.GITHUB_TOKEN || "").trim() ? "ok" : "missing";

  let database = "missing";
  if (env.DB) {
    try {
      const result = await env.DB.prepare("SELECT 1 AS ready").first();
      database = Number(result?.ready) === 1 ? "ok" : "error";
    } catch {
      database = "error";
    }
  }

  const configuration = missingConfiguration.length === 0 ? "ok" : "missing";
  const ok = database === "ok" && configuration === "ok" && credentials === "ok";
  return {
    status: ok ? 200 : 503,
    payload: {
      ok,
      worker: "tg-signer-shadowrocket",
      checks: {
        database,
        configuration,
        credentials,
      },
      ...(missingConfiguration.length ? { missing_configuration: missingConfiguration } : {}),
    },
  };
}

export function createWorker(dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const uuid = dependencies.uuid || defaultUuid;
  const now = dependencies.now || (() => new Date());
  const repositoryFactory = dependencies.repositoryFactory || ((env) => {
    if (!env.DB) throw new Error("D1 binding DB is missing.");
    return createD1Repository(env.DB);
  });
  const adminAuth = dependencies.adminAuth || createAdminAuth({ fetch: fetchImpl, now });
  const verifyAdmin = dependencies.verifyAdmin || ((request, env, repository) => adminAuth.verify(request, env, repository));
  const verifyRunner = dependencies.verifyRunner || ((request, env) => verifyRunnerRequest(request, env, { fetch: fetchImpl }));

  return {
    async fetch(request, env) {
      const requestId = request.headers.get("cf-ray") || uuid();
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") {
          return await withRequestId(json({ ok: true, worker: "tg-signer-shadowrocket" }), requestId);
        }
        if (url.pathname === "/ready" && request.method === "GET") {
          const readiness = await checkReadiness(env);
          return await withRequestId(json(readiness.payload, readiness.status), requestId);
        }
        if (url.pathname.startsWith("/api/auth/")) {
          const repository = repositoryFactory(env);
          return await withRequestId(await adminAuth.handle(request, env, repository), requestId);
        }
        if (url.pathname.startsWith("/api/v1/")) {
          const repository = repositoryFactory(env);
          const verified = await verifyAdmin(request, env, repository);
          const identity = {
            ...verified,
            user_id: verified?.user_id || "legacy-admin",
            role: verified?.role || "admin",
          };
          const userRepository = typeof repository.forUser === "function"
            ? repository.forUser(identity)
            : repository;
          return await withRequestId(await handleAdminApi(request, env, userRepository, {
            uuid,
            now,
            fetch: fetchImpl,
            identity,
          }), requestId);
        }
        if (url.pathname.startsWith("/api/runner/")) {
          const claims = await verifyRunner(request, env);
          const repository = repositoryFactory(env);
          return await withRequestId(
            await handleRunnerApi(request, env, repository, { uuid, now, fetch: fetchImpl }, claims),
            requestId,
          );
        }
        return await withRequestId(
          json({ error: { code: "not_found", message: "Route not found." }, request_id: requestId }, 404),
          requestId,
        );
      } catch (error) {
        return await withRequestId(errorResponse(error, requestId), requestId);
      }
    },

    async scheduled(event, env, ctx) {
      ctx.waitUntil((async () => {
        try {
          let scheduler = {
            mode: "unavailable",
            due: 0,
            queued: 0,
            dispatched: 0,
            failed: 0,
            failures_by_code: {},
            reconciliation: {
              cancelled_unavailable: 0,
              reset_dispatches: 0,
              expired_runs: 0,
              expired_queued: 0,
            },
          };
          let schedulerError = null;
          if (env.DB) {
            try {
              scheduler = await runScheduler(env, {
                repository: repositoryFactory(env),
                fetch: fetchImpl,
                now,
                uuid,
              });
            } catch (error) {
              schedulerError = error instanceof Error ? error.name : "UnknownError";
            }
          } else {
            schedulerError = "D1BindingMissing";
          }
          console.log(JSON.stringify({
            ok: !schedulerError && scheduler.failed === 0,
            cron: event.cron,
            scheduled_time: event.scheduledTime,
            mode: scheduler.mode,
            due: scheduler.due,
            queued: scheduler.queued,
            dispatched: scheduler.dispatched,
            failed: scheduler.failed,
            failures_by_code: scheduler.failures_by_code,
            reconciliation: scheduler.reconciliation,
            scheduler_error: schedulerError,
          }));
        } catch (error) {
          console.error(JSON.stringify({
            ok: false,
            cron: event.cron,
            scheduled_time: event.scheduledTime,
            error: error instanceof Error ? error.name : "UnknownError",
          }));
        }
      })());
    },
  };
}

export default createWorker();
