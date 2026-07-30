from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.inspirations as inspirations_module
from services.config import config


AUTH_HEADERS = {"Authorization": f"Bearer {config.auth_key}"}


class FakeImageTaskService:
    def list_admin_inspiration_candidate_page(self, page: int, page_size: int):
        self.page = page
        self.page_size = page_size
        return {
            "items": [{
                "owner_id": "user-1",
                "task_id": "task-1",
                "image_index": 0,
                "prompt": "a useful prompt",
                "preview_url": "/images/2026/07/example.png",
                "size": "1024x1024",
                "quality": "high",
                "created_at": "2026-07-18 12:00:00",
            }],
            "page": page,
            "page_size": page_size,
            "total": 25,
            "total_pages": 3,
        }

    def get_admin_inspiration_source(self, owner_id: str, task_id: str, image_index: int):
        if task_id == "missing":
            raise LookupError("未找到对应的用户生成任务")
        return {
            "owner_id": owner_id,
            "task_id": task_id,
            "image_index": image_index,
            "prompt": "a useful prompt",
            "preview_url": "/images/2026/07/example.png",
            "size": "1024x1024",
            "quality": "high",
        }


class FakeInspirationService:
    def __init__(self, archived_image_path: Path):
        self.sources = set()
        self.archived_image_path = archived_image_path

    def list_public(self):
        return [{"id": "curated-1", "title": "example"}]

    def has_source(self, owner_id: str, task_id: str, image_index: int):
        return (owner_id, task_id, image_index) in self.sources

    def curate_from_task(self, source):
        key = (source["owner_id"], source["task_id"], source["image_index"])
        created = key not in self.sources
        self.sources.add(key)
        return {"id": "curated-1", "preview": source["preview_url"]}, created

    def get_archived_image_path(self, image_name: str):
        if image_name != self.archived_image_path.name:
            raise LookupError("灵感图片不存在")
        return self.archived_image_path


class InspirationsApiTests(unittest.TestCase):
    def setUp(self):
        self.tasks = FakeImageTaskService()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        archived_image_path = Path(self.temp_dir.name) / "curated-1.png"
        archived_image_path.write_bytes(b"PNG")
        self.inspirations = FakeInspirationService(archived_image_path)
        self.task_patch = mock.patch.object(inspirations_module, "image_task_service", self.tasks)
        self.inspiration_patch = mock.patch.object(inspirations_module, "inspiration_service", self.inspirations)
        self.task_patch.start()
        self.inspiration_patch.start()
        self.addCleanup(self.task_patch.stop)
        self.addCleanup(self.inspiration_patch.stop)
        app = FastAPI()
        app.include_router(inspirations_module.create_router())
        self.client = TestClient(app)

    def test_public_library_requires_identity_and_returns_public_items(self):
        unauthenticated = self.client.get("/api/inspirations")
        self.assertEqual(unauthenticated.status_code, 401)

        response = self.client.get("/api/inspirations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"][0]["id"], "curated-1")

    def test_admin_can_list_and_curate_candidates_idempotently(self):
        candidates = self.client.get("/api/admin/inspiration-candidates?page=2&page_size=9", headers=AUTH_HEADERS)
        self.assertEqual(candidates.status_code, 200, candidates.text)
        self.assertFalse(candidates.json()["items"][0]["is_curated"])
        self.assertEqual(candidates.json()["pagination"], {"page": 2, "page_size": 9, "total": 25, "total_pages": 3})
        self.assertEqual(self.tasks.page, 2)
        self.assertEqual(self.tasks.page_size, 9)

        legacy_limit = self.client.get("/api/admin/inspiration-candidates?limit=12", headers=AUTH_HEADERS)
        self.assertEqual(legacy_limit.status_code, 200, legacy_limit.text)
        self.assertEqual(self.tasks.page, 1)
        self.assertEqual(self.tasks.page_size, 12)

        body = {"owner_id": "user-1", "task_id": "task-1", "image_index": 0}
        first = self.client.post("/api/admin/inspirations/from-task", headers=AUTH_HEADERS, json=body)
        second = self.client.post("/api/admin/inspirations/from-task", headers=AUTH_HEADERS, json=body)

        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["created"])
        self.assertFalse(second.json()["created"])

    def test_missing_source_returns_not_found(self):
        response = self.client.post(
            "/api/admin/inspirations/from-task",
            headers=AUTH_HEADERS,
            json={"owner_id": "user-1", "task_id": "missing", "image_index": 0},
        )
        self.assertEqual(response.status_code, 404)

    def test_archived_preview_requires_identity_and_streams_the_image(self):
        unauthenticated = self.client.get("/inspiration-images/curated-1.png")
        self.assertEqual(unauthenticated.status_code, 401)

        response = self.client.get("/inspiration-images/curated-1.png", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"PNG")

        missing = self.client.get("/inspiration-images/missing.png", headers=AUTH_HEADERS)
        self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()
