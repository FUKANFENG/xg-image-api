from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import api.system as system_module


ADMIN = {"id": "admin-1", "role": "admin", "name": "管理员"}
USER = {"id": "user-1", "role": "user", "name": "普通用户"}


class FakeConfig:
    def get_backup_settings(self) -> dict[str, object]:
        return {
            "enabled": True,
            "provider": "local",
            "include": {"images": False},
            "access_key_id": "should-not-leak",
            "secret_access_key": "should-not-leak",
        }


class FakeImageStorage:
    def backup_readiness(self) -> dict[str, object]:
        return {
            "mode": "both",
            "status": "protected",
            "remote_enabled": True,
            "remote_configured": True,
            "recommendation": "新图片会同时保存到本机和 WebDAV。",
        }


class FakeImageIntegrity:
    def __init__(self) -> None:
        self.calls: list[tuple[dict[str, object], bool, bool]] = []

    def scan(self, identity: dict[str, object], *, include_all: bool, force: bool) -> dict[str, object]:
        self.calls.append((identity, include_all, force))
        return {
            "summary": {
                "unique_images": 12,
                "backed_up": 10,
                "local_only": 2,
                "remote_only": 0,
                "recoverable": 0,
                "missing": 0,
            },
            "scanned_at": "2026-07-27T15:00:00+08:00",
        }


class FakeBackupService:
    def get_status(self) -> dict[str, object]:
        return {"last_status": "success", "last_error": "should-not-leak"}


class ImageStorageReadinessApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.integrity = FakeImageIntegrity()

        def require_admin(authorization: str | None) -> dict[str, object]:
            if authorization == "Bearer admin":
                return ADMIN
            raise HTTPException(status_code=403, detail={"error": "需要管理员权限才能执行这个操作"})

        self.patchers = [
            mock.patch.object(system_module, "config", FakeConfig()),
            mock.patch.object(system_module, "image_storage_service", FakeImageStorage()),
            mock.patch.object(system_module, "image_integrity_service", self.integrity),
            mock.patch.object(system_module, "backup_service", FakeBackupService()),
            mock.patch.object(system_module, "require_admin", require_admin),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(system_module.create_router("test"))
        self.client = TestClient(app)

    def test_admin_readiness_aggregates_safe_copy_and_backup_state(self) -> None:
        response = self.client.get(
            "/api/image-storage/readiness?force=true",
            headers={"Authorization": "Bearer admin"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["image_protection"]["status"], "protected")
        self.assertEqual(payload["integrity"]["local_only"], 2)
        self.assertFalse(payload["system_backup"]["includes_images"])
        self.assertEqual(self.integrity.calls, [(ADMIN, True, True)])
        self.assertNotIn("should-not-leak", response.text)
        self.assertNotIn("webdav_url", payload)

    def test_readiness_requires_administrator(self) -> None:
        response = self.client.get("/api/image-storage/readiness")

        self.assertEqual(response.status_code, 403, response.text)


if __name__ == "__main__":
    unittest.main()
