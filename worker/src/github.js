import { HttpError } from "./http.js";

const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;
const MIN_DISPATCH_TIMEOUT_MS = 1_000;
const MAX_DISPATCH_TIMEOUT_MS = 30_000;

function dispatchTimeoutMs(env) {
  const configured = Number(env.GITHUB_DISPATCH_TIMEOUT_MS || DEFAULT_DISPATCH_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_DISPATCH_TIMEOUT_MS;
  return Math.min(MAX_DISPATCH_TIMEOUT_MS, Math.max(MIN_DISPATCH_TIMEOUT_MS, Math.floor(configured)));
}

export async function dispatchWorkflow(env, fetchImpl, { workflow, inputs = {} } = {}) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const workflowFile = workflow || env.TASK_RUNNER_WORKFLOW_FILE || "task-runner.yml";
  const ref = env.GITHUB_REF || "main";

  if (!owner || !repo || !env.GITHUB_TOKEN) {
    throw new HttpError(500, "github_config_missing", "Worker GitHub variables are incomplete.");
  }

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dispatchTimeoutMs(env));
  try {
    const response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "telegram-checkin-scheduler-worker",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref, inputs }),
      signal: controller.signal,
    });

    const body = await response.text();
    return { ok: response.status === 204, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export const __test = { dispatchTimeoutMs };
