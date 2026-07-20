# Cloudflare Worker control plane

This directory contains the D1-backed control plane. It keeps the original
`tg-signer-shadowrocket` Worker service name for deployment compatibility, but
the current system is a multi-user API, scheduler, authentication service, and
GitHub Actions dispatch coordinator.

This document is operator-facing. The presence of a route or feature in the
source code does not mean it is enabled in production; availability depends on
the deployed variables, secrets, D1 migrations, OAuth configuration, mail
provider, Turnstile, and GitHub Actions permissions.

## Routes

An opaque D1-backed user session protects workspace routes. A successfully
authenticated GitHub identity can create a workspace when GitHub OAuth is
enabled. The configured immutable GitHub user id claims the preserved
administrator role.

Public authentication routes:

- `GET /api/auth/config`
- `GET /api/auth/github/start`
- `GET /api/auth/github/callback`
- `POST /api/auth/email/register|verify|login|forgot-password|reset-password`
- `GET /api/auth/me` (`GET /api/auth/session` is a compatibility alias)
- `POST /api/auth/logout`

Authenticated session routes:

- `GET /api/auth/sessions`
- `DELETE /api/auth/sessions/:id`

Authenticated workspace routes:

- `GET /api/v1/dashboard`
- `GET|POST /api/v1/accounts`, `GET|PATCH|DELETE /api/v1/accounts/:id`
- `POST /api/v1/accounts/:id/validate`, `POST /api/v1/accounts/validate-all`
- `GET|POST /api/v1/tasks`, `GET|PATCH|DELETE /api/v1/tasks/:id`
- `POST /api/v1/tasks/:id/runs`
- `GET /api/v1/skills`
- `GET /api/v1/task-runs`, `GET /api/v1/task-runs/:id`
- `GET /api/v1/admin/users`, `PATCH /api/v1/admin/users/:id` (administrator only)
- `GET|PATCH /api/v1/settings` (platform writes require administrator role)
- `PATCH /api/v1/settings/telegram`, `PATCH /api/v1/settings/notifications`
- `POST /api/v1/login-flows`, `GET /api/v1/login-flows/:id`
- `POST /api/v1/login-flows/:id/code|password|resend|cancel`

GitHub OIDC protects Runner routes. Workflow inputs contain only an opaque run
or flow id:

- `POST /api/runner/runs/:id/claim|attempts|complete`
- `POST /api/runner/login-flows/:id/claim|events|complete`
- `POST /api/runner/login-flows/:id/input/claim`

Successful API responses use `{ "data": ... }`; list responses also include
`pagination`. Errors use `{ "error": { "code", "message", "details"? } }`.
Runner claim responses intentionally follow the Runner TaskSpec schema.

Manual task execution requires an `Idempotency-Key` of 8-128 characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`. A retry with the same stable key returns the
existing run instead of dispatching a duplicate workflow. Enqueue, dispatch
reservation, and Runner claim each re-check that the account is enabled and
connected.

For a `tg_signer` task, administrator writes may include `tg_signer_import` as
plain JSON or base64. It is encrypted with task-bound AES-GCM AAD and is never
returned by an administrator endpoint; task responses expose only
`has_tg_signer_import`. This is a task compatibility capability, not a way for a
web user to upload arbitrary Python or shell code.

## Configuration

A working deployment requires D1, a Direct Upload Pages project, a Worker,
GitHub OAuth, GitHub Actions dispatch permission, and the required secrets. The
architecture does not depend on Cloudflare Access, but Cloudflare account,
product, quota, and billing requirements can change independently of this
repository.

The Worker deployment workflow applies pending D1 migrations before deployment.
Never commit real secrets to TOML, source files, Issues, screenshots, or logs.

Worker secrets:

- `GITHUB_TOKEN` with permission to dispatch task and login workflows
- `SECRET_ROOT_KEY`: Base64 for exactly 32 random bytes
- optional `SECRET_ROOT_KEY_V1`, `SECRET_ROOT_KEY_V2`, ... during key rotation
- `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`
- `PASSWORD_PEPPER`
- for verified email registration and reset: `TURNSTILE_SECRET_KEY` and
  `RESEND_API_KEY`

Variables:

- GitHub owner, repository, branch, and task/login workflow filenames
- `RUNNER_OIDC_AUDIENCE`
- `ADMIN_ORIGIN`, `ADMIN_GITHUB_LOGIN`, and immutable `ADMIN_GITHUB_USER_ID`
- optional `ADMIN_SESSION_TTL_SECONDS` (5 minutes to 30 days; default 7 days)
- production must keep `PUBLIC_PASSWORD_AUTH_MODE=secure`; `local` is only for
  development compatibility
- for verified email registration: `TURNSTILE_SITE_KEY` and verified sender
  `AUTH_EMAIL_FROM`
- optional `TURNSTILE_VERIFY_TIMEOUT_MS` (1000-10000; default 5000)
- optional `PASSWORD_HASH_ITERATIONS` (100000-1000000); benchmark real Worker
  CPU before increasing it
- optional `RUNNER_WORKFLOW_REF` and `LOGIN_WORKFLOW_REF`
- optional `SCHEDULE_DISPATCH_LEAD_SECONDS` (default 120, bounded to 120-180)

If mail or Turnstile configuration is incomplete, existing email users may still
sign in, but new email registration and self-service password reset remain
closed. GitHub login can remain available. The system does not fall back to
unverified production registration.

The Cloudflare deployment token needs the permissions required to edit the
target Worker, D1 database, and Pages project. `GITHUB_TOKEN` needs Actions write
permission on this repository.

## Scheduling reality

D1 is the only scheduler. The Worker tick is minute-based and can dispatch
upcoming work early. A Runner that has already started can wait until the target
second, but GitHub Actions queue delay may start the job after that target.
Therefore a 6-field Cron stores second precision but does not guarantee exact
second execution. The delay is recorded as schedule lag.

Cloudflare, GitHub Actions, Telegram, and the target bot are external systems.
A green repository test suite does not guarantee that production credentials,
quotas, network access, or Telegram account state are healthy.

## Security invariants

- API hash, Session, retained legacy proxy credentials, verification code, 2FA
  password, and notification credentials are encrypted at rest. The current web
  UI does not offer Session import or new proxy configuration.
- GitHub OAuth states are short-lived one-time values whose SHA-256 hashes are
  stored in D1; authorization codes are bound with S256 PKCE.
- Session tokens are random 256-bit values; D1 stores only their hashes, and
  logout revokes the matching row immediately.
- Only the configured immutable numeric GitHub user id can claim
  `legacy-admin`; a matching mutable login name is insufficient.
- Email passwords use PBKDF2-HMAC-SHA256 with a random per-user salt and a
  deployment pepper. A successful login performs gradual rehash only when the
  configured target is higher, using an optimistic update that does not
  overwrite a concurrent password change.
- Turnstile is verified server-side. Registration, login, password recovery,
  and password reset use distinct actions, and the Worker verifies the hostname
  derived from `ADMIN_ORIGIN`.
- Verification and reset tokens are one-time SHA-256 digests with bounded
  expiry.
- Each ciphertext uses a random 96-bit nonce and AAD bound to purpose, owner,
  and key version.
- Code and 2FA inputs are short-lived and can only be claimed by the matching
  authenticated workflow run in the expected state.
- Terminal login flows clear code and 2FA ciphertext. A connected Session is
  retained because it is the credential required for later Telegram tasks.
- New accounts use the encrypted platform-level Telegram application credential
  pair. Complete credentials retained from a migrated account may be used only
  as a compatibility fallback.
- GitHub OIDC checks signature, issuer, audience, repository, ref, workflow,
  expiry, and run id.
- Logs are recursively redacted and length-bounded before D1 persistence.
- Runs are queued per account; only the account head run is dispatched.
- Reconciliation resets stale dispatches and terminates expired claimed or
  running work as `ambiguous` instead of claiming an unverified success.
- Task writes reject attempt budgets above the workflow safety limit.
- `send_text.delete_after_seconds` must leave enough time before task timeout for
  post-send deletion.

Encryption and redaction reduce risk but do not make secrets safe to publish.
Operators must still avoid sharing Session strings, API_HASH, verification codes,
2FA passwords, Bot Tokens, or deployment secrets.

## Tests

Run from the repository root:

```sh
node --test worker/test/*.test.js
```

Repository tests validate code contracts. Production readiness additionally
requires deployment smoke checks and live endpoint audits.