from types import SimpleNamespace
import unittest

from listener.rules import parse_selectors, selector_matches


class MultiSelectorTests(unittest.TestCase):
    def test_parse_selectors_supports_legacy_single_and_multiple_values(self):
        self.assertEqual(parse_selectors("*"), ("*",))
        self.assertEqual(parse_selectors("@buyers"), ("@buyers",))
        self.assertEqual(
            parse_selectors("@buyers,-1001234567890,@support"),
            ("@buyers", "-1001234567890", "@support"),
        )
        self.assertEqual(
            parse_selectors('["@buyers", "-1001234567890"]'),
            ("@buyers", "-1001234567890"),
        )

    def test_parse_selectors_deduplicates_usernames_case_insensitively(self):
        self.assertEqual(parse_selectors("@Buyers,@buyers,-1001,-1001"), ("@Buyers", "-1001"))

    def test_selector_matches_any_selected_conversation(self):
        by_username = SimpleNamespace(chat=SimpleNamespace(id=-1009, username="buyers"))
        by_id = SimpleNamespace(chat=SimpleNamespace(id=-1001234567890, username=None))
        other = SimpleNamespace(chat=SimpleNamespace(id=-2000, username="other"))

        selector = "@buyers,-1001234567890"
        self.assertTrue(selector_matches(selector, by_username))
        self.assertTrue(selector_matches(selector, by_id))
        self.assertFalse(selector_matches(selector, other))

    def test_wildcard_remains_compatible(self):
        message = SimpleNamespace(chat=SimpleNamespace(id=123, username=None))
        self.assertTrue(selector_matches("*", message))


if __name__ == "__main__":
    unittest.main()
