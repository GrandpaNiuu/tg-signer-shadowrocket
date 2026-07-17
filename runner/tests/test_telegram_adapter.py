import json
import pathlib
import unittest
from types import SimpleNamespace
from unittest import mock

from runner.skills.base import SkillContext
from runner.skills.telegram_adapter import build_signer
from runner.skills.telegram_adapter import classify_telegram_exception


class FloodWait(Exception):
    def __init__(self, seconds: int) -> None:
        super().__init__(f"wait {seconds} seconds")
        self.value = seconds


class TelegramExceptionTests(unittest.TestCase):
    def test_skills_receive_the_same_decoded_worker_proxy(self) -> None:
        seen = {}

        class UserSigner:
            def __init__(self, **kwargs):
                seen.update(kwargs)

        context = SkillContext(
            account_id="account-1",
            task_id="task-1",
            secrets={
                "session_string": "secret-session",
                "proxy": json.dumps(
                    {
                        "protocol": "http",
                        "host": "proxy.example",
                        "port": 8080,
                    }
                ),
            },
        )
        workspace = SimpleNamespace(path=pathlib.Path("isolated-workspace"))
        with mock.patch(
            "runner.skills.telegram_adapter.load_tg_signer", return_value=UserSigner
        ):
            build_signer(context, task_name="daily", workspace=workspace)

        self.assertEqual(
            seen["proxy"],
            {
                "scheme": "http",
                "hostname": "proxy.example",
                "port": 8080,
                "username": None,
                "password": None,
            },
        )

    def test_flood_wait_is_safe_to_retry_after_server_delay(self) -> None:
        error = classify_telegram_exception(FloodWait(23))

        self.assertTrue(error.retryable)
        self.assertFalse(error.ambiguous)
        self.assertEqual(error.retry_after_seconds, 23)

    def test_connection_loss_remains_ambiguous(self) -> None:
        error = classify_telegram_exception(ConnectionError("socket closed"))

        self.assertTrue(error.retryable)
        self.assertTrue(error.ambiguous)


if __name__ == "__main__":
    unittest.main()
