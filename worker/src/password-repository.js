import { PASSWORD_REHASH_CALLBACK } from "./password.js";

function changes(result) {
  return Number(result?.meta?.changes || 0);
}

function bindRepositoryMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

async function updatePasswordIfCurrent(repository, user, replacement, timestamp) {
  if (!repository.db?.prepare || !user?.id) return false;
  const result = await repository.db.prepare(`UPDATE users SET
    password_algorithm = ?, password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
      AND password_algorithm = ? AND password_hash = ? AND password_salt = ? AND password_iterations = ?`)
    .bind(
      replacement.password_algorithm,
      replacement.password_hash,
      replacement.password_salt,
      replacement.password_iterations,
      timestamp,
      user.id,
      user.password_algorithm,
      user.password_hash,
      user.password_salt,
      Number(user.password_iterations),
    ).run();
  return changes(result) > 0;
}

function attachPasswordRehash(repository, user, now) {
  if (!user || user.status !== "active" || !repository.db?.prepare) return user;
  const snapshot = {
    id: user.id,
    password_algorithm: user.password_algorithm,
    password_hash: user.password_hash,
    password_salt: user.password_salt,
    password_iterations: Number(user.password_iterations),
  };
  Object.defineProperty(user, PASSWORD_REHASH_CALLBACK, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: async (replacement) => updatePasswordIfCurrent(
      repository,
      snapshot,
      replacement,
      now().toISOString(),
    ),
  });
  return user;
}

export function withPasswordRehash(repository, now = () => new Date()) {
  if (!repository || typeof repository.getUserByEmail !== "function") return repository;
  return new Proxy(repository, {
    get(target, property) {
      if (property !== "getUserByEmail") return bindRepositoryMember(target, property);
      return async (...args) => attachPasswordRehash(target, await target.getUserByEmail(...args), now);
    },
  });
}

export const __test = {
  attachPasswordRehash,
  updatePasswordIfCurrent,
};
