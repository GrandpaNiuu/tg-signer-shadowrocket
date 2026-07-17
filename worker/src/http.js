export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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
