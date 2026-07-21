import unittest
from types import SimpleNamespace

from runner.skills.account_audit import AccountAuditSkill, _display_name
from runner.skills.base import SkillValidationError


class AccountAuditSkillTests(unittest.TestCase):
    def test_rejects_user_defined_commands(self):
        with self.assertRaises(SkillValidationError):
            AccountAuditSkill().validate({"command": "get_me"})

    def test_display_name_is_normalized(self):
        self.assertEqual(_display_name(SimpleNamespace(first_name="Ada", last_name="Lovelace")), "Ada Lovelace")
        self.assertIsNone(_display_name(SimpleNamespace(first_name=None, last_name=None)))


if __name__ == "__main__":
    unittest.main()
