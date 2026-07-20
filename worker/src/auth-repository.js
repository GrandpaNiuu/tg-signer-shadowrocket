import { withPasswordRehash } from "./password-repository.js";

function requiredRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new Error("Repository is unavailable.");
  }
  return repository;
}

function bindRepositoryMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

async function createVerificationToken(repository, token) {
  if (!repository.db?.prepare || typeof repository.db.batch !== "function") {
    return repository.createAuthToken(token);
  }
  await repository.db.batch([
    repository.db.prepare(`DELETE FROM auth_tokens
      WHERE user_id = ? AND token_type = 'verify_email'
      AND (consumed_at IS NOT NULL OR expires_at <= ?)`)
      .bind(token.user_id, token.created_at),
    repository.db.prepare(`INSERT INTO auth_tokens
      (id, token_hash, user_id, token_type, expires_at, created_at)
      VALUES (?, ?, ?, 'verify_email', ?, ?)`)
      .bind(token.id, token.token_hash, token.user_id, token.expires_at, token.created_at),
  ]);
}

async function consumeVerificationToken(repository, tokenHash, timestamp) {
  let user = await repository.consumeEmailVerification(tokenHash, timestamp);
  if (!user || !repository.db?.prepare) return user;

  if (!user.email_verified_at && user.status === "active") {
    await repository.db.prepare(`UPDATE users SET email_verified_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND email_verified_at IS NULL`)
      .bind(timestamp, timestamp, user.id).run();
    user = typeof repository.getUser === "function"
      ? await repository.getUser(user.id)
      : { ...user, email_verified_at: timestamp };
  }

  await repository.db.prepare(`DELETE FROM auth_tokens
    WHERE user_id = ? AND token_type = 'verify_email'`).bind(user.id).run();
  return user;
}

export function withEmailVerificationLifecycle(repository) {
  const target = requiredRepository(repository);
  if (typeof target.consumeEmailVerification !== "function"
    || typeof target.createAuthToken !== "function") return target;
  return new Proxy(target, {
    get(current, property) {
      if (property === "createAuthToken") {
        return async (token) => token?.token_type === "verify_email"
          ? createVerificationToken(current, token)
          : current.createAuthToken(token);
      }
      if (property === "consumeEmailVerification") {
        return async (tokenHash, timestamp) => consumeVerificationToken(current, tokenHash, timestamp);
      }
      return bindRepositoryMember(current, property);
    },
  });
}

export function authenticationRepository(repository, now = () => new Date()) {
  return withPasswordRehash(withEmailVerificationLifecycle(requiredRepository(repository)), now);
}

export const __test = {
  consumeVerificationToken,
  createVerificationToken,
};
