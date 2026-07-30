from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

import api.operations as operations_module
from services.creative_operations_service import CreativeOperationsService


USER = {"id": "user-1", "role": "user", "name": "用户一", "group": "default"}
ADMIN = {"id": "admin", "role": "admin", "name": "管理员"}


class FakeAuthService:
    def list_image_credit_events(self, _identity, **_kwargs):
        return {
            "items": [
                {
                    "id": "event-1",
                    "task_id": "task-1",
                    "action": "consume",
                    "amount": 0,
                    "balance_before": 9,
                    "balance_after": 9,
                    "used_before": 0,
                    "used_after": 1,
                    "reason": "成功核销",
                    "created_at": "2026-07-28T00:00:00Z",
                    "owner_id": "user-1",
                    "owner_name": "用户一",
                }
            ],
            "pagination": {"limit": 50, "offset": 0, "total": 1},
        }

    def list_users(self):
        return [{"id": "user-1", "name": "用户一", "role": "user", "group": "default", "enabled": True}]


class FakeTaskService:
    def task_timeline(self, _identity, task_id):
        return {
            "task_id": task_id,
            "status": "success",
            "current_stage": "completed",
            "total_duration_ms": 1000,
            "items": [{"stage": "completed", "status": "success", "created_at": "2026-07-28T00:00:00Z"}],
        }


class FakeAccountService:
    def image_runtime_health(self):
        return {
            "total_slots": 3,
            "used_slots": 1,
            "cooling_accounts": 0,
            "accounts": [
                {
                    "email": "masked@example.test",
                    "quota": 5,
                    "inflight": 1,
                    "concurrency_limit": 2,
                    "circuit_state": "closed",
                    "scheduler_factors": {},
                }
            ],
        }


def png_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (16, 16), "white").save(output, format="PNG")
    return output.getvalue()


class OperationsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.service = CreativeOperationsService(Path(self.temp_dir.name) / "operations.db")
        patchers = [
            mock.patch.object(operations_module, "creative_operations_service", self.service),
            mock.patch.object(operations_module, "auth_service", FakeAuthService()),
            mock.patch.object(operations_module, "image_task_service", FakeTaskService()),
            mock.patch.object(operations_module, "account_service", FakeAccountService()),
            mock.patch.object(operations_module, "require_identity", return_value=USER),
            mock.patch.object(operations_module, "require_admin", return_value=ADMIN),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(operations_module.create_router())
        self.client = TestClient(app)

    def test_model_route_and_template_render_contracts(self) -> None:
        routed = self.client.post(
            "/api/operations/model-route",
            json={"mode": "edit", "prompt": "修改 Logo", "available_models": ["codex-gpt-image-2", "gpt-image-2"]},
        )
        rendered = self.client.post(
            "/api/operations/prompt-templates/render",
            json={"template": "{{商品}}-{{场景}}", "variables": {"商品": ["杯子", "手表"], "场景": ["展台"]}},
        )

        self.assertEqual(routed.status_code, 200, routed.text)
        self.assertEqual(routed.json()["data"]["model"], "gpt-image-2")
        self.assertEqual(rendered.status_code, 200, rendered.text)
        self.assertEqual(rendered.json()["data"]["total"], 2)

    def test_quota_and_timeline_contracts(self) -> None:
        ledger = self.client.get("/api/operations/quota-ledger")
        timeline = self.client.get("/api/operations/tasks/task-1/timeline")

        self.assertEqual(ledger.status_code, 200, ledger.text)
        self.assertEqual(ledger.json()["pagination"]["total"], 1)
        self.assertEqual(timeline.status_code, 200, timeline.text)
        self.assertEqual(timeline.json()["data"]["current_stage"], "completed")

    def test_scheduler_response_adds_selection_reason(self) -> None:
        response = self.client.get("/api/operations/accounts/scheduler")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("selection_reason", response.json()["data"]["accounts"][0])

    def test_local_edit_upload_returns_normalized_regions(self) -> None:
        expected = {
            "regions": [{"id": "region-1", "type": "product", "label": "商品", "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5, "confidence": 0.9, "issue": "", "suggestion": "增强质感"}],
            "global_suggestion": "保持构图",
            "model": "auto",
            "elapsed_ms": 10,
        }
        with mock.patch.object(operations_module, "suggest_local_edits", return_value=expected):
            response = self.client.post(
                "/api/operations/local-edit/suggestions",
                files={"image": ("sample.png", png_bytes(), "image/png")},
                data={"instruction": "识别商品"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"]["regions"][0]["type"], "product")


if __name__ == "__main__":
    unittest.main()
