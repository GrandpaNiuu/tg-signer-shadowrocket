const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isSameOriginWrite(request) {
  if (SAFE_METHODS.has(request.method)) return true;

  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  const requestedWith = request.headers.get("x-requested-with");
  return origin === expected && requestedWith === "tg-checkin-admin";
}

function proxiedRequest(request) {
  const headers = new Headers(request.headers);
  headers.delete("x-admin-email");
  headers.delete("cf-access-authenticated-user-email");
  headers.delete("cf-access-jwt-assertion");
  headers.set("x-forwarded-by", "telegram-checkin-pages");

  return new Request(request.url, {
    method: request.method,
    headers,
    body: SAFE_METHODS.has(request.method) ? undefined : request.body,
    redirect: "manual",
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!isSameOriginWrite(request)) {
    return json({
      error: {
        code: "CSRF_CHECK_FAILED",
        message: "写请求必须来自当前管理后台。",
      },
    }, 403);
  }

  if (!env.CONTROL_PLANE || typeof env.CONTROL_PLANE.fetch !== "function") {
    return json({
      error: {
        code: "SERVICE_BINDING_MISSING",
        message: "Pages 尚未绑定管理 Worker。",
      },
    }, 503);
  }

  try {
    const response = await env.CONTROL_PLANE.fetch(proxiedRequest(request));
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return json({
      error: {
        code: "CONTROL_PLANE_UNAVAILABLE",
        message: "管理服务暂时不可用，请稍后重试。",
      },
    }, 502);
  }
}

export const __test = { isSameOriginWrite, proxiedRequest };
