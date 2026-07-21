// Compatibility entry: the Worker name and main file stay unchanged.
import { createWorker as createApplicationWorker } from "./src/app.js";
import { enforceListenerLeader } from "./src/listener-leader.js";

export function createWorker(dependencies = {}) {
  const application = createApplicationWorker(dependencies);
  return {
    async fetch(request, env, context) {
      const response = await application.fetch(request, env, context);
      const url = new URL(request.url);
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
