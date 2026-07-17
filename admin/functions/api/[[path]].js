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

function accessEmail(request) {
  return request.headers.get("cf-access-authenticated-user-email") || "";
}

function isSameOriginWrite(request) {
  if (SAFE_METHODS.has(request.method)) return true;

  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  const requestedWith = request.headers.get("x-requested-with");
  return origin === expected && requestedWith === "tg-checkin-admin";
}

function proxiedRequest(request, adminEmail) {
  const headers = new Headers(request.headers);
  headers.delete("x-admin-email");
  if (adminEmail) headers.set("x-admin-email", adminEmail);
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
  const url = new URL(request.url);

  if (url.pathname === "/api/identity") {
    const email = accessEmail(request);
    return json({
      data: {
        authenticated: Boolean(email),
        email: email || null,
        provider: "cloudflare_access",
      },
    });
  }

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

  const email = accessEmail(request);
  if (env.REQUIRE_ACCESS_HEADER === "true" && !email) {
    return json({
      error: {
        code: "ACCESS_REQUIRED",
        message: "请先通过 Cloudflare Access 登录。",
      },
    }, 401);
  }

  try {
    const response = await env.CONTROL_PLANE.fetch(proxiedRequest(request, email));
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

export const __test = { accessEmail, isSameOriginWrite, proxiedRequest };
