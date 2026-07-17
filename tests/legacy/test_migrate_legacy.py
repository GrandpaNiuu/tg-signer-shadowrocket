import io
import unittest
import urllib.error
from unittest import mock

from scripts.migrate_legacy import build_payload, normalize_legacy_target, submit


BASE_ENV = {
    "GITHUB_REPOSITORY": "GrandpaNiuu/Telegramautomaticcheck-in",
    "GITHUB_REF": "refs/heads/main",
    "SIGN_MODE": "send-text",
    "TG_SESSION_STRING": "primary-session",
    "TG_API_ID": "123456",
    "TG_API_HASH": "0123456789abcdef0123456789abcdef",
    "TG_TARGET_CHAT": "@primary_bot",
    "TG_CHECKIN_TEXT": "/checkin",
    "TG_PROXY": "socks5://alice:secret@proxy.example:1080",
    "TG_SESSION_STRING_2": "secondary-session",
    "TG_API_ID_2": "",
    "TG_API_HASH_2": "",
    "TG_TARGET_CHAT_2": "",
    "TG_CHECKIN_TEXT_2": "",
    "TG_PROXY_2": "",
    "TELEGRAM_NOTIFY_BOT_TOKEN": "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    "TELEGRAM_NOTIFY_CHAT_ID": "1234",
}


class LegacyMigrationTests(unittest.TestCase):
    def test_target_normalization_matches_legacy_wrapper(self) -> None:
        self.assertEqual(normalize_legacy_target("8604751086"), "@freexzteam_bot")
        self.assertEqual(
            normalize_legacy_target("id: 8604751086 username: freexzteam_bot"),
            "@freexzteam_bot",
        )
        self.assertEqual(normalize_legacy_target("example_bot"), "@example_bot")

    def test_actual_payload_materializes_secondary_fallbacks(self) -> None:
        with mock.patch.dict("os.environ", BASE_ENV, clear=True):
            payload = build_payload(dry_run=False)

        self.assertEqual(2, len(payload["accounts"]))
        secondary = payload["accounts"][1]
        primary = payload["accounts"][0]
        self.assertEqual("123456", primary["api_id"])
        self.assertEqual(
            "0123456789abcdef0123456789abcdef",
            primary["api_hash"],
        )
        self.assertEqual("secondary-session", secondary["session_string"])
        self.assertEqual("123456", secondary["api_id"])
        self.assertEqual(
            "0123456789abcdef0123456789abcdef",
            secondary["api_hash"],
        )
        self.assertEqual("socks5://alice:secret@proxy.example:1080", secondary["proxy"])
        self.assertEqual("@primary_bot", payload["tasks"][1]["target"])
        self.assertEqual("/checkin", payload["tasks"][1]["command"])
        self.assertFalse(payload["activate_scheduler"])

    def test_dry_run_transmits_presence_only(self) -> None:
        with mock.patch.dict("os.environ", BASE_ENV, clear=True):
            payload = build_payload(dry_run=True)

        serialized = repr(payload)
        self.assertNotIn("primary-session", serialized)
        self.assertNotIn("secondary-session", serialized)
        self.assertNotIn("socks5://alice:secret", serialized)
        self.assertNotIn("ABCDEFGHIJKLMNOPQRSTUVWXYZ", serialized)
        self.assertNotIn("0123456789abcdef0123456789abcdef", serialized)
        self.assertTrue(payload["dry_run"])
        self.assertTrue(payload["presence"]["primary_account"])

    def test_missing_primary_session_is_rejected_for_real_import(self) -> None:
        with mock.patch.dict("os.environ", {**BASE_ENV, "TG_SESSION_STRING": ""}, clear=True):
            with self.assertRaisesRegex(ValueError, "TG_SESSION_STRING"):
                build_payload(dry_run=False)

    def test_incomplete_api_credentials_do_not_block_session_migration(self) -> None:
        environment = {**BASE_ENV, "TG_API_HASH": ""}
        with mock.patch.dict("os.environ", environment, clear=True):
            payload = build_payload(dry_run=False)

        self.assertNotIn("api_id", payload["accounts"][0])
        self.assertNotIn("api_hash", payload["accounts"][0])
        self.assertFalse(payload["presence"]["primary_api_credentials"])

    def test_secondary_api_credentials_fall_back_only_as_a_complete_pair(self) -> None:
        environment = {**BASE_ENV, "TG_API_ID_2": "654321", "TG_API_HASH_2": ""}
        with mock.patch.dict("os.environ", environment, clear=True):
            payload = build_payload(dry_run=False)

        secondary = payload["accounts"][1]
        self.assertEqual(BASE_ENV["TG_API_ID"], secondary["api_id"])
        self.assertEqual(BASE_ENV["TG_API_HASH"], secondary["api_hash"])

    def test_submission_requires_explicit_oidc_audience(self) -> None:
        with mock.patch.dict("os.environ", {"WORKER_URL": "https://worker.example"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "WORKER_OIDC_AUDIENCE"):
                submit({"schema_version": 1, "dry_run": True})

    def test_worker_errors_are_redacted_before_reaching_logs(self) -> None:
        api_hash = BASE_ENV["TG_API_HASH"]
        response = io.BytesIO(f'{{"error":"API_HASH={api_hash}"}}'.encode())
        error = urllib.error.HTTPError(
            "https://worker.example/api/runner/migrations/legacy",
            422,
            "Unprocessable Entity",
            {},
            response,
        )
        environment = {
            **BASE_ENV,
            "WORKER_URL": "https://worker.example",
            "WORKER_OIDC_AUDIENCE": "https://worker.example/api/runner",
        }
        with (
            mock.patch.dict("os.environ", environment, clear=True),
            mock.patch(
                "scripts.migrate_legacy.request_oidc_token",
                return_value="oidc-token",
            ),
            mock.patch("scripts.migrate_legacy.urllib.request.urlopen", side_effect=error),
        ):
            with self.assertRaises(RuntimeError) as raised:
                submit({"schema_version": 1, "dry_run": True})

        self.assertNotIn(api_hash, str(raised.exception))
        self.assertIn("[REDACTED]", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
