import { HttpError } from "./http.js";

export async function dispatchWorkflow(env, fetchImpl, { workflow, inputs = {} } = {}) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const workflowFile = workflow || env.TASK_RUNNER_WORKFLOW_FILE || "task-runner.yml";
  const ref = env.GITHUB_REF || "main";

  if (!owner || !repo || !env.GITHUB_TOKEN) {
    throw new HttpError(500, "github_config_missing", "Worker GitHub variables are incomplete.");
  }

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
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
  });

  const body = await response.text();
  return { ok: response.status === 204, status: response.status, body };
}
