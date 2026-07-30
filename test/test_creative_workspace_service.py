from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from services.creative_workspace_service import CreativeWorkspaceService


OWNER = {"id": "owner-1", "name": "Owner", "role": "user"}
OTHER = {"id": "owner-2", "name": "Other", "role": "user"}


class CreativeWorkspaceServiceTests(unittest.TestCase):
    def make_service(self, root: str) -> CreativeWorkspaceService:
        return CreativeWorkspaceService(Path(root) / "workspace.db")

    def test_asset_page_is_bounded_and_reports_total(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            for index in range(3):
                service.create_asset(OWNER, name=f"资产 {index}")

            page = service.list_assets_page(OWNER, limit=1, offset=1)

            self.assertEqual(len(page["items"]), 1)
            self.assertEqual(page["total"], 3)
            self.assertTrue(page["has_more"])
            self.assertEqual(page["next_offset"], 2)

    def test_project_crud_and_owner_isolation(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            project = service.create_project(OWNER, name="品牌海报", tags=["商业", "海报"])

            self.assertEqual(service.list_projects(OWNER)[0]["name"], "品牌海报")
            self.assertEqual(service.list_projects(OTHER), [])
            with self.assertRaisesRegex(ValueError, "project not found"):
                service.update_project(OTHER, str(project["id"]), {"favorite": True})

            updated = service.update_project(OWNER, str(project["id"]), {"favorite": True})
            self.assertTrue(updated["favorite"])
            self.assertTrue(service.delete_project(OWNER, str(project["id"])))
            self.assertEqual(service.list_projects(OWNER), [])

    def test_completed_tasks_create_version_chain_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            project = service.create_project(OWNER, name="版本链")
            first_task = {
                "id": "task-1",
                "owner_id": "owner-1",
                "owner_role": "user",
                "status": "success",
                "mode": "generate",
                "model": "gpt-image-2",
                "size": "1024x1024",
                "quality": "auto",
                "prompt": "一只猫",
                "data": [{"url": "http://local.test/images/2026/07/21/cat.png"}],
                "workflow": {"project_id": project["id"], "operation_type": "generate"},
            }

            created = service.record_task_success(first_task)
            repeated = service.record_task_success(first_task)

            self.assertEqual(len(created), 1)
            self.assertEqual(created[0]["id"], repeated[0]["id"])
            self.assertEqual(created[0]["image_url"], "/images/2026/07/21/cat.png")
            assets = service.list_assets(OWNER, project_id=str(project["id"]))
            self.assertEqual(len(assets), 1)
            self.assertEqual(assets[0]["current_image_url"], "/images/2026/07/21/cat.png")
            asset_id = str(assets[0]["id"])

            second_task = {
                **first_task,
                "id": "task-2",
                "mode": "edit",
                "prompt": "背景亮一点",
                "data": [{"url": "/images/2026/07/21/cat-v2.png"}],
                "workflow": {
                    "asset_id": asset_id,
                    "parent_version_id": created[0]["id"],
                    "operation_type": "edit",
                },
            }
            second = service.record_task_success(second_task)[0]
            asset = service.get_asset(OWNER, asset_id)

            self.assertEqual(len(asset["versions"]), 2)
            self.assertEqual(second["parent_version_id"], created[0]["id"])
            self.assertEqual(asset["current_version_id"], second["id"])

            rolled_back = service.set_current_version(OWNER, asset_id, str(created[0]["id"]))
            self.assertEqual(rolled_back["current_version_id"], created[0]["id"])
            self.assertEqual(len(rolled_back["versions"]), 2)

    def test_legacy_local_image_urls_are_origin_relative_but_remote_urls_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            local_asset = service.archive_asset(
                OWNER,
                name="历史本地图片",
                asset_type="image",
                image_path="2026/07/24/local.png",
                image_url="http://192.168.1.100:3000/images/2026/07/24/local.png",
            )
            local_version_id = str(local_asset["versions"][0]["id"])
            with service._connection() as connection:
                connection.execute(
                    "UPDATE creative_versions SET image_url = ? WHERE id = ?",
                    ("http://127.0.0.1:3000/images/2026/07/24/local.png", local_version_id),
                )

            listed_local = service.list_assets(OWNER)[0]
            loaded_local = service.get_asset(OWNER, str(local_asset["id"]))
            self.assertEqual(listed_local["current_image_url"], "/images/2026/07/24/local.png")
            self.assertEqual(loaded_local["versions"][0]["image_url"], "/images/2026/07/24/local.png")

            remote_asset = service.archive_asset(
                OWNER,
                name="外部图片",
                asset_type="image",
                image_url="https://cdn.example.com/art.png",
            )
            self.assertEqual(
                remote_asset["versions"][0]["image_url"],
                "https://cdn.example.com/art.png",
            )

    def test_restore_batch_records_original_and_result_and_zip_paths(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            batch = service.create_batch(
                OWNER,
                mode="restore",
                name="修复批次",
                settings={"mode": "portrait", "strength": "standard"},
            )
            service.add_batch_item(
                OWNER,
                str(batch["id"]),
                task_id="restore-1",
                source_name="source.png",
                source_path="2026/07/21/source.png",
            )
            task = {
                "id": "restore-1",
                "owner_id": "owner-1",
                "owner_role": "user",
                "status": "success",
                "mode": "edit",
                "prompt": "restore",
                "data": [{"url": "/images/2026/07/21/restored.png"}],
                "workflow": {
                    "batch_id": batch["id"],
                    "operation_type": "restore",
                    "source_path": "2026/07/21/source.png",
                    "source_name": "source.png",
                },
            }

            result = service.record_task_success(task)
            assets = service.list_assets(OWNER)
            asset = service.get_asset(OWNER, str(assets[0]["id"]))

            self.assertEqual([version["operation"] for version in asset["versions"]], ["original", "restore"])
            self.assertEqual(result[0]["image_path"], "2026/07/21/restored.png")
            self.assertEqual(service.batch_result_paths(OWNER, str(batch["id"])), ["2026/07/21/restored.png"])
            with self.assertRaisesRegex(ValueError, "batch not found"):
                service.batch_result_paths(OTHER, str(batch["id"]))

    def test_conversation_messages_persist_and_complete(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            asset = service.create_asset(OWNER, name="连续修改")
            conversation = service.create_conversation(OWNER, str(asset["id"]))
            message = service.add_conversation_instruction(
                OWNER,
                str(conversation["id"]),
                content="背景亮一点",
                task_id="conversation-task-1",
            )

            self.assertTrue(message["message_id"])
            service.complete_conversation_task(
                OWNER,
                str(conversation["id"]),
                "conversation-task-1",
                "version-1",
            )
            restored = service.get_conversation(OWNER, str(conversation["id"]))
            self.assertEqual([item["role"] for item in restored["messages"]], ["user", "assistant"])
            self.assertEqual(restored["messages"][0]["status"], "success")

    def test_group_and_user_policies_enforce_feature_rate_and_freeze(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            identity = {**OWNER, "group": "default"}
            service.update_policy(
                "group:default",
                subject_type="group",
                features={"batch": False},
                rate_limit_per_minute=2,
            )

            with self.assertRaisesRegex(ValueError, "关闭"):
                service.enforce_policy(identity, "batch")

            service.update_policy(
                "owner-1",
                subject_type="user",
                features={"batch": True},
                rate_limit_per_minute=2,
            )
            service.enforce_policy(identity, "batch")
            service.enforce_policy(identity, "batch")
            with self.assertRaisesRegex(ValueError, "每分钟 2 次"):
                service.enforce_policy(identity, "batch")

            service.update_policy(
                "owner-1",
                subject_type="user",
                features={"batch": True},
                frozen=True,
                abnormal_reason="异常请求过多",
            )
            with self.assertRaisesRegex(ValueError, "异常请求过多"):
                service.enforce_policy(identity, "image_generation")

    def test_image_references_and_bulk_archive_are_owner_scoped_and_atomic(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(tmp_dir)
            project = service.create_project(OWNER, name="批量项目")
            first = service.archive_asset(
                OWNER,
                name="图一",
                asset_type="image",
                image_path="2026/07/27/one.png",
                image_url="/images/2026/07/27/one.png",
            )
            second = service.archive_asset(
                OWNER,
                name="图二",
                asset_type="image",
                image_path="2026/07/27/two.png",
                image_url="/images/2026/07/27/two.png",
            )
            foreign = service.archive_asset(
                OTHER,
                name="他人图片",
                asset_type="image",
                image_path="2026/07/27/foreign.png",
                image_url="/images/2026/07/27/foreign.png",
            )

            references = service.list_image_references(OWNER)
            result = service.bulk_archive_assets(
                OWNER,
                [str(first["id"]), str(second["id"])],
                str(project["id"]),
            )

            self.assertEqual({item["asset_id"] for item in references}, {first["id"], second["id"]})
            self.assertEqual(result["updated"], 2)
            self.assertEqual(
                {item["project_id"] for item in service.list_assets(OWNER)},
                {project["id"]},
            )
            with self.assertRaisesRegex(ValueError, "无权操作"):
                service.bulk_archive_assets(
                    OWNER,
                    [str(first["id"]), str(foreign["id"])],
                    None,
                )
            self.assertEqual(service.get_asset(OWNER, str(first["id"]))["project_id"], project["id"])


if __name__ == "__main__":
    unittest.main()
