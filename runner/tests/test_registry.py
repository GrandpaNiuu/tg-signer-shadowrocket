import unittest

from runner.skills import build_registry
from runner.skills.base import SkillValidationError


class RegistryTests(unittest.TestCase):
    def test_only_expected_skills_are_registered(self):
        registry = build_registry()
        self.assertEqual(
            registry.names(),
            ("send_media", "send_text", "tg_signer"),
        )
        for retired in ("account_audit", "bot_flow", "chat_snapshot", "arbitrary_python"):
            with self.subTest(retired=retired), self.assertRaises(KeyError):
                registry.get(retired)

    def test_send_text_validates_and_normalizes_parameters(self):
        skill = build_registry().get("send_text")
        params = skill.validate(
            {
                "target": "123456",
                "text": "/checkin",
                "message_thread_id": "9",
                "delete_after": "5",
            }
        )
        self.assertEqual(params["target"], 123456)
        self.assertEqual(params["message_thread_id"], 9)

    def test_tg_signer_requires_task_name(self):
        with self.assertRaises(SkillValidationError):
            build_registry().get("tg_signer").validate({})

    def test_send_text_normalizes_bare_bot_username(self):
        params = build_registry().get("send_text").validate(
            {"target": "example_bot", "text": "/checkin"}
        )
        self.assertEqual(params["target"], "@example_bot")

    def test_send_text_preserves_legacy_login_log_and_known_bot_mapping(self):
        skill = build_registry().get("send_text")
        for raw_target in (
            "8604751086",
            "freexzteam_bot",
            "id: 8604751086 username: freexzteam_bot",
        ):
            with self.subTest(raw_target=raw_target):
                params = skill.validate({"target": raw_target, "text": "/checkin"})
                self.assertEqual(params["target"], "@freexzteam_bot")


if __name__ == "__main__":
    unittest.main()
