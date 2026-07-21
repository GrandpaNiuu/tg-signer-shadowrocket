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

Sends media from a Worker-approved Telegram source message. The Runner reads the
source message, extracts its Telegram-cached file identifier, and sends that cached
media. It never accepts a server path or arbitrary URL.

```json
{
  "target": "@channel",
  "file_id": "worker-media-asset-id",
  "media_type": "photo",
  "caption": "Optional caption",
  "message_thread_id": null,
  "delete_after": null
}
```

The Worker resolves `file_id` to an asset owned by the same workspace and injects
the source chat/message reference only into the one-time claim. The Skill returns
the created Telegram `message_id`.

Media assets are registered through the authenticated workspace API:

```text
GET    /api/v1/media-assets
POST   /api/v1/media-assets
DELETE /api/v1/media-assets/{id}
```

A registration contains `name`, `media_type`, `source_chat_id`, and
`source_message_id`.

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
