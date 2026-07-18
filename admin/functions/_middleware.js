const DEFAULT_CANONICAL_HOST = "grandpaniu.ccwu.cc";

function canonicalHost(env) {
  const value = String(env.CANONICAL_HOST || DEFAULT_CANONICAL_HOST).trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value) ? value : DEFAULT_CANONICAL_HOST;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetHost = canonicalHost(context.env);
  if (url.hostname.endsWith(".pages.dev") && url.hostname !== targetHost) {
    url.hostname = targetHost;
    url.port = "";
    url.protocol = "https:";
    return Response.redirect(url.toString(), 308);
  }
  return context.next();
}

export const __test = { canonicalHost };
