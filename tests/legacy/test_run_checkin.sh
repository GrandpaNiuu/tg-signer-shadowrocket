#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/tmp"

cat > "$TEST_DIR/bin/tg-signer" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${TG_SESSION_STRING:-}" == "session-super-secret" ]] || {
  echo "session was not provided through the environment" >&2
  exit 91
}

for arg in "$@"; do
  [[ "$arg" != "session-super-secret" ]] || {
    echo "session leaked into argv" >&2
    exit 92
  }
done

printf '%s\n' "$*" >> "$TG_SIGNER_TEST_CALLS"
if [[ " $* " == *" import "* ]]; then
  cat >> "$TG_SIGNER_TEST_IMPORT"
fi
FAKE
chmod +x "$TEST_DIR/bin/tg-signer"

export PATH="$TEST_DIR/bin:$PATH"
export TMPDIR="$TEST_DIR/tmp"
export TG_SIGNER_TEST_CALLS="$TEST_DIR/calls"
export TG_SIGNER_TEST_IMPORT="$TEST_DIR/imported"
export TG_SESSION_STRING="session-super-secret"
export TG_ACCOUNT="legacy-primary"

SIGN_MODE=send-text \
TG_TARGET_CHAT=-100123 \
TG_CHECKIN_TEXT=/checkin \
TG_MESSAGE_THREAD_ID=88 \
CHECKIN_DELETE_AFTER=30 \
bash "$ROOT_DIR/scripts/run_checkin.sh"

grep -F -- "--account legacy-primary send-text --delete-after 30 --message-thread-id 88 -- -100123 /checkin" "$TG_SIGNER_TEST_CALLS"
! grep -F -- "--session-string" "$TG_SIGNER_TEST_CALLS"

: > "$TG_SIGNER_TEST_CALLS"
payload='{"tasks":[{"name":"daily"}]}'
export TG_SIGNER_IMPORT_BASE64
TG_SIGNER_IMPORT_BASE64="$(printf '%s' "$payload" | base64 | tr -d '\r\n')"

SIGN_MODE=task \
TG_SIGNER_TASK_NAME=daily \
bash "$ROOT_DIR/scripts/run_checkin.sh"

grep -F -- "--account legacy-primary import daily" "$TG_SIGNER_TEST_CALLS"
grep -F -- "--account legacy-primary run-once daily" "$TG_SIGNER_TEST_CALLS"
grep -F -- "$payload" "$TG_SIGNER_TEST_IMPORT"

if compgen -G "$TEST_DIR/tmp/*" > /dev/null; then
  echo "temporary secret files were not cleaned" >&2
  exit 93
fi

echo "legacy runner tests passed"
