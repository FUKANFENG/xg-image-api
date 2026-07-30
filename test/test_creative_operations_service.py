from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from services.creative_operations_service import CreativeOperationsService


USER = {"id": "user-1", "role": "user", "name": "用户一", "group": "default"}
ADMIN = {"id": "admin", "role": "admin", "name": "管理员"}


class CreativeOperationsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.service = CreativeOperationsService(Path(self.temp_dir.name) / "operations.db")

    def test_template_render_cartesian_product_and_limit(self) -> None:
        result = self.service.render_template(
            "{{商品}}在{{场景}}",
            {"商品": ["香水", "手表"], "场景": ["展台", "沙滩"]},
        )

        self.assertEqual(result["total"], 4)
        self.assertEqual(result["items"][0], "香水在展台")
        with self.assertRaisesRegex(ValueError, "最多生成 50"):
            self.service.render_template(
                "{{a}} {{b}}",
                {"a": [str(value) for value in range(10)], "b": [str(value) for value in range(6)]},
            )

    def test_user_model_route_filters_codex_and_keeps_explicit_policy(self) -> None:
        result = self.service.route_model(
            USER,
            mode="edit",
            prompt="修改商品 Logo",
            reference_count=1,
            has_mask=True,
            available_models=["codex-gpt-image-2", "gpt-image-2"],
        )

        self.assertEqual(result["model"], "gpt-image-2")
        self.assertNotIn("codex-gpt-image-2", result["available_models"])
        self.assertEqual(result["policy"], "explicit_user_choice_wins")

    def test_schedule_claim_is_single_and_records_result_ids(self) -> None:
        run_at = datetime.now(UTC) + timedelta(minutes=10)
        item = self.service.create_schedule(
            USER,
            prompts=["第一张", "第二张"],
            model="gpt-image-2",
            size="1024x1024",
            quality="high",
            project_id="",
            run_at=run_at.isoformat(),
            low_peak_only=False,
            window_start=0,
            window_end=7,
        )
        calls: list[str] = []

        def dispatch(schedule):
            calls.append(str(schedule["id"]))
            return ["task-1", "task-2"]

        first = self.service.run_due(dispatch, now=run_at + timedelta(seconds=1))
        second = self.service.run_due(dispatch, now=run_at + timedelta(seconds=2))
        restored = self.service.get_schedule(USER, str(item["id"]))

        self.assertEqual(first["completed"], 1)
        self.assertEqual(second["claimed"], 0)
        self.assertEqual(calls, [item["id"]])
        self.assertEqual(restored["result_task_ids"], ["task-1", "task-2"])

    def test_review_extensions_validate_coordinates_and_persist_confirmation(self) -> None:
        review = {"id": "review-1", "owner_id": "user-1"}
        comment = self.service.add_review_comment(USER, review, "调整商品阴影")
        annotation = self.service.add_review_annotation(
            USER,
            review,
            label="商品",
            x=0.1,
            y=0.2,
            width=0.3,
            height=0.4,
            body="边缘更清晰",
        )
        confirmation = self.service.confirm_review(USER, review, "approved", "可以交付")

        self.assertEqual(comment["body"], "调整商品阴影")
        self.assertEqual(annotation["width"], 0.3)
        self.assertEqual(confirmation["decision"], "approved")
        self.assertEqual(len(self.service.list_review_comments(review)), 1)
        self.assertEqual(len(self.service.list_review_annotations(review)), 1)
        with self.assertRaisesRegex(ValueError, "图片范围"):
            self.service.add_review_annotation(
                USER,
                review,
                label="越界",
                x=0.9,
                y=0.1,
                width=0.2,
                height=0.2,
                body="",
            )

    def test_provenance_and_usability_cost_are_deterministic(self) -> None:
        task = {
            "id": "task-1",
            "owner_id": "user-1",
            "owner_name": "用户一",
            "model": "gpt-image-2",
            "prompt": "商品海报",
            "mode": "generate",
            "size": "1024x1024",
            "quality": "high",
            "created_at": "2026-07-28T00:00:00Z",
            "workflow": {"operation_type": "generate", "source_paths": ["refs/a.png"]},
        }
        self.service.record_task_provenance(task, [{"id": "version-1", "asset_id": "asset-1"}])
        rows = self.service.list_provenance(USER, "asset-1")
        metrics = self.service.usability_metrics(
            [
                {"quality": {"status": "ready", "scores": {"overall": 82}, "issues": ["文字"]}},
                {"quality": {"status": "ready", "scores": {"overall": 60}, "issues": ["文字"]}},
            ],
            consumed_credits=4,
        )

        self.assertEqual(rows[0]["model"], "gpt-image-2")
        self.assertEqual(len(rows[0]["prompt_sha256"]), 64)
        self.assertEqual(metrics["usable_rate"], 50.0)
        self.assertEqual(metrics["credits_per_usable"], 4.0)
        self.assertEqual(metrics["top_issues"][0]["count"], 2)

    def test_restore_verification_token_is_actor_scoped(self) -> None:
        run, token = self.service.create_restore_verification(
            "admin",
            "local/backup.tar.gz",
            {"file_count": 3},
        )

        restored = self.service.validate_restore_token("admin", str(run["id"]), token)
        self.assertEqual(restored["backup_key"], "local/backup.tar.gz")
        with self.assertRaisesRegex(ValueError, "无效"):
            self.service.validate_restore_token("admin", str(run["id"]), "wrong-token")


if __name__ == "__main__":
    unittest.main()
