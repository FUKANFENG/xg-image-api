from __future__ import annotations

import io
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

import api.workspace as workspace_module
from services.advanced_creative_service import AdvancedCreativeService
from services.creative_intelligence_service import CreativeIntelligenceService
from services.creative_workspace_service import CreativeWorkspaceService


OWNER = {"id": "owner-1", "name": "Owner", "role": "user", "group": "default"}
ADMIN = {"id": "admin", "name": "Admin", "role": "admin"}
PNG_BYTES = b"\x89PNG\r\n\x1a\nreverse-prompt-test"


@dataclass(frozen=True)
class FakeStoredImage:
    rel: str
    url: str


class FakeImageStorage:
    def __init__(self):
        self.items: dict[str, bytes] = {}
        self.counter = 0

    def get_bytes(self, path: str) -> bytes:
        return self.items[path]

    def exists(self, path: str) -> bool:
        return path in self.items

    def save(self, payload: bytes, base_url=None, extension="png"):
        self.counter += 1
        rel = f"2026/api-{self.counter}.{extension}"
        self.items[rel] = payload
        return FakeStoredImage(rel, f"/images/{rel}")


class FakeEmbeddingModel:
    def embed(self, _items):
        return iter([[1.0] + [0.0] * 511])


class FakeImageTaskService:
    def __init__(self):
        self.tasks: dict[str, dict[str, object]] = {}
        self.generation_calls: list[dict[str, object]] = []

    def submit_generation(self, _identity, **kwargs):
        self.generation_calls.append(kwargs)
        task = {
            "id": kwargs["client_task_id"],
            "status": "queued",
            "mode": "generate",
            "model": kwargs["model"],
            "size": kwargs["size"],
            "quality": kwargs["quality"],
            "prompt": kwargs["prompt"],
            "workflow": kwargs["workflow"],
            "created_at": "2026-07-21 00:00:00",
            "updated_at": "2026-07-21 00:00:00",
        }
        self.tasks[str(task["id"])] = task
        return task

    def list_tasks(self, _identity, ids):
        items = [self.tasks[item] for item in ids if item in self.tasks]
        return {"items": items, "missing_ids": [item for item in ids if item not in self.tasks]}


class FakeImageIntegrityService:
    def scan(self, _identity, *, include_all=False, force=False):
        return {
            "summary": {"missing": 1, "recoverable": 1, "unique_images": 2},
            "items": [],
            "problems": [],
            "scanned_at": "2026-07-27T00:00:00+08:00",
        }

    def repair(self, _identity, *, include_all=False):
        return {
            "restored": ["2026/07/27/restored.png"],
            "backed_up": [],
            "failed": [],
            "before": {"missing": 1},
            "after": {"missing": 0},
            "summary": {"missing": 0},
            "items": [],
            "problems": [],
            "scanned_at": "2026-07-27T00:01:00+08:00",
        }


class WorkspaceApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.service = CreativeWorkspaceService(Path(self.temp_dir.name) / "workspace.db")
        self.advanced_service = AdvancedCreativeService(Path(self.temp_dir.name) / "workspace.db")
        self.image_storage = FakeImageStorage()
        self.intelligence = CreativeIntelligenceService(
            Path(self.temp_dir.name) / "workspace.db",
            workspace_service=self.service,
            storage_service=self.image_storage,
            image_model_factory=FakeEmbeddingModel,
            text_model_factory=FakeEmbeddingModel,
        )
        self.tasks = FakeImageTaskService()
        self.integrity = FakeImageIntegrityService()
        patchers = [
            mock.patch.object(workspace_module, "creative_workspace_service", self.service),
            mock.patch.object(workspace_module, "advanced_creative_service", self.advanced_service),
            mock.patch.object(workspace_module, "creative_intelligence_service", self.intelligence),
            mock.patch.object(workspace_module, "image_task_service", self.tasks),
            mock.patch.object(workspace_module, "image_integrity_service", self.integrity),
            mock.patch.object(workspace_module, "require_identity", return_value=OWNER),
            mock.patch.object(workspace_module, "require_admin", return_value=ADMIN),
            mock.patch.object(workspace_module, "check_request", return_value=None),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(workspace_module.create_router())
        self.client = TestClient(app)

    def test_asset_route_accepts_pagination_parameters(self):
        for index in range(3):
            self.service.create_asset(OWNER, name=f"分页资产 {index}")

        response = self.client.get("/api/workspace/assets?limit=1&offset=1")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["items"]), 1)
        self.assertEqual(response.json()["total"], 3)
        self.assertTrue(response.json()["has_more"])

    def test_asset_integrity_and_bulk_archive_routes_are_static_and_owner_scoped(self):
        project = self.service.create_project(OWNER, name="目标项目")
        first = self.service.create_asset(OWNER, name="一", asset_type="image")
        second = self.service.create_asset(OWNER, name="二", asset_type="image")

        scan = self.client.get("/api/workspace/assets/integrity?force=true")
        repair = self.client.post("/api/workspace/assets/integrity/repair", json={})
        archived = self.client.post(
            "/api/workspace/assets/bulk-archive",
            json={"asset_ids": [first["id"], second["id"]], "project_id": project["id"]},
        )

        self.assertEqual(scan.status_code, 200, scan.text)
        self.assertEqual(scan.json()["summary"]["recoverable"], 1)
        self.assertEqual(repair.status_code, 200, repair.text)
        self.assertEqual(repair.json()["restored"], ["2026/07/27/restored.png"])
        self.assertEqual(archived.status_code, 200, archived.text)
        self.assertEqual(archived.json()["updated"], 2)

        forbidden = self.client.get("/api/workspace/assets/integrity?include_all=true")
        self.assertEqual(forbidden.status_code, 403, forbidden.text)

    def test_duplicate_detection_route_returns_scoped_summary(self):
        expected = {
            "summary": {"scanned": 2, "duplicates": 1, "exact_duplicates": 0, "failures": 0, "threshold": 8},
            "pairs": [{"asset_id": "a2", "duplicate_of": "a1", "distance": 1}],
            "failures": [],
            "scanned_at": "2026-07-27T00:00:00",
        }
        with mock.patch.object(
            self.advanced_service,
            "detect_duplicate_assets",
            return_value=expected,
        ) as detector:
            response = self.client.post(
                "/api/workspace/assets/detect-duplicates",
                json={"threshold": 8},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["summary"]["duplicates"], 1)
        detector.assert_called_once_with(OWNER, threshold=8, limit=200)

    def test_generation_batch_creates_independent_tasks_and_summary(self):
        response = self.client.post(
            "/api/workspace/batches/generations",
            json={"prompt": "品牌海报", "count": 3, "size": "1024x1024"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["counts"]["total"], 3)
        self.assertEqual(payload["counts"]["queued"], 3)
        self.assertEqual(len(self.tasks.generation_calls), 3)
        self.assertEqual(
            {call["model"] for call in self.tasks.generation_calls},
            {"gpt-image-2"},
        )
        self.assertEqual(
            {call["workflow"]["batch_id"] for call in self.tasks.generation_calls},
            {payload["id"]},
        )

    def test_conversation_image_request_defaults_to_web_model(self):
        request = workspace_module.ConversationMessageRequest(instruction="把背景改成蓝色")

        self.assertEqual(request.model, "gpt-image-2")

    def test_project_and_asset_routes_keep_folder_deletion_non_destructive(self):
        project_response = self.client.post(
            "/api/workspace/projects",
            json={"name": "交付项目", "description": "海报与演示稿", "tags": ["客户"]},
        )
        self.assertEqual(project_response.status_code, 200, project_response.text)
        project_id = project_response.json()["id"]
        asset = self.service.archive_asset(
            OWNER,
            name="需求提示词",
            asset_type="prompt",
            project_id=project_id,
            prompt="极简产品海报",
        )

        delete_response = self.client.delete(f"/api/workspace/projects/{project_id}")
        self.assertEqual(delete_response.status_code, 200, delete_response.text)
        restored_asset = self.service.get_asset(OWNER, str(asset["id"]))
        self.assertIsNone(restored_asset["project_id"])

    def test_policy_endpoint_updates_group_policy(self):
        response = self.client.put(
            "/api/workspace/admin/policies/group%3Adefault",
            json={
                "subject_type": "group",
                "features": {"batch": False},
                "rate_limit_per_minute": 5,
                "frozen": False,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["features"]["batch"])
        self.assertEqual(response.json()["rate_limit_per_minute"], 5)

    def test_reverse_prompt_accepts_uploaded_image(self):
        expected = {
            "prompt": "白色背景中的玻璃香水瓶",
            "summary": "香水产品图",
            "subject": "香水瓶",
            "composition": "居中",
            "lighting": "柔光",
            "colors": ["白色"],
            "style": "商业摄影",
            "text_content": [],
            "model": "auto",
            "elapsed_ms": 120,
        }
        with mock.patch.object(
            workspace_module,
            "reverse_image_prompt",
            return_value=expected,
            create=True,
        ) as reverse:
            response = self.client.post(
                "/api/workspace/tools/reverse-prompt",
                files={"image": ("sample.png", PNG_BYTES, "image/png")},
                data={"detail": "standard", "purpose": "电商主图"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["prompt"], expected["prompt"])
        self.assertEqual(reverse.call_args.args[:3], (PNG_BYTES, "sample.png", "image/png"))
        self.assertEqual(reverse.call_args.kwargs["purpose"], "电商主图")

    def test_reverse_prompt_accepts_owned_asset_but_rejects_foreign_asset(self):
        asset = self.service.create_asset(OWNER, name="自己的作品")
        version = self.service._insert_version(
            owner="owner-1",
            asset_id=str(asset["id"]),
            task_id="reverse-owned",
            image_index=0,
            operation="generate",
            image_path="2026/owned.png",
            image_url="/images/2026/owned.png",
            prompt="",
            params={},
            parent_version_id="",
            make_current=True,
        )
        foreign = self.service.create_asset({"id": "owner-2", "role": "user"}, name="其他用户作品")
        self.service._insert_version(
            owner="owner-2",
            asset_id=str(foreign["id"]),
            task_id="reverse-foreign",
            image_index=0,
            operation="generate",
            image_path="2026/foreign.png",
            image_url="/images/2026/foreign.png",
            prompt="",
            params={},
            parent_version_id="",
            make_current=True,
        )
        result = {
            "prompt": "夜景人物海报",
            "summary": "",
            "subject": "",
            "composition": "",
            "lighting": "",
            "colors": [],
            "style": "",
            "text_content": [],
            "model": "auto",
            "elapsed_ms": 80,
        }
        with (
            mock.patch.object(workspace_module.image_storage_service, "get_bytes", return_value=PNG_BYTES),
            mock.patch.object(workspace_module, "reverse_image_prompt", return_value=result, create=True),
        ):
            owned_response = self.client.post(
                "/api/workspace/tools/reverse-prompt",
                data={"asset_id": asset["id"], "version_id": version["id"]},
            )
            foreign_response = self.client.post(
                "/api/workspace/tools/reverse-prompt",
                data={"asset_id": foreign["id"]},
            )

        self.assertEqual(owned_response.status_code, 200, owned_response.text)
        self.assertEqual(foreign_response.status_code, 404, foreign_response.text)

    def test_recipe_search_share_review_and_trash_routes(self):
        recipe_response = self.client.post(
            "/api/workspace/recipes",
            json={"name": "海报配方", "category": "poster", "settings": {"size": "1536x1024"}},
        )
        self.assertEqual(recipe_response.status_code, 200, recipe_response.text)
        recipe_id = recipe_response.json()["id"]
        recipes = self.client.get("/api/workspace/recipes").json()["items"]
        self.assertIn(recipe_id, {item["id"] for item in recipes})

        asset = self.service.create_asset(OWNER, name="电影感人物海报")
        version = self.service._insert_version(
            owner="owner-1",
            asset_id=str(asset["id"]),
            task_id="api-advanced-1",
            image_index=0,
            operation="generate",
            image_path="2026/poster.png",
            image_url="/images/2026/poster.png",
            prompt="夜景电影感人物海报",
            params={},
            parent_version_id="",
            make_current=True,
        )
        search = self.client.get("/api/workspace/search/assets?query=夜景")
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(search.json()["items"][0]["id"], asset["id"])

        share = self.client.post(
            f"/api/workspace/assets/{asset['id']}/shares",
            json={"version_id": version["id"], "expires_days": 7},
        )
        self.assertEqual(share.status_code, 200, share.text)
        public = self.client.get(f"/api/shared/{share.json()['token']}")
        self.assertEqual(public.status_code, 200, public.text)
        self.assertEqual(public.json()["asset"]["name"], "电影感人物海报")

        review = self.client.post(
            f"/api/workspace/assets/{asset['id']}/reviews",
            json={"version_id": version["id"]},
        )
        self.assertEqual(review.status_code, 200, review.text)
        resolved = self.client.patch(
            f"/api/workspace/reviews/{review.json()['id']}",
            json={"status": "approved", "comment": "通过"},
        )
        self.assertEqual(resolved.status_code, 200, resolved.text)
        self.assertEqual(resolved.json()["status"], "approved")

        self.assertEqual(self.client.delete(f"/api/workspace/assets/{asset['id']}").status_code, 200)
        trash_items = self.client.get("/api/workspace/trash").json()["items"]
        asset_trash = next(item for item in trash_items if item["entity_type"] == "asset")
        self.assertEqual(
            self.client.post(f"/api/workspace/trash/{asset_trash['id']}/restore").status_code,
            200,
        )
        self.assertEqual(self.service.get_asset(OWNER, str(asset["id"]))["id"], asset["id"])

    def test_intelligence_routes_cover_search_derivatives_branches_boards_notifications_budget_and_delivery(self):
        project = self.service.create_project(OWNER, name="智能项目")
        asset = self.service.create_asset(OWNER, name="雨夜蓝色城市", project_id=str(project["id"]))
        source = io.BytesIO()
        Image.new("RGB", (320, 180), (20, 60, 130)).save(source, format="PNG")
        source_path = "2026/source.png"
        self.image_storage.items[source_path] = source.getvalue()
        version = self.service._insert_version(
            owner="owner-1",
            asset_id=str(asset["id"]),
            task_id="intelligence-api",
            image_index=0,
            operation="generate",
            image_path=source_path,
            image_url=f"/images/{source_path}",
            prompt="雨夜城市蓝色海报",
            params={},
            parent_version_id="",
            make_current=True,
        )

        indexed = self.client.post(
            f"/api/workspace/assets/{asset['id']}/intelligence/index",
            json={"version_id": version["id"]},
        )
        searched = self.client.get("/api/workspace/search/semantic?query=雨夜城市")
        derived = self.client.post(
            f"/api/workspace/assets/{asset['id']}/derivatives",
            json={"version_id": version["id"], "presets": ["wechat"], "mode": "contain"},
        )
        branch = self.client.post(
            f"/api/workspace/assets/{asset['id']}/branches",
            json={"name": "暖色方向", "root_version_id": version["id"]},
        )
        tree = self.client.get(f"/api/workspace/assets/{asset['id']}/version-tree")
        board = self.client.post(
            "/api/workspace/boards",
            json={"name": "品牌画板", "project_id": project["id"]},
        )
        board_item = self.client.post(
            f"/api/workspace/boards/{board.json()['id']}/items",
            json={"item_type": "text", "content": "蓝色雨夜，电影感"},
        )
        draft = self.client.get(f"/api/workspace/boards/{board.json()['id']}/draft")
        notification = self.client.post("/api/workspace/notifications/test", json={})
        budget = self.client.put(
            f"/api/workspace/admin/projects/{project['id']}/budget",
            json={
                "owner_id": "owner-1",
                "credit_limit": 50,
                "budget_type": "client",
                "label": "客户甲",
                "unit_cost": 0.8,
            },
        )
        delivery = self.client.get(f"/api/workspace/projects/{project['id']}/delivery")

        self.assertEqual(indexed.status_code, 200, indexed.text)
        self.assertEqual(indexed.json()["dimension"], 512)
        self.assertEqual(searched.status_code, 200, searched.text)
        self.assertEqual(searched.json()["items"][0]["asset_id"], asset["id"])
        self.assertEqual(derived.status_code, 200, derived.text)
        self.assertEqual(derived.json()["items"][0]["width"], 900)
        self.assertEqual(branch.status_code, 200, branch.text)
        self.assertEqual(tree.json()["branches"][0]["id"], branch.json()["id"])
        self.assertEqual(board_item.status_code, 200, board_item.text)
        self.assertIn("蓝色雨夜", draft.json()["prompt"])
        self.assertEqual(notification.status_code, 200, notification.text)
        self.assertEqual(budget.status_code, 200, budget.text)
        self.assertEqual(budget.json()["unit_cost"], 0.8)
        self.assertEqual(delivery.status_code, 200, delivery.text)
        self.assertEqual(delivery.headers["content-type"], "application/zip")


if __name__ == "__main__":
    unittest.main()
