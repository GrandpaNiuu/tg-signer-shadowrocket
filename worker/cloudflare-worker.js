// Compatibility entry: the Worker name and main file stay unchanged.
import { createWorker as createApplicationWorker } from "./src/app.js";
import { createAdminAuth } from "./src/admin-auth.js";
import { errorResponse } from "./src/http.js";
import { enforceListenerLeader } from "./src/listener-leader.js";
import { handleProfileBrandingApi } from "./src/profile-branding-api.js";
import { createD1Repository } from "./src/repository.js";

export function createWorker(dependencies = {}) {
  const application = createApplicationWorker(dependencies);
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || (() => new Date());
  const adminAuth = dependencies.adminAuth || createAdminAuth({ fetch: fetchImpl, now });
  const repositoryFactory = dependencies.repositoryFactory || ((env) => createD1Repository(env.DB));
  const verifyAdmin = dependencies.verifyAdmin
    || ((request, env, repository) => adminAuth.verify(request, env, repository));

  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/profile" || url.pathname === "/api/v1/platform-branding") {
        const requestId = crypto.randomUUID();
        try {
          const repository = repositoryFactory(env);
          const verified = await verifyAdmin(request, env, repository);
          const identity = {
            ...verified,
            user_id: verified?.user_id || "legacy-admin",
            role: verified?.role || "admin",
          };
          const response = await handleProfileBrandingApi(request, env, { identity, now, fetch: fetchImpl });
          const headers = new Headers(response.headers);
          headers.set("x-request-id", requestId);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch (error) {
          return errorResponse(error, requestId);
        }
      }

      const response = await application.fetch(request, env, context);
      if (request.method === "GET" && url.pathname === "/api/listener/v1/config") {
        return enforceListenerLeader(request, env, response, dependencies.now || (() => new Date()));
      }
      return response;
    },
    scheduled(event, env, context) {
      return application.scheduled(event, env, context);
    },
  };
}

export default createWorker();
