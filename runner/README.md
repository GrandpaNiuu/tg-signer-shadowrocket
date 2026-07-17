# Unified Telegram Runner

This directory is the only execution engine for D1-backed tasks. It accepts a
`run_id`, uses GitHub Actions OIDC to claim the one-time task from the Worker,
executes an allowlisted skill, reports each attempt, and posts one terminal result.
It does not accept task configuration through workflow inputs.

## Worker contract

The task workflow calls these authenticated endpoints under `/api/runner`:

- `POST /runs/{run_id}/claim`
- `POST /runs/{run_id}/attempts`
- `POST /runs/{run_id}/complete` (idempotent for a terminal run)

The claim response schema is:

```json
{
  "run": {
    "id": "run_uuid",
    "scheduled_for": "2026-07-18T08:00:00Z",
    "trigger": "cron"
  },
  "task": {
    "id": "task_uuid",
    "skill": "send_text",
    "params": {
      "target": "@example_bot",
      "text": "/checkin",
      "message_thread_id": null,
      "delete_after": null
    },
    "retry": 1,
    "retry_delay_seconds": 2,
    "timeout_seconds": 120
  },
  "account": {
    "id": "account_uuid",
    "secrets": {
      "session_string": "decrypted only for this claim",
      "api_id": 123456,
      "api_hash": "decrypted only for this claim",
      "proxy": "socks5://user:password@example.test:1080"
    }
  }
}
```

For `tg_signer`, `params` is:

```json
{
  "task_name": "my_sign",
  "import_blob": "base64 or a plain JSON object",
  "import_encoding": "auto",
  "num_of_dialogs": 50
}
```

The legacy flat account fields and task columns (`bot`, `command`, `thread`,
`delete_after`) are accepted during migration. For a legacy `tg_signer` task,
`command` is also accepted as `task_name`, and the old encrypted import value may
arrive as `secrets.tg_signer_import_base64`. The nested schema above is canonical.
Unknown skills are rejected before execution.

Attempt callbacks include `attempt`, `status`, timestamps, `duration_ms`, and a
sanitized error/log set. The terminal callback includes `status`, timestamps,
`duration_ms`, total `attempts`, sanitized `error`, `result`, and `logs`.

## Login contract

The short-lived login workflow uses:

- `POST /login-flows/{flow_id}/claim`
- `POST /login-flows/{flow_id}/events`
- `POST /login-flows/{flow_id}/input/claim`
- `POST /login-flows/{flow_id}/complete`

Interactive claims use `flow.mode=interactive_login` and return an account with
`phone`, `api_id`, `api_hash`, and optional `proxy`. The runner posts
`code_required`, handles one-time code and resend controls, and returns invalid
or expired codes to `code_required` instead of terminating the flow. Invalid
2FA input similarly returns to `password_required`. A successful login calls
Telegram `get_me` before exporting and returning the new Session.

Validation claims use `flow.mode=session_validation` and include the existing
`session_string`. The same short-lived runner opens that in-memory Session,
calls `get_me`, and completes without replacing or returning the Session.

## Security properties

- GitHub workflow input is only an opaque ID.
- Authentication uses a short-lived GitHub OIDC bearer; no shared runner token.
- Every dynamically claimed secret is registered with GitHub `add-mask` before
  Telegram or tg-signer code runs; workflow-command data is safely escaped.
- Session data enters the skill subprocess through stdin, never argv.
- Temporary Telegram/config files live in a random `0700` directory, use `0600`
  files, and are deleted on exit.
- Timeouts are treated as ambiguous and are never blindly retried.
- Skill names are registry allowlisted: `send_text`, `tg_signer`.
- `tg-signer` is pinned to commit `95a98572...` (tag `0.9.0b2`).

Run unit tests with:

```sh
python -m unittest discover -s runner/tests -v
```
