from pathlib import Path
import unittest


class RequirementsTests(unittest.TestCase):
    def test_tgcrypto_acceleration_is_pinned(self) -> None:
        requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
        lines = {
            line.strip()
            for line in requirements.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        self.assertIn("TgCrypto==1.2.5", lines)


if __name__ == "__main__":
    unittest.main()
