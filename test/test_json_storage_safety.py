from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.storage.json_storage import JSONStorageBackend


class JSONStorageSafetyTests(unittest.TestCase):
    def test_missing_account_file_is_an_empty_pool(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            backend = JSONStorageBackend(Path(tmp_dir) / "accounts.json")
            self.assertEqual(backend.load_accounts(), [])

    def test_corrupt_account_json_raises_instead_of_emptying_pool(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "accounts.json"
            path.write_text("{broken", encoding="utf-8")
            backend = JSONStorageBackend(path)

            with self.assertRaises(RuntimeError) as raised:
                backend.load_accounts()

            self.assertIn("accounts.json", str(raised.exception))

    def test_health_check_parses_json_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "accounts.json"
            path.write_text("{broken", encoding="utf-8")
            backend = JSONStorageBackend(path)

            health = backend.health_check()

            self.assertEqual(health["status"], "unhealthy")
            self.assertIn("accounts.json", health["error"])

    def test_failed_atomic_replace_preserves_previous_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "accounts.json"
            original = '[{"access_token":"old"}]\n'
            path.write_text(original, encoding="utf-8")
            backend = JSONStorageBackend(path)

            with patch("os.replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    backend.save_accounts([{"access_token": "new"}])

            self.assertEqual(path.read_text(encoding="utf-8"), original)
            self.assertEqual(list(path.parent.glob(f".{path.name}.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
