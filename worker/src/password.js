const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function iterationsFromEnv(env) {
  const configured = Number(env.PASSWORD_HASH_ITERATIONS || 100000);
  return Number.isInteger(configured) && configured >= 100000 && configured <= 1000000
    ? configured
    : 100000;
}

function passwordMaterial(password, env) {
  const pepper = String(env.PASSWORD_PEPPER || "");
  if (pepper.length < 16) throw new Error("PASSWORD_PEPPER is not configured.");
  return encoder.encode(`${password}\u0000${pepper}`);
}

async function derive(password, salt, iterations, env) {
  const key = await crypto.subtle.importKey("raw", passwordMaterial(password, env), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations,
  }, key, 256);
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

export async function hashPassword(password, env) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = iterationsFromEnv(env);
  const hash = await derive(password, salt, iterations, env);
  return {
    password_algorithm: "PBKDF2-HMAC-SHA256",
    password_hash: bytesToBase64Url(hash),
    password_salt: bytesToBase64Url(salt),
    password_iterations: iterations,
  };
}

export async function verifyPassword(password, record, env) {
  if (record?.password_algorithm !== "PBKDF2-HMAC-SHA256"
    || !record.password_hash || !record.password_salt
    || !Number.isInteger(Number(record.password_iterations))) return false;
  const actual = await derive(
    password,
    base64UrlToBytes(record.password_salt),
    Number(record.password_iterations),
    env,
  );
  return constantTimeEqual(actual, base64UrlToBytes(record.password_hash));
}

export const __test = { constantTimeEqual, iterationsFromEnv };
