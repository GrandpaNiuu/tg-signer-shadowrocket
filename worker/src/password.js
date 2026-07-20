const encoder = new TextEncoder();
const PASSWORD_ALGORITHM = "PBKDF2-HMAC-SHA256";

export const PASSWORD_REHASH_CALLBACK = Symbol("password_rehash_callback");

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

export function passwordNeedsRehash(record, env) {
  const current = Number(record?.password_iterations);
  return record?.password_algorithm === PASSWORD_ALGORITHM
    && Number.isInteger(current)
    && current >= 100000
    && current < iterationsFromEnv(env);
}

export async function hashPassword(password, env) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = iterationsFromEnv(env);
  const hash = await derive(password, salt, iterations, env);
  return {
    password_algorithm: PASSWORD_ALGORITHM,
    password_hash: bytesToBase64Url(hash),
    password_salt: bytesToBase64Url(salt),
    password_iterations: iterations,
  };
}

export async function verifyPassword(password, record, env) {
  if (record?.password_algorithm !== PASSWORD_ALGORITHM
    || !record.password_hash || !record.password_salt
    || !Number.isInteger(Number(record.password_iterations))) return false;
  const actual = await derive(
    password,
    base64UrlToBytes(record.password_salt),
    Number(record.password_iterations),
    env,
  );
  const valid = constantTimeEqual(actual, base64UrlToBytes(record.password_hash));
  if (valid && passwordNeedsRehash(record, env)
    && typeof record[PASSWORD_REHASH_CALLBACK] === "function") {
    try {
      await record[PASSWORD_REHASH_CALLBACK](await hashPassword(password, env));
    } catch {
      // Rehash is best-effort. The verified existing hash remains valid if the
      // optimistic update loses a race or D1 is temporarily unavailable.
    }
  }
  return valid;
}

export const __test = { constantTimeEqual, iterationsFromEnv };
