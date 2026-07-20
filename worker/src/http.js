export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DATABASE_CONFLICTS = Object.freeze([
  {
    marker: "bot_inspection_account_busy",
    code: "account_busy",
    message: "这个 Telegram 账号正在执行普通任务，暂时不能进行机器人识别。请等待执行结束后重试。",
  },
  {
    marker: "realtime_account_has_tasks",
    code: "listener_account_has_tasks",
    message: "实时监听账号不能同时运行普通定时任务。请先停用该账号的全部普通任务，或改用专用账号。",
  },
  {
    marker: "account_reserved_for_realtime_listener",
    code: "account_reserved_for_realtime_listener",
    message: "这个 Telegram 账号正在用于 24 小时实时服务，不能同时运行普通定时任务。请停用实时规则，或改用其他账号。",
  },
]);

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function databaseConflict(error) {
  const value = error instanceof Error ? String(error.message || "") : "";
  return DATABASE_CONFLICTS.find((candidate) => value.includes(candidate.marker));
}

export function errorResponse(error, requestId) {
  if (error instanceof HttpError) {
    const payload = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      request_id: requestId,
    };
    return json(payload, error.status);
  }

  const conflict = databaseConflict(error);
  if (conflict) {
    return json({
      error: { code: conflict.code, message: conflict.message },
      request_id: requestId,
    }, 409);
  }

  console.error(JSON.stringify({
    level: "error",
    event: "unhandled_error",
    request_id: requestId,
    error: error instanceof Error ? error.name : "UnknownError",
  }));
  return json({
    error: { code: "internal_error", message: "An internal error occurred." },
    request_id: requestId,
  }, 500);
}

export async function readJson(request, maxBytes = 32_768) {
  const length = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large.");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large.");
  }
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

export function methodNotAllowed(allowed) {
  return json({ error: { code: "method_not_allowed", message: "Method not allowed." } }, 405, {
    allow: allowed.join(", "),
  });
}

export const __test = { databaseConflict };
