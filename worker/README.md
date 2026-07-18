# Cloudflare Worker control plane

This directory keeps the original `tg-signer-shadowrocket` Worker and `/run`
trigger while adding the D1-backed personal control plane. It is a native ES
module Worker with no third-party runtime dependencies.

## Routes

An opaque D1-backed GitHub administrator session protects all administrator
routes. Public authentication routes are:

- `GET /api/auth/github/start`
- `GET /api/auth/github/callback`
- `GET /api/auth/me` (`GET /api/auth/session` remains as a compatibility alias)
- `POST /api/auth/logout`

Authenticated routes are:

- `GET /api/v1/dashboard`
- `GET|POST /api/v1/accounts`, `GET|PATCH|DELETE /api/v1/accounts/:id`
- `GET|POST /api/v1/tasks`, `GET|PATCH|DELETE /api/v1/tasks/:id`
- `POST /api/v1/tasks/:id/runs`
- `GET /api/v1/skills`
- `GET /api/v1/task-runs`, `GET /api/v1/task-runs/:id`
- `GET|PATCH /api/v1/settings`
- `POST /api/v1/login-flows`, `GET /api/v1/login-flows/:id`
- `POST /api/v1/login-flows/:id/code|password|cancel`

GitHub OIDC protects all runner routes. A dispatch input contains only the
opaque run or flow id:

- `POST /api/runner/runs/:id/claim|attempts|complete`
- `POST /api/runner/login-flows/:id/claim|events|complete`
- `POST /api/runner/login-flows/:id/input/claim`
- `POST /api/runner/migrations/legacy`

Successful administrator responses use `{ "data": ... }`; list responses also
include `pagination`. Errors always use
`{ "error": { "code": "...", "message": "...", "details": ... } }`.
Runner claim responses intentionally follow the Runner's direct TaskSpec schema.

Manual task execution requires an `Idempotency-Key` header of 8-128 characters
matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Its stable per-task dedupe key means a
retry returns the original run without dispatching another workflow. Enqueue,
dispatch reservation, and runner claim each re-check that the account is enabled
and connected; reconciliation cancels queued work when that stops being true.

For a `tg_signer` task, administrator writes may include `tg_signer_import` as
plain JSON or base64. It is encrypted with task-bound AES-GCM AAD and is never
returned by an administrator endpoint; task responses expose only
`has_tg_signer_import`. On PATCH, omission preserves it, a string replaces it,
and `null` deletes it. The runner claim maps it to `task.params.import_blob` with
`import_encoding: "auto"`.

The compatibility `GET|POST /run` route still accepts `x-trigger-key`; the old
query-string key remains supported for existing callers. Prefer the header so
the key is not placed in URLs.

## Configuration

Create the D1 database, Direct Upload Pages project, and one GitHub OAuth App.
The OAuth App callback is
`https://telegram-checkin-admin.pages.dev/api/auth/github/callback`. Cloudflare Access and its
billing activation are not used. The Worker deployment workflow applies all
pending D1 migrations remotely before it deploys the Worker. Do not commit
secrets.

Worker secrets:

- `GITHUB_TOKEN` and `TRIGGER_KEY` (legacy compatibility)
- `SECRET_ROOT_KEY`: base64 for exactly 32 random bytes
- optional `SECRET_ROOT_KEY_V1`, `SECRET_ROOT_KEY_V2`, ... during key rotation
- `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`

Variables:

- GitHub owner, repository, branch, and three workflow filenames
- `RUNNER_OIDC_AUDIENCE`
- `ADMIN_ORIGIN`, `ADMIN_GITHUB_LOGIN`, and immutable `ADMIN_GITHUB_USER_ID`
- optional `ADMIN_SESSION_TTL_SECONDS` (5 minutes to 30 days; default 7 days)
- optional explicit `RUNNER_WORKFLOW_REF`, `LOGIN_WORKFLOW_REF`, and
  `MIGRATION_WORKFLOW_REF`

The Cloudflare deployment token needs Workers Scripts Edit, D1 Edit, and
Cloudflare Pages Edit for the target account. `GITHUB_TOKEN` needs Actions:
write on this repository so the Worker can dispatch the three workflows.

`scheduler_mode` starts as `legacy`. In that mode the minute tick dispatches the
old workflow only when `LEGACY_CRON` matches. Change it to `d1` only after a
successful dry-run and legacy import; switching it back is the rollback.

## Security invariants

- API hash, session, proxy credentials, verification code, 2FA password, and
  notification credentials are AES-256-GCM ciphertext at rest.
- GitHub OAuth states are short-lived, one-time values whose SHA-256 hashes are
  stored in D1; authorization codes are bound with S256 PKCE. Administrator
  session tokens are random 256-bit values; D1 stores
  only their hashes, and logout revokes the matching row immediately.
- Both the configured GitHub login and immutable numeric user id must match.
- Each ciphertext uses a random 96-bit nonce and AAD bound to purpose, owner,
  and key version.
- Code and 2FA secrets have the login flow's short expiry and can only be
  reclaimed by the same authenticated workflow run while its state still
  matches; rejected values are deleted before replacement input is accepted.
- Connected, failed, cancelled, and expired login flows clear both secret
  references and delete all `login_flow`-owned code/2FA ciphertext immediately;
  account-owned API credentials and the connected Session are retained.
- Administrator cancellation and an initial GitHub interactive-login dispatch
  failure delete the entire provisional account, flow, and owned ciphertext in
  one D1 batch, so an abandoned web-login attempt cannot leave a ghost account.
  Cancelling Session validation preserves the already imported account and its
  encrypted credentials, but leaves it disconnected.
- A lost login-input HTTP response is retry-safe: the same authenticated GitHub
  workflow run can reclaim that encrypted input while the flow remains in the
  matching submitted state; another run cannot claim it.
- GitHub OIDC checks signature, issuer, audience, repository, ref, workflow,
  expiry, and run id.
- Logs are recursively redacted and length bounded before D1 persistence.
- Runs are queued per account and only the account's head run is dispatched.
  Completion immediately wakes the next run; the minute reconciler also resets
  stale dispatches and terminates expired claimed/running work as ambiguous.
- The account lease covers the validated worst-case attempt budget plus five
  minutes. Task writes reject configurations whose timeout, retries, and backoff
  exceed 900 execution seconds, preserving the workflow's 20-minute hard limit.
- `send_text.delete_after_seconds` must leave at least ten seconds before the
  task timeout so post-send deletion cannot be predictably killed as ambiguous.

Run the Worker suite from the repository root:

```sh
node --test worker/test/*.test.js
```
