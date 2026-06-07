/**
 * Cloudflare Worker: trigger GitHub Actions workflow_dispatch.
 *
 * Required Worker variables:
 * - TRIGGER_KEY
 * - GITHUB_TOKEN
 * - GITHUB_OWNER
 * - GITHUB_REPO
 * - GITHUB_WORKFLOW_FILE, optional, default daily-checkin.yml
 * - GITHUB_REF, optional, default main
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function dispatchWorkflow(env, inputs = {}) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const workflow = env.GITHUB_WORKFLOW_FILE || "daily-checkin.yml";
  const ref = env.GITHUB_REF || "main";

  if (!owner || !repo || !env.GITHUB_TOKEN) {
    return json({ ok: false, error: "Worker GitHub variables are incomplete." }, 500);
  }

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "tg-signer-shadowrocket-worker",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref, inputs }),
  });

  if (res.status === 204) {
    return json({ ok: true, message: "GitHub Actions workflow dispatched." });
  }

  const text = await res.text();
  return json({ ok: false, status: res.status, body: text }, 502);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed." }, 405);
    }

    const providedKey = url.searchParams.get("key") || request.headers.get("x-trigger-key") || "";
    if (!env.TRIGGER_KEY || providedKey !== env.TRIGGER_KEY) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }

    if (url.pathname !== "/run") {
      return json({ ok: false, error: "Use /run to trigger task." }, 404);
    }

    const inputs = {};
    for (const name of ["mode", "target_chat", "checkin_text", "task_name"]) {
      const value = url.searchParams.get(name);
      if (value) inputs[name] = value;
    }

    return dispatchWorkflow(env, inputs);
  },
};
