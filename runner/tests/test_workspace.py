import os
import pathlib
import unittest

from runner.workspace import SecretWorkspace


class SecretWorkspaceTests(unittest.TestCase):
    def test_uses_private_random_directory_and_cleans_it(self):
        with SecretWorkspace(prefix="runner-test-") as workspace:
            root = workspace.path
            secret_file = workspace.write_text("secret.json", "sensitive")
            self.assertTrue(root.is_dir())
            self.assertEqual(secret_file.read_text(encoding="utf-8"), "sensitive")
            if os.name != "nt":
                self.assertEqual(root.stat().st_mode & 0o777, 0o700)
                self.assertEqual(secret_file.stat().st_mode & 0o777, 0o600)
        self.assertFalse(pathlib.Path(root).exists())


if __name__ == "__main__":
    unittest.main()
