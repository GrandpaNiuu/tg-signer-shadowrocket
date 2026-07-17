import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.notify import build_message, read_log
from scripts.redact import redact_text


class RedactionTests(unittest.TestCase):
    def test_redacts_exact_environment_secrets_and_known_shapes(self) -> None:
        session = "1A" + "session-material" * 10
        text = (
            f"session_string={session}\n"
            "api_hash: 0123456789abcdef0123456789abcdef\n"
            "proxy=http://alice:proxy-password@example.com:8080\n"
            "bot=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi\n"
            "verification_code=12345\n"
            "two_step_password: correct horse battery staple\n"
        )

        redacted = redact_text(text, extra_secrets=[session])

        for secret in (
            session,
            "0123456789abcdef0123456789abcdef",
            "proxy-password",
            "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
            "12345",
            "correct horse battery staple",
        ):
            self.assertNotIn(secret, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_reads_only_sanitized_log_tail(self) -> None:
        secret = "session-value-that-must-never-leave"
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir, "run.log")
            path.write_text("x" * 5000 + f"\nTG_SESSION_STRING={secret}\nend", encoding="utf-8")
            with mock.patch.dict(os.environ, {"TG_SESSION_STRING": secret}, clear=False):
                result = read_log(str(path))

        self.assertLessEqual(len(result), 3200)
        self.assertNotIn(secret, result)
        self.assertTrue(result.endswith("end"))

    def test_redacts_github_oauth_client_secret_from_environment(self) -> None:
        secret = "github-oauth-client-secret-value"
        with mock.patch.dict(os.environ, {"GITHUB_OAUTH_CLIENT_SECRET": secret}, clear=False):
            redacted = redact_text("oauth failure: " + secret)

        self.assertNotIn(secret, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_redacts_unlabelled_high_entropy_session_shape(self) -> None:
        possible_session = "AbCdEf0123_-" * 12
        self.assertNotIn(possible_session, redact_text("raw=" + possible_session))

    def test_build_message_never_includes_notification_token(self) -> None:
        token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"
        with mock.patch.dict(
            os.environ,
            {"TELEGRAM_NOTIFY_BOT_TOKEN": token},
            clear=False,
        ):
            message = build_message("failed", "log contains " + token, "https://example.invalid/run")

        self.assertNotIn(token, message)
        self.assertIn("[REDACTED]", message)

    def test_stream_filter_redacts_before_writing_actions_log(self) -> None:
        secret = "streamed-session-secret"
        result = subprocess.run(
            [sys.executable, "scripts/redact.py"],
            input=f"TG_SESSION_STRING={secret}\nnormal line\n",
            text=True,
            capture_output=True,
            check=True,
            env={**os.environ, "TG_SESSION_STRING": secret},
        )

        self.assertNotIn(secret, result.stdout)
        self.assertIn("normal line", result.stdout)


if __name__ == "__main__":
    unittest.main()
