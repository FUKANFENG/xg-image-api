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

    def test_unlimited_policy_persists_without_changing_credentials_or_balance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            account = service.create_user(username="unlimited", password="test-password", image_quota=1)
            service.update_key(account["id"], {"key": "test-only-key"}, role="user")
            identity = service.authenticate_key("test-only-key")
            session = service.create_session(identity)
            self.assertTrue(service.reserve_image_credit(identity, "already-reserved"))
            service.update_user(account["id"], {"image_quota_unlimited": True, "image_concurrency_limit": 4})
            service = self.make_service(directory)
            self.assertEqual(service.get_image_concurrency_limit(account["id"]), 4)
            self.assertIsNone(service.get_image_quota(identity))
            for index in range(105):
                self.assertIsNone(service.reserve_image_credit(identity, f"new-{index}"))
            self.assertEqual(service.list_users()[0]["image_quota"], 0)
            for fresh_identity in (service.authenticate_key("test-only-key"),
                                   service.authenticate_password("unlimited", "test-password"),
                                   service.authenticate_session(session)):
                self.assertEqual(fresh_identity["role"], "user")
                self.assertTrue(fresh_identity["image_quota_unlimited"])
                self.assertNotIn("image_quota", fresh_identity)
            # Existing reservations still settle exactly once after a policy change.
            self.assertTrue(service.refund_image_credit(identity, "already-reserved"))
            self.assertFalse(service.refund_image_credit(identity, "already-reserved"))
            service.update_user(account["id"], {"image_quota_unlimited": False})
            self.assertEqual(service.get_image_quota(identity), 1)
            self.assertTrue(service.reserve_image_credit(identity, "finite"))
            self.assertFalse(service.reserve_image_credit(identity, "exhausted"))
            service.update_user(account["id"], {"image_quota_unlimited": True, "enabled": False})
            self.assertFalse(service.reserve_image_credit(identity, "disabled"))
            self.assertIsNone(service.authenticate_key("test-only-key"))

    def test_invalid_policy_does_not_change_account(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            account = service.create_user(username="limited", password="test-password", image_quota=3)
            for limit in (-1, 17, "4", True):
                with self.assertRaises(ValueError):
                    service.update_user(account["id"], {"image_concurrency_limit": limit})
            with self.assertRaises(ValueError):
                service.update_user(account["id"], {"image_quota_unlimited": "false"})
            self.assertEqual(service.get_image_concurrency_limit(account["id"]), 0)
            self.assertFalse(service.list_users()[0]["image_quota_unlimited"])

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
