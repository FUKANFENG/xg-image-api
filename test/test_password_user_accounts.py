from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend


class PasswordUserAccountTests(unittest.TestCase):
    def make_service(self, directory: str) -> AuthService:
        storage = JSONStorageBackend(Path(directory) / "accounts.json")
        return AuthService(storage, session_secret_getter=lambda: "test-session-secret")

    def test_password_account_authenticates_without_exposing_password_material(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            account = service.create_user(
                username="designer.a",
                password="safe-password-123",
                name="设计同学 A",
                image_quota=3,
            )

            identity = service.authenticate_password("designer.a", "safe-password-123")

            self.assertEqual(identity["id"], account["id"])
            self.assertEqual(identity["role"], "user")
            self.assertEqual(identity["image_quota"], 3)
            self.assertIsNone(service.authenticate_password("designer.a", "wrong-password"))
            self.assertNotIn("password_hash", account)
            self.assertNotIn("key_hash", account)

    def test_image_credit_is_reserved_once_then_refunded_or_consumed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            account = service.create_user(
                username="designer.b",
                password="safe-password-456",
                name="设计同学 B",
                image_quota=2,
            )
            identity = service.authenticate_password("designer.b", "safe-password-456")

            self.assertTrue(service.reserve_image_credit(identity, "task-1"))
            self.assertTrue(service.reserve_image_credit(identity, "task-1"))
            self.assertEqual(service.get_image_quota(identity), 1)

            self.assertTrue(service.refund_image_credit(identity, "task-1"))
            self.assertEqual(service.get_image_quota(identity), 2)

            self.assertTrue(service.reserve_image_credit(identity, "task-2"))
            self.assertTrue(service.consume_image_credit(identity, "task-2"))
            self.assertEqual(service.get_image_quota(identity), 1)
            self.assertEqual(service.list_users()[0]["image_quota_used"], 1)
            self.assertEqual(service.list_users()[0]["id"], account["id"])

    def test_session_is_invalidated_after_password_reset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            account = service.create_user(
                username="designer.c",
                password="safe-password-789",
                name="设计同学 C",
                image_quota=1,
            )
            identity = service.authenticate_password("designer.c", "safe-password-789")
            token = service.create_session(identity)

            service.update_user(account["id"], {"password": "new-safe-password-789"})

            self.assertIsNone(service.authenticate_session(token))
            self.assertIsNotNone(service.authenticate_password("designer.c", "new-safe-password-789"))

    def test_legacy_key_migration_requires_a_username_and_reserves_admin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            legacy, legacy_key = service.create_key(role="user", name="旧用户")

            with self.assertRaisesRegex(ValueError, "同时设置登录账号"):
                service.update_user(legacy["id"], {"password": "safe-password-123"})
            with self.assertRaisesRegex(ValueError, "保留的管理员账号名"):
                service.create_user(
                    username="admin",
                    password="safe-password-123",
                    name="冲突用户",
                )

            self.assertIsNotNone(service.authenticate_key(legacy_key))


if __name__ == "__main__":
    unittest.main()
