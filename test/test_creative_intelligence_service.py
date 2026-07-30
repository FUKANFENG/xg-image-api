from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from services.creative_intelligence_service import CreativeIntelligenceService, _RejectRedirects
from services.creative_workspace_service import CreativeWorkspaceService


OWNER = {"id": "owner-1", "role": "user", "name": "Owner"}
OTHER = {"id": "owner-2", "role": "user", "name": "Other"}


def image_bytes(color: tuple[int, int, int] = (35, 90, 170), size: tuple[int, int] = (320, 180)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


@dataclass(frozen=True)
class FakeStoredImage:
    rel: str
    url: str


class FakeStorage:
    def __init__(self):
        self.items: dict[str, bytes] = {}
        self.counter = 0

    def get_bytes(self, path: str) -> bytes:
        if path not in self.items:
            raise FileNotFoundError(path)
        return self.items[path]

    def exists(self, path: str) -> bool:
        return path in self.items

    def save(self, payload: bytes, base_url: str | None = None, extension: str = "png") -> FakeStoredImage:
        self.counter += 1
        rel = f"2026/07/28/stored-{self.counter}.{extension}"
        self.items[rel] = payload
        return FakeStoredImage(rel=rel, url=f"/images/{rel}")


class FakeEmbeddingModel:
    def __init__(self, vector: list[float]):
        self.vector = vector

    def embed(self, _items):
        return iter([self.vector])


class CreativeIntelligenceServiceTests(unittest.TestCase):
    def make_services(self, root: str):
        path = Path(root) / "workspace.db"
        workspace = CreativeWorkspaceService(path)
        storage = FakeStorage()
        vector = [1.0] + [0.0] * 511
        service = CreativeIntelligenceService(
            path,
            workspace_service=workspace,
            storage_service=storage,
            image_model_factory=lambda: FakeEmbeddingModel(vector),
            text_model_factory=lambda: FakeEmbeddingModel(vector),
        )
        return workspace, storage, service

    @staticmethod
    def create_asset(workspace: CreativeWorkspaceService, storage: FakeStorage):
        project = workspace.create_project(OWNER, name="蓝色城市海报")
        asset = workspace.create_asset(OWNER, name="雨夜蓝色城市", project_id=str(project["id"]))
        source_path = "2026/07/28/source.png"
        storage.items[source_path] = image_bytes()
        version = workspace._insert_version(
            owner="owner-1",
            asset_id=str(asset["id"]),
            task_id="task-source",
            image_index=0,
            operation="generate",
            image_path=source_path,
            image_url=f"/images/{source_path}",
            prompt="雨夜城市蓝色海报",
            params={},
            parent_version_id="",
            make_current=True,
        )
        return project, workspace.get_asset(OWNER, str(asset["id"])), version

    def test_semantic_index_search_and_owner_isolation(self):
        with tempfile.TemporaryDirectory() as root:
            workspace, storage, service = self.make_services(root)
            _project, asset, version = self.create_asset(workspace, storage)

            indexed = service.index_version(OWNER, str(asset["id"]), str(version["id"]))
            results = service.semantic_search(OWNER, "雨夜城市蓝色海报")

            self.assertEqual(indexed["dimension"], 512)
            self.assertEqual(results[0]["asset_id"], asset["id"])
            self.assertGreaterEqual(results[0]["semantic_score"], 0.99)
            self.assertEqual(service.semantic_search(OTHER, "雨夜城市蓝色海报"), [])

    def test_quality_scoring_and_ranking(self):
        with tempfile.TemporaryDirectory() as root:
            workspace, storage, service = self.make_services(root)
            _project, asset, version = self.create_asset(workspace, storage)
            response = (
                '{"overall":92,"text":90,"anatomy":100,"face":100,"brand":88,'
                '"composition":94,"issues":["Logo略小"],"strengths":["主体清晰"],'
                '"recommendation":"放大品牌标识"}'
            )

            with patch("services.creative_intelligence_service.collect_text", return_value=response):
                quality = service.score_version(OWNER, str(asset["id"]), str(version["id"]))
            ranked = service.rank_assets(OWNER, [str(asset["id"])])

            self.assertEqual(quality["status"], "ready")
            self.assertEqual(quality["scores"]["overall"], 92)
            self.assertEqual(ranked[0]["overall"], 92)

    def test_derivatives_have_exact_dimensions_without_overwriting_source(self):
        with tempfile.TemporaryDirectory() as root:
            workspace, storage, service = self.make_services(root)
            _project, asset, version = self.create_asset(workspace, storage)

            items = service.generate_derivatives(
                OWNER,
                str(asset["id"]),
                version_id=str(version["id"]),
                presets=["xiaohongshu", "wechat"],
                mode="contain",
            )

            self.assertEqual(len(items), 2)
            sizes = {}
            for item in items:
                with Image.open(io.BytesIO(storage.items[str(item["image_path"])])) as output:
                    sizes[str(item["preset"])] = output.size
            self.assertEqual(sizes["xiaohongshu"], (1080, 1440))
            self.assertEqual(sizes["wechat"], (900, 383))
            self.assertTrue(storage.exists("2026/07/28/source.png"))

    def test_named_branch_updates_head_and_preserves_parent_tree(self):
        with tempfile.TemporaryDirectory() as root:
            workspace, storage, service = self.make_services(root)
            _project, asset, version = self.create_asset(workspace, storage)
            branch = service.create_branch(
                OWNER,
                str(asset["id"]),
                name="暖色方向",
                root_version_id=str(version["id"]),
            )
            child = workspace._insert_version(
                owner="owner-1",
                asset_id=str(asset["id"]),
                task_id="task-child",
                image_index=0,
                operation="edit",
                image_path="2026/07/28/source.png",
                image_url="/images/2026/07/28/source.png",
                prompt="改为暖色",
                params={},
                parent_version_id=str(version["id"]),
                make_current=True,
                branch_id=str(branch["id"]),
            )
            tree = service.version_tree(OWNER, str(asset["id"]))

            self.assertEqual(tree["branches"][0]["head_version_id"], child["id"])
            self.assertEqual(child["branch_id"], branch["id"])
            self.assertIn({"from": version["id"], "to": child["id"]}, tree["edges"])

    def test_board_draft_budget_idempotence_notifications_and_delivery(self):
        with tempfile.TemporaryDirectory() as root:
            workspace, storage, service = self.make_services(root)
            project, asset, version = self.create_asset(workspace, storage)
            board = service.create_board(OWNER, name="品牌灵感", project_id=str(project["id"]))
            text_item = service.add_board_item(
                OWNER,
                str(board["id"]),
                item_type="text",
                content="蓝色雨夜，电影感",
            )
            service.add_board_item(
                OWNER,
                str(board["id"]),
                item_type="reference",
                image_path="2026/07/28/source.png",
            )
            service.update_board_item(OWNER, str(board["id"]), str(text_item["id"]), {"x": 120, "y": 80})
            draft = service.board_creation_draft(OWNER, str(board["id"]))

            budget = service.set_budget(owner_id="owner-1", project_id=str(project["id"]), credit_limit=2)
            self.assertEqual(budget["remaining_credits"], 2)
            self.assertTrue(service.reserve_project_budget(OWNER, str(project["id"]), "task-1"))
            self.assertTrue(service.reserve_project_budget(OWNER, str(project["id"]), "task-1"))
            self.assertTrue(service.consume_project_budget(OWNER, "task-1", 1500))
            self.assertTrue(service.consume_project_budget(OWNER, "task-1", 1500))
            self.assertTrue(service.reserve_project_budget(OWNER, str(project["id"]), "task-2"))
            self.assertTrue(service.refund_project_budget(OWNER, "task-2"))
            final_budget = service.get_budget("owner-1", str(project["id"]))

            notification = service.create_notification(
                OWNER,
                event="task.success",
                title="完成",
                message="图片已生成",
                payload={"asset_id": asset["id"]},
            )
            self.assertEqual(len(service.list_notifications(OWNER)), 1)
            self.assertEqual(service.mark_notification_read(OWNER, str(notification["id"])), 1)
            first_batch_notice = service.notify_batch_completed(
                OWNER,
                "batch-1",
                {"total": 3, "success": 2, "error": 1},
            )
            duplicate_batch_notice = service.notify_batch_completed(
                OWNER,
                "batch-1",
                {"total": 3, "success": 2, "error": 1},
            )

            pptx_path = Path(root) / "quarterly-report.pptx"
            package_path = Path(root) / "quarterly-report.zip"
            pptx_path.write_bytes(b"pptx-test")
            package_path.write_bytes(b"zip-test")
            workspace.archive_asset(
                OWNER,
                name="季度汇报",
                asset_type="ppt",
                project_id=str(project["id"]),
                metadata={
                    "primary_url": "/files/ppt/task-1/quarterly-report.pptx",
                    "zip_url": "/files/ppt/task-1/quarterly-report.zip",
                },
            )

            service.generate_derivatives(
                OWNER,
                str(asset["id"]),
                version_id=str(version["id"]),
                presets=["ecommerce"],
            )
            editable_paths = {
                "ppt/task-1/quarterly-report.pptx": pptx_path,
                "ppt/task-1/quarterly-report.zip": package_path,
            }
            with patch(
                "services.editable_file_task_service.editable_file_task_service.owned_file_path",
                side_effect=lambda _identity, relative: editable_paths[relative],
            ):
                archive, filename = service.build_delivery_package(OWNER, project_id=str(project["id"]))
            with zipfile.ZipFile(archive) as package:
                names = package.namelist()

            self.assertIn("蓝色雨夜", draft["prompt"])
            self.assertEqual(draft["references"][0]["path"], "2026/07/28/source.png")
            self.assertEqual(final_budget["used_credits"], 1)
            self.assertEqual(final_budget["reserved_credits"], 0)
            self.assertEqual(final_budget["remaining_credits"], 1)
            self.assertEqual(first_batch_notice["event"], "batch.completed")
            self.assertTrue(duplicate_batch_notice["duplicate"])
            self.assertEqual(filename, f"xg-delivery-{str(project['id'])[:12]}.zip")
            self.assertIn("manifest.json", names)
            self.assertTrue(any("derivatives/ecommerce-1200x1200" in name for name in names))
            self.assertTrue(any(name.endswith("editable/quarterly-report.pptx") for name in names))
            self.assertTrue(any(name.endswith("editable/quarterly-report.zip") for name in names))

    def test_notification_redirects_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "不允许重定向"):
            _RejectRedirects().redirect_request(None, None, 302, "Found", {}, "https://example.test/next")

    def test_budget_rejects_cross_owner_project(self):
        with tempfile.TemporaryDirectory() as root:
            workspace, storage, service = self.make_services(root)
            project, _asset, _version = self.create_asset(workspace, storage)
            with self.assertRaisesRegex(ValueError, "project not found"):
                service.reserve_project_budget(OTHER, str(project["id"]), "foreign-task")


if __name__ == "__main__":
    unittest.main()
