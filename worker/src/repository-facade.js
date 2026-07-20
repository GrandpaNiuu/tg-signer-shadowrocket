import { withDispatchErrorCodes } from "./dispatch-repository.js";
import { withPasswordRehash } from "./password-repository.js";
import { withRunnerSessionState } from "./runner-repository.js";

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

function withLegacyEmailVerification(repository) {
  if (typeof repository.consumeEmailVerification !== "function") return repository;
  return new Proxy(repository, {
    get(target, property) {
      if (property !== "consumeEmailVerification") return bindRepositoryMember(target, property);
      return async (tokenHash, timestamp) => {
        const user = await target.consumeEmailVerification(tokenHash, timestamp);
        if (!user || user.email_verified_at || user.status !== "active" || !target.db?.prepare) return user;
        await target.db.prepare(`UPDATE users SET email_verified_at = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND email_verified_at IS NULL`)
          .bind(timestamp, timestamp, user.id).run();
        return typeof target.getUser === "function" ? target.getUser(user.id) : { ...user, email_verified_at: timestamp };
      };
    },
  });
}

export function authenticationRepository(repository, now = () => new Date()) {
  return withPasswordRehash(withLegacyEmailVerification(requiredRepository(repository)), now);
}

export function adminWorkspaceRepository(repository, identity) {
  const target = requiredRepository(repository);
  if (typeof target.forUser !== "function") {
    throw new Error("User-scoped Repository is required for administrator API routes.");
  }
  return withDispatchErrorCodes(target.forUser(identity));
}

export function runnerRepository(repository, now = () => new Date()) {
  return withRunnerSessionState(
    withDispatchErrorCodes(requiredRepository(repository)),
    now,
  );
}

export function schedulerRepository(repository) {
  return withDispatchErrorCodes(requiredRepository(repository));
}

export const __test = { withLegacyEmailVerification };
