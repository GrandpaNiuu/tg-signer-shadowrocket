const JSON_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "x-requested-with": "tg-checkin-admin",
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = "REQUEST_FAILED", details = null, requestId = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

function encodeQuery(query = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function parseResponse(response, { unwrap = true } = {}) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiError("服务返回了无法识别的错误。", {
        status: response.status,
        code: "INVALID_RESPONSE",
      });
    }
  }

  if (!response.ok) {
    const error = payload?.error || {};
    throw new ApiError(error.message || "请求未完成，请稍后重试。", {
      status: response.status,
      code: error.code || "REQUEST_FAILED",
      details: error.details || null,
      requestId: error.request_id || response.headers.get("x-request-id"),
    });
  }

  return unwrap ? (payload?.data ?? payload ?? null) : (payload ?? null);
}

export class ApiClient {
  constructor({ baseUrl = "/api/v1", fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "GET", body, query, headers = {}, signal, unwrap = true } = {}) {
    const controller = signal ? null : new AbortController();
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}${encodeQuery(query)}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { ...JSON_HEADERS, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal || controller.signal,
      });
      return await parseResponse(response, { unwrap });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.name === "AbortError") {
        throw new ApiError("请求超时，请检查服务状态后重试。", { code: "REQUEST_TIMEOUT" });
      }
      throw new ApiError("无法连接管理服务。", { code: "NETWORK_ERROR" });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async listAll(path, query = {}) {
    const items = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const page = await this.request(path, {
        query: { ...query, cursor },
        unwrap: false,
      });
      if (!Array.isArray(page?.data)) {
        throw new ApiError("服务返回了无效的列表数据。", { code: "INVALID_RESPONSE" });
      }
      items.push(...page.data);
      cursor = page.pagination?.next_cursor || null;
      if (cursor && seenCursors.has(cursor)) {
        throw new ApiError("服务返回了重复的分页游标。", { code: "INVALID_RESPONSE" });
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return items;
  }

  dashboard(date) { return this.request("/dashboard", { query: { date } }); }

  accounts() { return this.listAll("/accounts"); }
  createAccount(account) { return this.request("/accounts", { method: "POST", body: account }); }
  updateAccount(id, patch) { return this.request(`/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }); }
  validateAccount(id) { return this.request(`/accounts/${encodeURIComponent(id)}/validate`, { method: "POST", body: {} }); }
  deleteAccount(id) { return this.request(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }); }

  createLoginFlow(input) { return this.request("/login-flows", { method: "POST", body: input }); }
  loginFlow(id) { return this.request(`/login-flows/${encodeURIComponent(id)}`); }
  submitLoginCode(id, code) { return this.request(`/login-flows/${encodeURIComponent(id)}/code`, { method: "POST", body: { code } }); }
  submitLoginPassword(id, password) { return this.request(`/login-flows/${encodeURIComponent(id)}/password`, { method: "POST", body: { password } }); }
  resendLoginCode(id) { return this.request(`/login-flows/${encodeURIComponent(id)}/resend`, { method: "POST", body: {} }); }
  cancelLoginFlow(id) { return this.request(`/login-flows/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }); }

  tasks() { return this.listAll("/tasks"); }
  createTask(task) { return this.request("/tasks", { method: "POST", body: task }); }
  updateTask(id, patch) { return this.request(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }); }
  deleteTask(id) { return this.request(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  runTask(id) {
    const idempotencyKey = globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return this.request(`/tasks/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: {},
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  skills() { return this.request("/skills"); }

  taskRuns(query) { return this.listAll("/task-runs", query); }
  taskRun(id) { return this.request(`/task-runs/${encodeURIComponent(id)}`); }

  settings() { return this.request("/settings"); }
  updateSettings(values) { return this.request("/settings", { method: "PATCH", body: { values } }); }
  updateNotificationSettings(patch) {
    return this.request("/settings/notifications", { method: "PATCH", body: patch });
  }

  identity() {
    const identityClient = new ApiClient({ baseUrl: "/api", fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
    return identityClient.request("/identity");
  }
}

export const __test = { encodeQuery, parseResponse };
