from __future__ import annotations

import base64
import io
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

import api.image_tasks as image_tasks_module
from services.config import config


AUTH_HEADERS = {"Authorization": f"Bearer {config.auth_key}"}
PNG_BYTES = b"\x89PNG\r\n\x1a\n"
DATA_IMAGE_URL = f"data:image/png;base64,{base64.b64encode(PNG_BYTES).decode('ascii')}"


def sized_png(width: int, height: int) -> bytes:
    output = io.BytesIO()
    Image.new("RGBA", (width, height), (255, 255, 255, 255)).save(output, format="PNG")
    return output.getvalue()


class FakeImageTaskService:
    def __init__(self):
        self.generation_calls = []
        self.edit_calls = []
        self.retry_calls = []
        self.retry_edit_calls = []
        self.cancel_calls = []
        self.delete_calls = []

    def metrics(self):
        return {
            "queue": {"queued": 2, "running": 1},
            "performance": {"p50_secs": 20.0, "p95_secs": 30.0},
            "tasks": {"total": 3},
            "errors": {},
            "storage": {"healthy": True, "journal_mode": "wal", "quick_check": "ok", "task_count": 3},
            "generated_at": "2026-07-18 00:00:00",
        }

    def estimate(self, _identity):
        return {
            "accepting": True,
            "queue_position": 3,
            "estimated_wait_secs": 60,
            "estimated_generation_secs": 30,
            "estimated_total_secs": 90,
            "estimated_range_secs": {"low": 68, "high": 135},
            "confidence": "medium",
        }

    def submit_generation(self, identity, **kwargs):
        self.generation_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "success",
            "mode": "generate",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
            "data": [{"url": f"{kwargs['base_url']}/images/fake.png"}],
        }

    def submit_edit(self, identity, **kwargs):
        self.edit_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "queued",
            "mode": "edit",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def retry_generation(self, identity, task_id, *, base_url):
        self.retry_calls.append((identity, task_id, base_url))
        return {
            "id": task_id,
            "status": "queued",
            "mode": "generate",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def get_task(self, _identity, task_id):
        if task_id == "failed-edit":
            return {
                "id": task_id,
                "status": "error",
                "mode": "edit",
                "workflow": {"source_paths": ["stored/source.png"], "mask_paths": ["stored/mask.png"]},
            }
        return {"id": task_id, "status": "error", "mode": "generate", "workflow": {}}

    def retry_edit(self, identity, task_id, *, base_url, images, masks):
        self.retry_edit_calls.append((identity, task_id, base_url, images, masks))
        return {
            "id": task_id,
            "status": "queued",
            "mode": "edit",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def delete_failed_task(self, identity, task_id):
        self.delete_calls.append((identity, task_id))
        return {"ok": True, "id": task_id}

    def cancel_task(self, identity, task_id):
        self.cancel_calls.append((identity, task_id))
        return {
            "id": task_id,
            "status": "error",
            "mode": "generate",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:01",
            "error": "已由用户手动停止",
            "error_code": "cancelled_by_user",
        }

    def list_tasks(self, _identity, ids, **_page):
        return {
            "items": [
                {
                    "id": task_id,
                    "status": "success",
                    "mode": "generate",
                    "created_at": "2026-01-01 00:00:00",
                    "updated_at": "2026-01-01 00:00:00",
                    "data": [{"url": "http://testserver/images/fake.png"}],
                }
                for task_id in ids
                if task_id != "missing"
            ],
            "missing_ids": [task_id for task_id in ids if task_id == "missing"],
        }


class ImageTasksApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakeImageTaskService()
        self.service_patcher = mock.patch.object(image_tasks_module, "image_task_service", self.fake_service)
        self.service_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.filter_patcher = mock.patch.object(image_tasks_module, "check_request", return_value=None)
        self.filter_patcher.start()
        self.addCleanup(self.filter_patcher.stop)
        app = FastAPI()
        app.include_router(image_tasks_module.create_router())
        self.client = TestClient(app)

    def test_create_generation_task(self):
        response = self.client.post(
            "/api/image-tasks/generations",
            headers=AUTH_HEADERS,
            json={"client_task_id": "task-1", "prompt": "cat", "model": "gpt-image-2"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["id"], "task-1")
        self.assertEqual(payload["status"], "success")
        self.assertEqual(len(self.fake_service.generation_calls), 1)

    def test_queue_estimate_is_available_without_mutating_tasks(self):
        response = self.client.get("/api/image-tasks/estimate", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["accepting"])
        self.assertEqual(response.json()["estimated_total_secs"], 90)

    def test_retry_generation_task(self):
        response = self.client.post("/api/image-tasks/failed-task/retry", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "failed-task")
        self.assertEqual(len(self.fake_service.retry_calls), 1)
        self.assertEqual(self.fake_service.retry_calls[0][1], "failed-task")

    def test_retry_edit_task_reuses_stored_source_and_mask(self):
        with mock.patch.object(
            image_tasks_module,
            "_stored_reference",
            side_effect=lambda path: (PNG_BYTES, path.rsplit("/", 1)[-1], "image/png"),
        ):
            response = self.client.post("/api/image-tasks/failed-edit/retry", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["mode"], "edit")
        self.assertEqual(len(self.fake_service.retry_edit_calls), 1)
        self.assertEqual(len(self.fake_service.retry_edit_calls[0][3]), 1)
        self.assertEqual(len(self.fake_service.retry_edit_calls[0][4]), 1)

    def test_bulk_retry_handles_generation_and_edit_tasks(self):
        with mock.patch.object(
            image_tasks_module,
            "_stored_reference",
            side_effect=lambda path: (PNG_BYTES, path.rsplit("/", 1)[-1], "image/png"),
        ):
            response = self.client.post(
                "/api/image-tasks/bulk-retry",
                headers=AUTH_HEADERS,
                json={"task_ids": ["failed-task", "failed-edit"]},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["items"]), 2)
        self.assertEqual(response.json()["errors"], [])

    def test_delete_failed_task(self):
        response = self.client.delete("/api/image-tasks/failed-task", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True, "id": "failed-task"})
        self.assertEqual(len(self.fake_service.delete_calls), 1)
        self.assertEqual(self.fake_service.delete_calls[0][1], "failed-task")

    def test_cancel_running_task(self):
        response = self.client.post("/api/image-tasks/running-task/cancel", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["error_code"], "cancelled_by_user")
        self.assertEqual(len(self.fake_service.cancel_calls), 1)
        self.assertEqual(self.fake_service.cancel_calls[0][1], "running-task")

    def test_create_edit_task_accepts_multiple_images(self):
        """测试图片编辑任务接口支持多个上传图片。"""
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={"client_task_id": "edit-1", "prompt": "edit", "model": "gpt-image-2"},
            files=[
                ("image", ("one.png", b"one", "image/png")),
                ("image", ("two.png", b"two", "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "edit-1")
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(len(images), 2)

    def test_normal_user_can_create_edit_task(self):
        """普通用户会话可提交图片二创，且身份原样传入额度隔离链路。"""
        user_identity = {"id": "user-1", "name": "设计用户", "role": "user", "image_quota": 3}

        with mock.patch.object(image_tasks_module, "require_identity", return_value=user_identity):
            response = self.client.post(
                "/api/image-tasks/edits",
                headers={"Authorization": "Bearer user-session"},
                data={"client_task_id": "user-edit-1", "prompt": "change background", "model": "gpt-image-2"},
                files={"image": ("source.png", PNG_BYTES, "image/png")},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["mode"], "edit")
        self.assertEqual(self.fake_service.edit_calls[0][0], user_identity)

    def test_create_edit_task_accepts_image_url(self):
        """测试图片编辑任务接口支持表单 image_url 引用。"""
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={
                "client_task_id": "edit-url-1",
                "prompt": "edit",
                "model": "gpt-image-2",
                "image_url": DATA_IMAGE_URL,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(images, [(PNG_BYTES, "image_url.png", "image/png")])

    def test_outpaint_edit_records_normalized_workflow_fields(self):
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={
                "client_task_id": "outpaint-1",
                "prompt": "向右和上方扩展城市夜景",
                "model": "codex-gpt-image-2",
                "operation_type": "outpaint",
                "outpaint_directions": "right,top,right",
                "canvas_ratio": "16:9",
                "profile_strength": "strict",
                "preserve_strength": "balanced",
            },
            files={"image": ("source.png", sized_png(128, 128), "image/png")},
        )

        self.assertEqual(response.status_code, 200, response.text)
        workflow = self.fake_service.edit_calls[0][1]["workflow"]
        self.assertEqual(workflow["outpaint_directions"], ["right", "top"])
        self.assertEqual(workflow["canvas_ratio"], "16:9")
        self.assertEqual(workflow["profile_strength"], "strict")
        self.assertEqual(workflow["preserve_strength"], "balanced")

    def test_edit_rejects_mask_with_different_dimensions(self):
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={
                "client_task_id": "mask-size-1",
                "prompt": "局部重绘",
                "operation_type": "inpaint",
            },
            files=[
                ("image", ("source.png", sized_png(128, 128), "image/png")),
                ("mask", ("mask.png", sized_png(64, 64), "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("尺寸", response.text)
        self.assertEqual(self.fake_service.edit_calls, [])

    def test_list_tasks_reports_missing_ids(self):
        response = self.client.get("/api/image-tasks?ids=task-1,missing", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["items"]], ["task-1"])
        self.assertEqual(payload["missing_ids"], ["missing"])

    def test_admin_can_read_runtime_metrics(self):
        response = self.client.get("/api/image-tasks/metrics", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["queue"]["queued"], 2)
        self.assertEqual(response.json()["storage"]["journal_mode"], "wal")
        self.assertIn("accounts", response.json())
        self.assertIn("user_quotas", response.json())


if __name__ == "__main__":
    unittest.main()
