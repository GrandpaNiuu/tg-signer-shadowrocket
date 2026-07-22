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

The claim response uses canonical `task.params`. Legacy task columns (`bot`,
`command`, `thread`, and `delete_after`) remain accepted for existing tasks.

## Allowlisted Skills

### `send_text`

Sends one text message or command and optionally deletes it later.

```json
{
  "target": "@example_bot",
  "text": "/checkin",
  "message_thread_id": null,
  "delete_after": null
}
```

### `tg_signer`

Runs the existing guided button-sign-in flow or a registered legacy tg-signer
configuration. This remains the single task type for bot flows that send a command,
wait for a reply, find a button, click it, and confirm success.

```json
{
  "task_name": "my_sign",
  "import_blob": "base64 or a plain JSON object",
  "import_encoding": "auto",
  "num_of_dialogs": 50
}
```

### `send_media`

Copies any Telegram message the selected account can access. Telegram itself remains
the content store, so the platform does not need paid object storage and does not put
large files in D1. Text, photos, videos, documents, audio, voice messages, stickers,
polls, contacts, and locations use the same contract.

```json
{
  "target": "@channel",
  "source_chat_id": "me",
  "source_message_id": 123,
  "caption": "Optional caption",
  "message_thread_id": null,
  "delete_after": null
}
```

`caption: null` keeps the original caption, an empty string removes it, and a non-empty
string replaces it. The Skill returns the created Telegram `message_id`, detected
content type, and a sanitized text/caption preview for the task receipt.

Legacy `file_id`/`media_type` tasks remain executable during migration, but the admin
no longer exposes media registration for new tasks.

Long-running keyword/group monitoring remains exclusively in Listener. Account
connectivity remains in the existing account validation workflow. Neither is
exposed as a duplicate scheduled Skill.

## Login contract

The short-lived login workflow uses:

- `POST /login-flows/{flow_id}/claim`
- `POST /login-flows/{flow_id}/events`
- `POST /login-flows/{flow_id}/input/claim`
- `POST /login-flows/{flow_id}/complete`

Interactive claims use `flow.mode=interactive_login`. Validation claims use
`flow.mode=session_validation`, open the existing in-memory Session, call
`get_me`, and complete without replacing or returning the Session.

## Security properties

- GitHub workflow input is only an opaque ID.
- Authentication uses a short-lived GitHub OIDC bearer; no shared runner token.
- Every dynamically claimed secret is registered with GitHub `add-mask` before
  Telegram or tg-signer code runs; workflow-command data is safely escaped.
- Session data enters the Skill subprocess through stdin, never argv.
- Temporary Telegram/config files live in a random `0700` directory, use `0600`
  files, and are deleted on exit.
- Timeouts after Telegram side effects are treated as ambiguous and are never
  blindly retried.
- Skill names are registry allowlisted: `send_text`, `tg_signer`, and `send_media`.
- `tg-signer` is pinned to commit `95a98572...` (tag `0.9.0b2`).

Run unit tests with:

```sh
python -m unittest discover -s runner/tests -v
```
