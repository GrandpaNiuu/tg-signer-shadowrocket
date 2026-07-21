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

async function existingGithubUser(repository, input) {
  if (input?.is_admin && typeof repository.getUser === "function") {
    return repository.getUser("legacy-admin");
  }
  if (input?.github_user_id && typeof repository.getUserByGithubId === "function") {
    return repository.getUserByGithubId(input.github_user_id);
  }
  return null;
}

function customGithubDisplayName(user) {
  const displayName = String(user?.display_name || "").trim();
  if (!displayName) return "";
  const githubName = String(user?.github_name || "").trim();
  const githubLogin = String(user?.github_login || "").trim();
  return displayName !== githubName && displayName !== githubLogin ? displayName : "";
}

async function upsertGithubUserPreservingDisplayName(repository, input) {
  const existing = await existingGithubUser(repository, input);
  const preservedName = customGithubDisplayName(existing);
  let user = await repository.upsertGithubUser(input);
  if (!preservedName || !repository.db?.prepare
    || (user?.display_name === preservedName && user?.github_name === preservedName)) return user;
  await repository.db.prepare(`UPDATE users SET display_name = ?, github_name = ?, updated_at = ?
    WHERE id = ?`)
    .bind(preservedName, preservedName, input.timestamp, user.id).run();
  return typeof repository.getUser === "function"
    ? repository.getUser(user.id)
    : { ...user, display_name: preservedName, github_name: preservedName };
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

export function withGithubProfilePersistence(repository) {
  const target = requiredRepository(repository);
  if (typeof target.upsertGithubUser !== "function") return target;
  return new Proxy(target, {
    get(current, property) {
      if (property === "upsertGithubUser") {
        return async (input) => upsertGithubUserPreservingDisplayName(current, input);
      }
      return bindRepositoryMember(current, property);
    },
  });
}

export function authenticationRepository(repository, now = () => new Date()) {
  const verified = withEmailVerificationLifecycle(requiredRepository(repository));
  return withPasswordRehash(withGithubProfilePersistence(verified), now);
}

export const __test = {
  consumeVerificationToken,
  createVerificationToken,
  customGithubDisplayName,
  existingGithubUser,
  upsertGithubUserPreservingDisplayName,
};
