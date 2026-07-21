const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const nativeFetch = globalThis.fetch.bind(globalThis);

function requestMethod(input, init) {
  return String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestUrl(input) {
  return new URL(input instanceof Request ? input.url : String(input), globalThis.location.href);
}

globalThis.fetch = function sameOriginAdminFetch(input, init = {}) {
  const method = requestMethod(input, init);
  const url = requestUrl(input);
  if (url.origin !== globalThis.location.origin || SAFE_METHODS.has(method)) {
    return nativeFetch(input, init);
  }

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init.headers || {})) headers.set(name, value);
  if (!headers.has("x-requested-with")) headers.set("x-requested-with", "tg-checkin-admin");

  return nativeFetch(input, { ...init, headers });
};

export const __test = { requestMethod, requestUrl };
