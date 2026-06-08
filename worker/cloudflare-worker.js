/**
 * Cloudflare Worker: scheduled trigger for GitHub Actions workflow_dispatch.
 *
 * Required Worker secrets:
 * - GITHUB_TOKEN
 * - TRIGGER_KEY, only for manual /run endpoint
 *
 * Worker variables from wrangler.toml:
 * - GITHUB_OWNER
 * - GITHUB_REPO
 * - GITHUB_WORKFLOW_FILE
 * - GITHUB_REF
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
    return { ok: false, status: 500, body: "Worker GitHub variables are incomplete." };
  }

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "tg-signer-scheduler-worker",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref, inputs }),
  });

  const text = await res.text();
  return {
    ok: res.status === 204,
    status: res.status,
    body: text || "",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed." }, 405);
    }

    if (url.pathname !== "/run") {
      return json({ ok: false, error: "Use /run to trigger task." }, 404);
    }

    const providedKey = url.searchParams.get("key") || request.headers.get("x-trigger-key") || "";
    if (!env.TRIGGER_KEY || providedKey !== env.TRIGGER_KEY) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }

    const result = await dispatchWorkflow(env, {});
    if (result.ok) {
      return json({ ok: true, message: "GitHub Actions workflow dispatched." });
    }
    return json({ ok: false, status: result.status, body: result.body }, 502);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await dispatchWorkflow(env, {});
      console.log(JSON.stringify({
        ok: result.ok,
        status: result.status,
        cron: event.cron,
        scheduledTime: event.scheduledTime,
      }));
      if (!result.ok) {
        console.log(result.body);
      }
    })());
  },
};
