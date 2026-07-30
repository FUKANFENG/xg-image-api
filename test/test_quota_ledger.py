from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend


class QuotaLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        root = Path(self.temp_dir.name)
        self.service = AuthService(JSONStorageBackend(root / "accounts.json", root / "auth.json"))
        user = self.service.create_user(
            username="ledger-user",
            password="strong-pass-123",
            image_quota=3,
        )
        self.identity = {"id": user["id"], "role": "user", "name": user["name"]}

    def test_reserve_consume_refund_and_adjust_are_visible_and_idempotent(self) -> None:
        self.assertTrue(self.service.reserve_image_credit(self.identity, "task-1"))
        self.assertTrue(self.service.reserve_image_credit(self.identity, "task-1"))
        self.assertTrue(self.service.consume_image_credit(self.identity, "task-1"))
        self.assertTrue(self.service.reserve_image_credit(self.identity, "task-2"))
        self.assertTrue(self.service.refund_image_credit(self.identity, "task-2"))
        self.service.update_user(str(self.identity["id"]), {"image_quota": 9})

        result = self.service.list_image_credit_events(self.identity, limit=50)
        actions = [item["action"] for item in result["items"]]

        self.assertEqual(actions.count("reserve"), 2)
        self.assertIn("consume", actions)
        self.assertIn("refund", actions)
        self.assertIn("adjust", actions)
        self.assertIn("allocate", actions)
        self.assertEqual(self.service.get_image_quota(self.identity), 9)

    def test_user_cannot_read_another_users_ledger(self) -> None:
        other = self.service.create_user(
            username="other-user",
            password="strong-pass-456",
            image_quota=5,
        )
        result = self.service.list_image_credit_events(
            self.identity,
            owner_id=str(other["id"]),
            limit=50,
        )

        self.assertTrue(result["items"])
        self.assertTrue(all(item["owner_id"] == self.identity["id"] for item in result["items"]))


if __name__ == "__main__":
    unittest.main()
