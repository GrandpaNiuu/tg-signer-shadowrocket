#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "Missing required environment variable: $name"
  fi
}

require_env TG_SESSION_STRING

MODE="${INPUT_MODE:-}"
if [[ -z "$MODE" ]]; then
  MODE="${SIGN_MODE:-send-text}"
fi

ACCOUNT_ARGS=()
if [[ -n "${TG_ACCOUNT:-}" ]]; then
  ACCOUNT_ARGS+=(--account "$TG_ACCOUNT")
fi

BASE_CMD=(tg-signer --session-string "$TG_SESSION_STRING" "${ACCOUNT_ARGS[@]}")

echo "[INFO] tg-signer mode: $MODE"
echo "[INFO] timezone: ${TZ:-system-default}"

if [[ -n "${TG_SIGNER_IMPORT_BASE64:-}" ]]; then
  echo "[INFO] Importing tg-signer config from TG_SIGNER_IMPORT_BASE64"
  mkdir -p .signer
  printf '%s' "$TG_SIGNER_IMPORT_BASE64" | base64 -d > /tmp/tg-signer-import.json
  "${BASE_CMD[@]}" import < /tmp/tg-signer-import.json
fi

case "$MODE" in
  send-text)
    TARGET_CHAT="${INPUT_TARGET_CHAT:-}"
    if [[ -z "$TARGET_CHAT" ]]; then
      TARGET_CHAT="${TG_TARGET_CHAT:-}"
    fi

    CHECKIN_TEXT="${INPUT_CHECKIN_TEXT:-}"
    if [[ -z "$CHECKIN_TEXT" ]]; then
      CHECKIN_TEXT="${TG_CHECKIN_TEXT:-/checkin}"
    fi

    [[ -n "$TARGET_CHAT" ]] || fail "Missing target chat. Set TG_TARGET_CHAT secret or workflow input target_chat."
    [[ -n "$CHECKIN_TEXT" ]] || fail "Missing checkin text. Set TG_CHECKIN_TEXT secret or workflow input checkin_text."

    CMD=("${BASE_CMD[@]}" send-text)

    if [[ -n "${CHECKIN_DELETE_AFTER:-}" ]]; then
      CMD+=(--delete-after "$CHECKIN_DELETE_AFTER")
    fi

    if [[ -n "${TG_MESSAGE_THREAD_ID:-}" ]]; then
      CMD+=(--message-thread-id "$TG_MESSAGE_THREAD_ID")
    fi

    if [[ "$TARGET_CHAT" == -* ]]; then
      CMD+=(-- "$TARGET_CHAT" "$CHECKIN_TEXT")
    else
      CMD+=("$TARGET_CHAT" "$CHECKIN_TEXT")
    fi

    echo "[INFO] Sending checkin text to target chat"
    "${CMD[@]}"
    ;;

  task)
    TASK_NAME="${INPUT_TASK_NAME:-}"
    if [[ -z "$TASK_NAME" ]]; then
      TASK_NAME="${TG_SIGNER_TASK_NAME:-}"
    fi
    [[ -n "$TASK_NAME" ]] || fail "Missing task name. Set TG_SIGNER_TASK_NAME secret or workflow input task_name."

    echo "[INFO] Running tg-signer task once: $TASK_NAME"
    "${BASE_CMD[@]}" run-once "$TASK_NAME"
    ;;

  *)
    fail "Unsupported mode: $MODE. Allowed values: send-text, task"
    ;;
esac

echo "[INFO] Checkin command completed"
