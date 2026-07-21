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
`command`, `thread`, and `delete_after`) remain accepted for existing tasks, but
new Skill implementations must use the nested parameter object.

## Allowlisted Skills

### `send_text`

```json
{
  "target": "@example_bot",
  "text": "/checkin",
  "message_thread_id": null,
  "delete_after": null
}
```

### `tg_signer`

```json
{
  "task_name": "my_sign",
  "import_blob": "base64 or a plain JSON object",
  "import_encoding": "auto",
  "num_of_dialogs": 50
}
```

The existing platform-guided sign-in configuration and legacy tg-signer imports
remain supported.

### `bot_flow`

Runs a validated multi-step bot interaction. Supported actions are `send`,
`wait_message`, `read_buttons`, and `click_button`.

```json
{
  "target": "@points_bot",
  "steps": [
    { "action": "send", "text": "/start", "timeout": 20 },
    { "action": "wait_message", "match": "签到", "timeout": 30 },
    { "action": "click_button", "button": "签到", "timeout": 20 },
    { "action": "wait_message", "match_any": ["成功", "完成"], "timeout": 30 }
  ]
}
```

The flow cannot execute Python, shell commands, expressions, Web Apps, login
buttons, payment buttons, or URL buttons. It accepts at most 20 steps, requires a
bounded timeout on every step, and returns a structured log for each step. A
failure after a message or callback has been sent is marked `ambiguous` when the
outcome cannot be proven.

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

### `chat_snapshot`

```json
{
  "target": "@group",
  "limit": 20,
  "keyword": "订单"
}
```

This Skill only collects recent text/captions. It does not download attachments or
call AI. Results contain `message_id`, `sender`, UTC `time`, and bounded `text`.

Account connectivity remains available through the existing account validation
workflow and is deliberately not exposed as a scheduled Skill.

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
- Skill names are registry allowlisted: `send_text`, `tg_signer`, `bot_flow`,
  `send_media`, and `chat_snapshot`.
- `tg-signer` is pinned to commit `95a98572...` (tag `0.9.0b2`).

Run unit tests with:

```sh
python -m unittest discover -s runner/tests -v
```
