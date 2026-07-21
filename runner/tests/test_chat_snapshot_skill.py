import unittest
from types import SimpleNamespace

from runner.skills.base import SkillValidationError
from runner.skills.chat_snapshot import ChatSnapshotSkill
from runner.skills.telegram_primitives import sender_label


class ChatSnapshotSkillTests(unittest.TestCase):
    def test_limit_and_keyword_are_bounded(self):
        skill = ChatSnapshotSkill()
        self.assertEqual(skill.validate({"target": "@example_bot"})["limit"], 20)
        with self.assertRaises(SkillValidationError):
            skill.validate({"target": "@example_bot", "limit": 51})
        with self.assertRaises(SkillValidationError):
            skill.validate({"target": "@example_bot", "keyword": "x" * 201})

    def test_sender_label_does_not_expose_raw_objects(self):
        message = SimpleNamespace(from_user=SimpleNamespace(username="alice", first_name="Alice", last_name=None, id=1), sender_chat=None)
        self.assertEqual(sender_label(message), "@alice")


if __name__ == "__main__":
    unittest.main()
