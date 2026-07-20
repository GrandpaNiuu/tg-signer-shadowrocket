from __future__ import annotations

import pathlib
import unittest


class ListenerManagerContractTests(unittest.TestCase):
    def test_generated_at_is_not_part_of_the_config_signature(self):
        source = pathlib.Path("listener/manager.py").read_text(encoding="utf-8")
        self.assertIn('stable_config = {', source)
        self.assertIn('"accounts": config.get("accounts", [])', source)
        self.assertIn('"rules": config.get("rules", [])', source)
        signature_block = source[source.index("stable_config = {"):source.index("if signature == self.config_signature")]
        self.assertNotIn("generated_at", signature_block)

    def test_pyrogram_handler_uses_an_async_callback(self):
        source = pathlib.Path("listener/manager.py").read_text(encoding="utf-8")
        self.assertIn("async def callback", source)
        self.assertIn("MessageHandler(self._callback_for(account_id))", source)


if __name__ == "__main__":
    unittest.main()
