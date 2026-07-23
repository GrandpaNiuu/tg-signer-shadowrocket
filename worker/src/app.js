import { handleAdminApi } from "./admin-api.js";
import { createAdminAuth } from "./admin-auth.js";
import { verifyRunnerRequest } from "./auth.js";
import {
  handleListenerDialogDirectoryApi,
  handleWorkspaceDialogDirectoryApi,
} from "./dialog-directory-api.js";
import { errorResponse, json } from "./http.js";
import { handleListenerEventApi } from "./listener-event-api.js";
import { handleListenerTaskApi } from "./listener-task-api.js";
import { handleListenerMediaUploadApi, handleWorkspaceMediaUploadApi } from "./media-upload-api.js";
import { handlePlatformAccountHealthApi } from "./platform-account-health.js";
import { handleProfileBrandingApi, handlePublicBrandingApi } from "./profile-branding.js";
import { createD1Repository } from "./repository.js";
import {
  adminWorkspaceRepository,
  authenticationRepository,
  runnerRepository,
  schedulerRepository,
} from "./repository-facade.js";
import { handleListenerApi, handleWorkspaceRealtimeApi } from "./realtime-automation.js";
import { handleRealtimeMultiSelectorWriteApi } from "./realtime-multi-selector-api.js";
import { handleRunnerApi } from "./runner-api-v2.js";
import { runScheduler } from "./scheduler.js";
import { handleSkillTaskApi } from "./skill-task-api.js";

const REQUIRED_READY_CONFIG = Object.freeze([
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "RUNNER_OIDC_AUDIENCE",
  "TASK_RUNNER_WORKFLOW_FILE",
  "LOGIN_WORKFLOW_FILE",
  "ADMIN_ORIGIN",
]);

const READY_SCHEMA_SQL = `SELECT COUNT(*) AS ready FROM sqlite_master
  WHERE type = 'table' AND name IN (
    'accounts', 'tasks', 'task_runs', 'secret_values',
    'bot_inspections', 'realtime_rules', 'listener_instances', 'listener_events'
  )`;
const REQUIRED_READY_TABLE_COUNT = 8;
const CF_RAY_PATTERN = /^[A-Za-z0-9-]{1,80}$/;

function defaultUuid() {
  return crypto.randomUUID();
}

function resolveRequestId(request, uuid) {
  const candidate = String(request.headers.get("cf-ray") || "").trim();
  return CF_RAY_PATTERN.test(candidate) ? candidate : uuid();
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

function rootKeyStatus(value) {
  const encoded = String(value || "").trim();
  if (!encoded) return "missing";
  try {
    return atob(encoded).length === 32 ? "ok" : "invalid";
  } catch {
    return "invalid";
  }
}

function listenerConfigured(env) {
  return String(env.LISTENER_API_TOKEN || "").trim().length >= 32;
}

async function checkReadiness(env) {
  const missingConfiguration = REQUIRED_READY_CONFIG.filter(
    (name) => !String(env[name] || "").trim(),
  );
  const githubToken = String(env.GITHUB_TOKEN || "").trim() ? "ok" : "missing";
  const secretRootKey = rootKeyStatus(env.SECRET_ROOT_KEY);

  let database = "missing";
  if (env.DB) {
    try {
      const result = await env.DB.prepare(READY_SCHEMA_SQL).first();
      database = Number(result?.ready) === REQUIRED_READY_TABLE_COUNT ? "ok" : "schema_missing";
    } catch {
      database = "error";
    }
  }

  const configuration = missingConfiguration.length === 0 ? "ok" : "missing";
  const credentials = githubToken === "ok" && secretRootKey === "ok"
    ? "ok"
    : secretRootKey === "invalid"
      ? "invalid"
      : "missing";
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
        github_token: githubToken,
        secret_root_key: secretRootKey,
        realtime_listener: listenerConfigured(env) ? "configured" : "disabled",
      },
      ...(missingConfiguration.length ? { missing_configuration: missingConfiguration } : {}),
    },
  };
}

function hasNonZeroValues(value) {
  return value && Object.values(value).some((entry) => Number(entry || 0) !== 0);
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
      const requestId = resolveRequestId(request, uuid);
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") {
          return await withRequestId(json({ ok: true, worker: "tg-signer-shadowrocket" }), requestId);
        }
        if (url.pathname === "/ready" && request.method === "GET") {
          const readiness = await checkReadiness(env);
          return await withRequestId(json(readiness.payload, readiness.status), requestId);
        }
        if (url.pathname === "/api/branding") {
          const repository = repositoryFactory(env);
          return await withRequestId(await handlePublicBrandingApi(request, repository), requestId);
        }
        if (url.pathname.startsWith("/api/auth/")) {
          const repository = authenticationRepository(repositoryFactory(env), now);
          return await withRequestId(await adminAuth.handle(request, env, repository), requestId);
        }
        if (url.pathname.startsWith("/api/listener/v1/runs")) {
          const repository = runnerRepository(repositoryFactory(env), now);
          return await withRequestId(await handleListenerTaskApi(request, env, repository, {
            uuid,
            now,
            fetch: fetchImpl,
          }), requestId);
        }
        if (url.pathname.startsWith("/api/listener/v1/media-uploads")) {
          const repository = repositoryFactory(env);
          return await withRequestId(await handleListenerMediaUploadApi(request, env, repository, {
            uuid,
            now,
            fetch: fetchImpl,
          }), requestId);
        }
        if (url.pathname.startsWith("/api/listener/v1/dialog-syncs")) {
          const repository = repositoryFactory(env);
          return await withRequestId(await handleListenerDialogDirectoryApi(request, env, repository), requestId);
        }
        if (url.pathname === "/api/listener/v1/events") {
          const repository = repositoryFactory(env);
          return await withRequestId(await handleListenerEventApi(request, env, repository, {
            fetch: fetchImpl,
          }), requestId);
        }
        if (url.pathname.startsWith("/api/listener/v1/")) {
          const repository = repositoryFactory(env);
          return await withRequestId(await handleListenerApi(request, env, repository, { fetch: fetchImpl }), requestId);
        }
        if (url.pathname.startsWith("/api/v1/")) {
          const repository = repositoryFactory(env);
          const verified = await verifyAdmin(request, env, repository);
          const identity = {
            ...verified,
            user_id: verified?.user_id || "legacy-admin",
            role: verified?.role || "admin",
          };
          if (url.pathname === "/api/v1/bot-inspections"
            && request.method === "POST"
            && !listenerConfigured(env)) {
            return await withRequestId(json({
              error: {
                code: "listener_not_configured",
                message: "机器人操作识别尚未启用。请联系管理员部署常驻 Listener。",
              },
            }, 503), requestId);
          }
          const context = {
            uuid,
            now,
            fetch: fetchImpl,
            identity,
          };
          const profileResponse = await handleProfileBrandingApi(request, repository, context);
          if (profileResponse) return await withRequestId(profileResponse, requestId);
          const platformHealthResponse = await handlePlatformAccountHealthApi(request, env, repository, context);
          if (platformHealthResponse) return await withRequestId(platformHealthResponse, requestId);
          const userRepository = adminWorkspaceRepository(repository, identity);
          const dialogDirectoryResponse = await handleWorkspaceDialogDirectoryApi(
            request,
            env,
            userRepository,
            context,
          );
          if (dialogDirectoryResponse) return await withRequestId(dialogDirectoryResponse, requestId);
          const mediaUploadResponse = await handleWorkspaceMediaUploadApi(request, env, userRepository, context);
          if (mediaUploadResponse) return await withRequestId(mediaUploadResponse, requestId);
          const realtimeWriteResponse = await handleRealtimeMultiSelectorWriteApi(request, userRepository, context);
          if (realtimeWriteResponse) return await withRequestId(realtimeWriteResponse, requestId);
          const realtimeResponse = await handleWorkspaceRealtimeApi(request, env, userRepository, context);
          if (realtimeResponse) return await withRequestId(realtimeResponse, requestId);
          const skillTaskResponse = await handleSkillTaskApi(request, env, userRepository, context);
          if (skillTaskResponse) return await withRequestId(skillTaskResponse, requestId);
          return await withRequestId(await handleAdminApi(request, env, userRepository, context), requestId);
        }
        if (url.pathname.startsWith("/api/runner/")) {
          const claims = await verifyRunner(request, env);
          const repository = runnerRepository(repositoryFactory(env), now);
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
          let scheduler = { mode: "unavailable", due: 0, queued: 0, dispatched: 0, failed: 0 };
          let schedulerError = null;
          if (env.DB) {
            try {
              scheduler = await runScheduler(env, {
                repository: schedulerRepository(repositoryFactory(env)),
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
          const log = {
            ok: !schedulerError && scheduler.failed === 0,
            cron: event.cron,
            scheduled_time: event.scheduledTime,
            mode: scheduler.mode,
            due: scheduler.due,
            queued: scheduler.queued,
            dispatched: scheduler.dispatched,
            failed: scheduler.failed,
            scheduler_error: schedulerError,
          };
          if (scheduler.failures_by_code && Object.keys(scheduler.failures_by_code).length) {
            log.failures_by_code = scheduler.failures_by_code;
          }
          if (scheduler.warnings_by_code && Object.keys(scheduler.warnings_by_code).length) {
            log.warnings_by_code = scheduler.warnings_by_code;
          }
          if (hasNonZeroValues(scheduler.reconciliation)) {
            log.reconciliation = scheduler.reconciliation;
          }
          console.log(JSON.stringify(log));
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
