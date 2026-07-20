const DEFAULT_WORKER_URL = "https://tg-signer-shadowrocket.q3j1h8.workers.dev";

async function requestJson(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      accept: "application/json",
      "user-agent": "telegram-checkin-live-worker-audit/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned invalid JSON.`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return { finalUrl: response.url, payload };
}

export function validateWorkerReadiness(payload) {
  if (payload?.ok !== true || payload?.worker !== "tg-signer-shadowrocket") {
    throw new Error("Worker readiness response is not healthy.");
  }
  const checks = payload.checks;
  if (!checks || typeof checks !== "object") {
    throw new Error("Worker readiness checks are missing.");
  }
  for (const name of ["database", "configuration", "credentials", "github_token", "secret_root_key"]) {
    if (checks[name] !== "ok") throw new Error(`Worker readiness check ${name} is ${checks[name] || "missing"}.`);
  }
  if (!new Set(["configured", "disabled"]).has(checks.realtime_listener)) {
    throw new Error("Worker realtime listener readiness field is missing or invalid.");
  }
  return {
    database: checks.database,
    configuration: checks.configuration,
    credentials: checks.credentials,
    realtime_listener: checks.realtime_listener,
  };
}

export async function runLiveWorkerAudit({
  workerUrl = DEFAULT_WORKER_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = new URL(workerUrl).origin;
  const health = await requestJson(`${origin}/health`, fetchImpl);
  if (health.payload?.ok !== true || health.payload?.worker !== "tg-signer-shadowrocket") {
    throw new Error("Worker health response is not healthy.");
  }
  const ready = await requestJson(`${origin}/ready`, fetchImpl);
  const checks = validateWorkerReadiness(ready.payload);
  return {
    requested_origin: origin,
    final_health_url: health.finalUrl,
    final_ready_url: ready.finalUrl,
    ...checks,
  };
}

async function main() {
  const result = await runLiveWorkerAudit({ workerUrl: process.env.WORKER_URL || DEFAULT_WORKER_URL });
  console.log(JSON.stringify(result, null, 2));
  if (result.realtime_listener === "disabled") {
    console.log("::warning title=Realtime Listener disabled::Worker and D1 are ready, but LISTENER_API_TOKEN has not been configured.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Live Worker audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
