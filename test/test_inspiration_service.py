from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.image_task_service import ImageTaskService
from services.inspiration_service import InspirationService


class InspirationServiceTests(unittest.TestCase):
    def test_curating_a_task_is_idempotent_and_hides_private_source_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = InspirationService(Path(directory) / "inspirations.json")
            source = {
                "owner_id": "user-private-id",
                "task_id": "task-1",
                "image_index": 0,
                "prompt": "  为一盏极简台灯做一张温暖的产品静物摄影。  ",
                "preview_url": "/images/2026/07/lamp.png",
                "size": "1536x1024",
                "quality": "high",
            }

            with mock.patch("services.inspiration_service.image_storage_service.get_bytes", return_value=b"PNG"):
                item, created = service.curate_from_task(source)
                duplicate, duplicate_created = service.curate_from_task(source)

            self.assertTrue(created)
            self.assertFalse(duplicate_created)
            self.assertEqual(item["id"], duplicate["id"])
            self.assertEqual(item["category"], "curated")
            self.assertTrue(str(item["preview"]).startswith("/inspiration-images/curated-"))
            archive_name = str(item["preview"]).rsplit("/", 1)[-1]
            self.assertTrue(service.get_archived_image_path(archive_name).is_file())
            public_item = service.list_public()[0]
            self.assertNotIn("source_owner_id", public_item)
            self.assertNotIn("source_task_id", public_item)
            self.assertEqual(public_item["prompt"], source["prompt"].strip())

    def test_remote_preview_is_not_accepted_for_public_curation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = InspirationService(Path(directory) / "inspirations.json")
            with self.assertRaisesRegex(ValueError, "未保存在本地"):
                service.curate_from_task({
                    "owner_id": "user-1",
                    "task_id": "task-1",
                    "image_index": 0,
                    "prompt": "example",
                    "preview_url": "https://example.com/temp.png",
                })


class ImageTaskCurationCandidateTests(unittest.TestCase):
    def test_only_completed_user_text_to_image_tasks_are_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = ImageTaskService(Path(directory) / "image_tasks.json", retention_days_getter=lambda: 365)
            service._tasks = {
                "user-a:good": {
                    "id": "good",
                    "owner_id": "user-a",
                    "owner_role": "user",
                    "status": "success",
                    "mode": "generate",
                    "prompt": "a valid prompt",
                    "size": "1024x1024",
                    "quality": "high",
                    "created_at": "2026-07-18 12:00:00",
                    "updated_at": "2026-07-18 12:01:00",
                    "data": [{"url": "http://testserver/images/2026/07/good.png"}],
                },
                "user-a:edit": {
                    "id": "edit",
                    "owner_id": "user-a",
                    "owner_role": "user",
                    "status": "success",
                "mode": "edit",
                "prompt": "private upload",
                "created_at": "2026-07-18 12:00:00",
                "updated_at": "2026-07-18 12:01:00",
                "data": [{"url": "http://testserver/images/2026/07/edit.png"}],
                },
                "admin:admin": {
                    "id": "admin",
                    "owner_id": "admin",
                    "owner_role": "admin",
                    "status": "success",
                "mode": "generate",
                "prompt": "admin prompt",
                "created_at": "2026-07-18 12:00:00",
                "updated_at": "2026-07-18 12:01:00",
                "data": [{"url": "http://testserver/images/2026/07/admin.png"}],
                },
            }

            candidates = service.list_admin_inspiration_candidates()

            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]["task_id"], "good")
            self.assertEqual(candidates[0]["preview_url"], "/images/2026/07/good.png")
            source = service.get_admin_inspiration_source("user-a", "good", 0)
            self.assertEqual(source["preview_url"], "/images/2026/07/good.png")
            with self.assertRaisesRegex(ValueError, "文生图"):
                service.get_admin_inspiration_source("user-a", "edit", 0)

    def test_candidate_pages_keep_order_and_report_totals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = ImageTaskService(Path(directory) / "image_tasks.json", retention_days_getter=lambda: 365)
            service._tasks = {
                "user-a:older": {
                    "id": "older",
                    "owner_id": "user-a",
                    "owner_role": "user",
                    "status": "success",
                    "mode": "generate",
                    "prompt": "older prompt",
                    "created_at": "2026-07-18 10:00:00",
                    "updated_at": "2026-07-18 10:01:00",
                    "data": [{"url": "http://testserver/images/2026/07/older.png"}],
                },
                "user-a:newer": {
                    "id": "newer",
                    "owner_id": "user-a",
                    "owner_role": "user",
                    "status": "success",
                    "mode": "generate",
                    "prompt": "newer prompt",
                    "created_at": "2026-07-18 11:00:00",
                    "updated_at": "2026-07-18 11:01:00",
                    "data": [
                        {"url": "http://testserver/images/2026/07/newer-1.png"},
                        {"url": "http://testserver/images/2026/07/newer-2.png"},
                    ],
                },
            }

            first_page = service.list_admin_inspiration_candidate_page(page=1, page_size=2)
            second_page = service.list_admin_inspiration_candidate_page(page=2, page_size=2)
            clamped_page = service.list_admin_inspiration_candidate_page(page=99, page_size=2)

            self.assertEqual(first_page["total"], 3)
            self.assertEqual(first_page["total_pages"], 2)
            self.assertEqual(first_page["page"], 1)
            self.assertEqual([item["task_id"] for item in first_page["items"]], ["newer", "newer"])
            self.assertEqual(second_page["page"], 2)
            self.assertEqual([item["task_id"] for item in second_page["items"]], ["older"])
            self.assertEqual(clamped_page["page"], 2)


if __name__ == "__main__":
    unittest.main()
