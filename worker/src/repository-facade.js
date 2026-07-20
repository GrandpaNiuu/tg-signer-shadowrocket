import { withDispatchErrorCodes } from "./dispatch-repository.js";
import { withPasswordRehash } from "./password-repository.js";
import { withRunnerSessionState } from "./runner-repository.js";

function requiredRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new Error("Repository is unavailable.");
  }
  return repository;
}

export function authenticationRepository(repository, now = () => new Date()) {
  return withPasswordRehash(requiredRepository(repository), now);
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
