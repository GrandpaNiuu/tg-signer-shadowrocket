import { handleAdminApi } from "./admin-api.js";
import { createAdminAuth } from "./admin-auth.js";
import { verifyRunnerRequest } from "./auth.js";
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
  const adminAuth = dependencies.adminAuth || createAdminAuth({ fetch: fetchImpl, now });
  const verifyAdmin = dependencies.verifyAdmin || ((request, env, repository) => adminAuth.verify(request, env, repository));
  const verifyRunner = dependencies.verifyRunner || ((request, env) => verifyRunnerRequest(request, env, { fetch: fetchImpl }));

  return {
    async fetch(request, env) {
      const requestId = request.headers.get("cf-ray") || uuid();
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") {
          return json({ ok: true, worker: "tg-signer-shadowrocket" });
        }
        if (url.pathname.startsWith("/api/auth/")) {
          const repository = repositoryFactory(env);
          return await adminAuth.handle(request, env, repository);
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
          return await handleAdminApi(request, env, userRepository, {
            uuid,
            now,
            fetch: fetchImpl,
            identity,
          });
        }
        if (url.pathname.startsWith("/api/runner/")) {
          const claims = await verifyRunner(request, env);
          const repository = repositoryFactory(env);
          return await handleRunnerApi(request, env, repository, { uuid, now, fetch: fetchImpl }, claims);
        }
        return json({ error: { code: "not_found", message: "Route not found." }, request_id: requestId }, 404);
      } catch (error) {
        return errorResponse(error, requestId);
      }
    },

    async scheduled(event, env, ctx) {
      ctx.waitUntil((async () => {
        try {
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
          console.log(JSON.stringify({
            ok: !schedulerError && scheduler.failed === 0,
            cron: event.cron,
            scheduled_time: event.scheduledTime,
            mode: scheduler.mode,
            due: scheduler.due,
            queued: scheduler.queued,
            dispatched: scheduler.dispatched,
            failed: scheduler.failed,
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
