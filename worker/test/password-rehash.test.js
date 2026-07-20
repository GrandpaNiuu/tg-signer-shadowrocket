import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSWORD_REHASH_CALLBACK,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from "../src/password.js";
import { withPasswordRehash } from "../src/password-repository.js";

const PEPPER = "test-password-pepper-2026";
const OLD_ENV = { PASSWORD_PEPPER: PEPPER, PASSWORD_HASH_ITERATIONS: "100000" };
const NEW_ENV = { PASSWORD_PEPPER: PEPPER, PASSWORD_HASH_ITERATIONS: "100001" };

function database(changes = 1) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            async run() {
              return { meta: { changes } };
            },
          };
        },
      };
    },
  };
}

test("password rehash is requested only when the configured target is higher", () => {
  const record = {
    password_algorithm: "PBKDF2-HMAC-SHA256",
    password_iterations: 100000,
  };
  assert.equal(passwordNeedsRehash(record, OLD_ENV), false);
  assert.equal(passwordNeedsRehash(record, NEW_ENV), true);
  assert.equal(passwordNeedsRehash({ ...record, password_iterations: 200000 }, NEW_ENV), false);
  assert.equal(passwordNeedsRehash({ ...record, password_algorithm: "unknown" }, NEW_ENV), false);
});

test("successful password verification upgrades an older hash", async () => {
  const record = await hashPassword("correct horse battery staple", OLD_ENV);
  let replacement = null;
  Object.defineProperty(record, PASSWORD_REHASH_CALLBACK, {
    enumerable: false,
    value: async (value) => {
      replacement = value;
      return true;
    },
  });

  assert.equal(await verifyPassword("correct horse battery staple", record, NEW_ENV), true);
  assert.equal(replacement.password_algorithm, "PBKDF2-HMAC-SHA256");
  assert.equal(replacement.password_iterations, 100001);
  assert.notEqual(replacement.password_hash, record.password_hash);
  assert.notEqual(replacement.password_salt, record.password_salt);
});

test("invalid passwords never trigger rehash", async () => {
  const record = await hashPassword("correct horse battery staple", OLD_ENV);
  let calls = 0;
  Object.defineProperty(record, PASSWORD_REHASH_CALLBACK, {
    enumerable: false,
    value: async () => { calls += 1; },
  });

  assert.equal(await verifyPassword("wrong password value", record, NEW_ENV), false);
  assert.equal(calls, 0);
});

test("rehash persistence is optimistic and does not overwrite a concurrent password change", async () => {
  const db = database();
  const user = {
    id: "user-1",
    status: "active",
    password_algorithm: "PBKDF2-HMAC-SHA256",
    password_hash: "old-hash",
    password_salt: "old-salt",
    password_iterations: 100000,
  };
  const repository = withPasswordRehash({
    db,
    async getUserByEmail() { return { ...user }; },
    async getSettings() { return { ok: true }; },
  }, () => new Date("2026-07-20T00:00:00.000Z"));

  const record = await repository.getUserByEmail("user@example.com");
  assert.equal(Object.keys(record).includes(String(PASSWORD_REHASH_CALLBACK)), false);
  assert.equal(typeof record[PASSWORD_REHASH_CALLBACK], "function");
  assert.equal(await record[PASSWORD_REHASH_CALLBACK]({
    password_algorithm: "PBKDF2-HMAC-SHA256",
    password_hash: "new-hash",
    password_salt: "new-salt",
    password_iterations: 100001,
  }), true);

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /WHERE id = \? AND status = 'active'/);
  assert.match(db.calls[0].sql, /password_hash = \? AND password_salt = \? AND password_iterations = \?/);
  assert.deepEqual(db.calls[0].bindings, [
    "PBKDF2-HMAC-SHA256",
    "new-hash",
    "new-salt",
    100001,
    "2026-07-20T00:00:00.000Z",
    "user-1",
    "PBKDF2-HMAC-SHA256",
    "old-hash",
    "old-salt",
    100000,
  ]);
  assert.deepEqual(await repository.getSettings(), { ok: true });
});

test("disabled users are never decorated for password rehash", async () => {
  const repository = withPasswordRehash({
    db: database(),
    async getUserByEmail() {
      return {
        id: "user-disabled",
        status: "disabled",
        password_algorithm: "PBKDF2-HMAC-SHA256",
        password_hash: "hash",
        password_salt: "salt",
        password_iterations: 100000,
      };
    },
  });
  const record = await repository.getUserByEmail("disabled@example.com");
  assert.equal(record[PASSWORD_REHASH_CALLBACK], undefined);
});
