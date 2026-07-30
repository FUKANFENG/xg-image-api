from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from services.advanced_creative_service import AdvancedCreativeService
from services.creative_workspace_service import CreativeWorkspaceService


OWNER = {"id": "owner-1", "name": "Owner", "role": "user", "group": "design"}
OTHER = {"id": "owner-2", "name": "Other", "role": "user", "group": "sales"}
ADMIN = {"id": "admin", "name": "Admin", "role": "admin", "group": "default"}


def image_bytes(color: tuple[int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(buffer, format="PNG")
    return buffer.getvalue()


class AdvancedCreativeServiceTests(unittest.TestCase):
    def make_services(self, root: str):
        path = Path(root) / "workspace.db"
        return CreativeWorkspaceService(path), AdvancedCreativeService(path)

    def test_builtin_recipes_default_to_web_image_model(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            _workspace, service = self.make_services(tmp_dir)

            builtin_recipes = [
                item for item in service.list_recipes(OWNER) if item["builtin"]
            ]

            self.assertTrue(builtin_recipes)
            self.assertEqual(
                {item["settings"]["model"] for item in builtin_recipes},
                {"gpt-image-2"},
            )

    def test_recipe_scope_and_profile_owner_isolation(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            _workspace, service = self.make_services(tmp_dir)
            private = service.create_recipe(
                OWNER,
                name="我的配方",
                category="custom",
                description="",
                settings={"size": "1024x1024"},
            )
            group = service.create_recipe(
                ADMIN,
                name="设计组配方",
                category="poster",
                description="",
                settings={"quality": "high"},
                scope_type="group",
                scope_id="design",
            )
            owner_ids = {item["id"] for item in service.list_recipes(OWNER)}
            other_ids = {item["id"] for item in service.list_recipes(OTHER)}
            self.assertIn(private["id"], owner_ids)
            self.assertIn(group["id"], owner_ids)
            self.assertNotIn(private["id"], other_ids)
            self.assertNotIn(group["id"], other_ids)
            with self.assertRaisesRegex(ValueError, "administrators"):
                service.create_recipe(
                    OWNER,
                    name="越权配方",
                    category="custom",
                    description="",
                    settings={},
                    scope_type="global",
                )

            profile = service.create_profile(
                OWNER,
                profile_type="brand",
                name="XG 品牌",
                instructions="保持紫色主色",
                colors=["#7c3aed"],
                reference_paths=["2026/reference.png"],
            )
            self.assertEqual(service.profile_prompt(OWNER, str(profile["id"]))["colors"], ["#7c3aed"])
            with self.assertRaisesRegex(ValueError, "not found"):
                service.profile_prompt(OTHER, str(profile["id"]))

    def test_project_asset_and_version_trash_restore_relationships(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            workspace, service = self.make_services(tmp_dir)
            project = workspace.create_project(OWNER, name="可恢复项目")
            asset = workspace.create_asset(OWNER, name="可恢复作品", project_id=str(project["id"]))
            workspace._insert_version(
                owner="owner-1",
                asset_id=str(asset["id"]),
                task_id="task-1",
                image_index=0,
                operation="generate",
                image_path="2026/test.png",
                image_url="/images/2026/test.png",
                prompt="人物海报",
                params={},
                parent_version_id="",
                make_current=True,
            )

            self.assertTrue(workspace.delete_project(OWNER, str(project["id"])))
            self.assertEqual(workspace.list_projects(OWNER), [])
            self.assertIsNone(workspace.get_asset(OWNER, str(asset["id"]))["project_id"])
            trash = service.list_trash(OWNER)[0]
            self.assertTrue(service.restore_trash(OWNER, str(trash["id"])))
            self.assertEqual(workspace.get_asset(OWNER, str(asset["id"]))["project_id"], project["id"])

            self.assertTrue(workspace.delete_asset(OWNER, str(asset["id"])))
            with self.assertRaisesRegex(ValueError, "asset not found"):
                workspace.get_asset(OWNER, str(asset["id"]))
            asset_trash = next(item for item in service.list_trash(OWNER) if item["entity_type"] == "asset")
            self.assertTrue(service.restore_trash(OWNER, str(asset_trash["id"])))
            self.assertEqual(len(workspace.get_asset(OWNER, str(asset["id"]))["versions"]), 1)

    def test_consistency_profiles_support_four_types_and_three_strengths(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            _workspace, service = self.make_services(tmp_dir)
            profiles = {}
            for profile_type in ("person", "product", "style"):
                profiles[profile_type] = service.create_profile(
                    OWNER,
                    profile_type=profile_type,
                    name=f"{profile_type}-reference",
                    default_strength="strict",
                    reference_paths=[f"2026/{profile_type}.png"],
                )
            profiles["brand"] = service.create_profile(
                OWNER,
                profile_type="brand",
                name="XG 品牌",
                default_strength="balanced",
                colors=["#7c3aed"],
            )

            self.assertEqual({item["profile_type"] for item in profiles.values()}, {"person", "product", "brand", "style"})
            self.assertEqual(profiles["person"]["default_strength"], "strict")
            strict = service.profile_prompt(OWNER, str(profiles["person"]["id"]))
            creative = service.profile_prompt(OWNER, str(profiles["person"]["id"]), strength="creative")
            self.assertEqual(strict["applied_strength"], "strict")
            self.assertIn("严格锁定", strict["prompt_suffix"])
            self.assertEqual(creative["applied_strength"], "creative")
            self.assertIn("允许更大变化", creative["prompt_suffix"])

            with self.assertRaisesRegex(ValueError, "至少上传一张参考图"):
                service.create_profile(OWNER, profile_type="style", name="无参考画风")
            with self.assertRaisesRegex(ValueError, "强度无效"):
                service.create_profile(
                    OWNER,
                    profile_type="person",
                    name="错误强度",
                    default_strength="maximum",
                    reference_paths=["2026/person.png"],
                )

    def test_share_review_audit_and_search_analysis(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            workspace, service = self.make_services(tmp_dir)
            asset = workspace.create_asset(OWNER, name="夜景人物海报")
            version = workspace._insert_version(
                owner="owner-1",
                asset_id=str(asset["id"]),
                task_id="task-search",
                image_index=0,
                operation="generate",
                image_path="2026/night.png",
                image_url="http://192.168.1.100:3000/images/2026/night.png",
                prompt="电影感夜景人物写真海报",
                params={},
                parent_version_id="",
                make_current=True,
            )
            with patch("services.advanced_creative_service.image_storage_service.get_bytes", return_value=image_bytes((30, 40, 80))):
                analysis = service.analyze_asset(OWNER, str(asset["id"]))
            self.assertIn("人物", analysis["tags"])
            self.assertIn("电影感", analysis["tags"])
            found = service.search_assets(OWNER, query="夜景", style="电影感")
            self.assertEqual([item["id"] for item in found], [asset["id"]])
            self.assertEqual(service.search_assets(OTHER, query="夜景"), [])

            share = service.create_share(OWNER, str(asset["id"]), str(version["id"]), 3)
            public = service.get_public_share(str(share["token"]))
            self.assertEqual(public["asset"]["name"], "夜景人物海报")
            self.assertEqual(public["version"]["image_url"], "/images/2026/night.png")
            self.assertNotIn("owner_id", public)
            self.assertTrue(service.revoke_share(OWNER, str(share["token"])))
            with self.assertRaisesRegex(ValueError, "not found"):
                service.get_public_share(str(share["token"]))

            review = service.submit_review(OWNER, str(asset["id"]), str(version["id"]))
            self.assertEqual(review["image_url"], "/images/2026/night.png")
            resolved = service.resolve_review(ADMIN, str(review["id"]), "approved", "可以交付")
            self.assertEqual(resolved["status"], "approved")
            self.assertEqual(resolved["comment"], "可以交付")
            self.assertTrue(any(item["action"] == "review.approved" for item in service.list_audits(ADMIN)))

    def test_duplicate_detection_persists_near_duplicate_relationships(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            workspace, service = self.make_services(tmp_dir)
            assets = []
            for index, path in enumerate(("first.png", "near.png", "different.png"), start=1):
                asset = workspace.create_asset(OWNER, name=f"作品 {index}", asset_type="image")
                workspace._insert_version(
                    owner="owner-1",
                    asset_id=str(asset["id"]),
                    task_id=f"task-{index}",
                    image_index=0,
                    operation="generate",
                    image_path=f"2026/07/27/{path}",
                    image_url=f"/images/2026/07/27/{path}",
                    prompt="测试",
                    params={},
                    parent_version_id="",
                    make_current=True,
                )
                assets.append(asset)

            with patch.object(
                service,
                "_image_features",
                side_effect=[
                    ("#111111", "0000000000000000"),
                    ("#111111", "0000000000000001"),
                    ("#eeeeee", "ffffffffffffffff"),
                ],
            ), patch(
                "services.advanced_creative_service.image_storage_service.get_bytes",
                return_value=b"image",
            ):
                result = service.detect_duplicate_assets(OWNER, threshold=8)

            self.assertEqual(result["summary"]["duplicates"], 1)
            self.assertEqual(result["pairs"][0]["distance"], 1)
            pair = result["pairs"][0]
            near = workspace.get_asset(OWNER, str(pair["asset_id"]))
            different_id = next(
                str(asset["id"])
                for asset in assets
                if asset["id"] not in {pair["asset_id"], pair["duplicate_of"]}
            )
            different = workspace.get_asset(OWNER, different_id)
            self.assertEqual(near["metadata"]["duplicate_of"], pair["duplicate_of"])
            self.assertEqual(near["metadata"]["duplicate_similarity"], 98.4)
            self.assertEqual(different["metadata"]["duplicate_of"], "")


if __name__ == "__main__":
    unittest.main()
