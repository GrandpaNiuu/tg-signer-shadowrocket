import { handleAdminApi } from "./admin-api.js";
import { verifyAdminRequest, verifyRunnerRequest } from "./auth.js";
import { cronMatches } from "./cron.js";
import { dispatchWorkflow } from "./github.js";
import { errorResponse, json } from "./http.js";
import { createD1Repository } from "./repository.js";
import { handleRunnerApi } from "./runner-api.js";
import { runScheduler } from "./scheduler.js";

function defaultUuid() {
  return crypto.randomUUID();
}

export function createWorker(dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const uuid = dependencies.uuid || defaultUuid;
  const now = dependencies.now || (() => new Date());
  const repositoryFactory = dependencies.repositoryFactory || ((env) => {
    if (!env.DB) throw new Error("D1 binding DB is missing.");
    return createD1Repository(env.DB);
  });
  const verifyAdmin = dependencies.verifyAdmin || ((request, env) => verifyAdminRequest(request, env, { fetch: fetchImpl }));
  const verifyRunner = dependencies.verifyRunner || ((request, env) => verifyRunnerRequest(request, env, { fetch: fetchImpl }));

  return {
    async fetch(request, env) {
      const requestId = request.headers.get("cf-ray") || uuid();
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") {
          return json({ ok: true, worker: "tg-signer-shadowrocket" });
        }
        if (url.pathname.startsWith("/api/v1/")) {
          await verifyAdmin(request, env);
          const repository = repositoryFactory(env);
          return await handleAdminApi(request, env, repository, { uuid, now, fetch: fetchImpl });
        }
        if (url.pathname.startsWith("/api/runner/")) {
          const claims = await verifyRunner(request, env);
          const repository = repositoryFactory(env);
          return await handleRunnerApi(request, env, repository, { uuid, now, fetch: fetchImpl }, claims);
        }
        if (url.pathname !== "/run") {
          return json({ error: { code: "not_found", message: "Route not found." }, request_id: requestId }, 404);
        }
        if (request.method !== "GET" && request.method !== "POST") {
          return json({ error: { code: "method_not_allowed", message: "Method not allowed." }, request_id: requestId }, 405, { allow: "GET, POST" });
        }

        const providedKey = request.headers.get("x-trigger-key") || url.searchParams.get("key") || "";
        if (!env.TRIGGER_KEY || providedKey !== env.TRIGGER_KEY) {
          return json({ error: { code: "unauthorized", message: "Unauthorized." }, request_id: requestId }, 401);
        }

        const result = await dispatchWorkflow(env, fetchImpl, { inputs: {} });
        if (!result.ok) {
          return json({
            error: { code: "github_dispatch_failed", message: "GitHub Actions dispatch failed." },
            request_id: requestId,
          }, 502);
        }
        return json({ ok: true, message: "GitHub Actions workflow dispatched." });
      } catch (error) {
        return errorResponse(error, requestId);
      }
    },

    async scheduled(event, env, ctx) {
      ctx.waitUntil((async () => {
        try {
          // A legacy dispatch is allowed only after D1 explicitly reports that
          // scheduler_mode is "legacy". Treat a missing/unreadable control
          // plane as unavailable so a transient D1 failure cannot trigger the
          // legacy workflow and then run the same task again after recovery.
          let scheduler = { mode: "unavailable", due: 0, queued: 0, dispatched: 0, failed: 0 };
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
          let legacyDispatch = null;
          const scheduledDate = new Date(event.scheduledTime);
          if (scheduler.mode === "legacy" && cronMatches(env.LEGACY_CRON || "0 16 * * *", "UTC", scheduledDate)) {
            legacyDispatch = await dispatchWorkflow(env, fetchImpl, { inputs: {} });
          }
          console.log(JSON.stringify({
            ok: !schedulerError && scheduler.failed === 0 && (!legacyDispatch || legacyDispatch.ok),
            cron: event.cron,
            scheduled_time: event.scheduledTime,
            mode: scheduler.mode,
            due: scheduler.due,
            queued: scheduler.queued,
            dispatched: scheduler.dispatched,
            failed: scheduler.failed,
            scheduler_error: schedulerError,
            legacy_dispatched: Boolean(legacyDispatch?.ok),
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
