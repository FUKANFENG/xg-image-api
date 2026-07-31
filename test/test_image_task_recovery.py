from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from services.image_task_service import ImageTaskService
from services.image_task_store import ImageTaskStore


class FakeCreditManager:
    def __init__(self) -> None:
        self.consumed: list[str] = []
        self.refunded: list[str] = []

    def reserve_image_credit(self, _identity, _task_id):
        return True

    def consume_image_credit(self, _identity, task_id):
        self.consumed.append(task_id)
        return True

    def refund_image_credit(self, _identity, task_id):
        self.refunded.append(task_id)
        return True


def persisted_task(task_id: str, status: str) -> dict[str, object]:
    return {
        "id": task_id,
        "owner_id": "owner-1",
        "owner_role": "user",
        "owner_name": "Owner",
        "owner_group": "default",
        "credit_reserved": True,
        "project_budget_reserved": False,
        "status": status,
        "mode": "generate",
        "model": "gpt-image-2",
        "size": "1024x1024",
        "quality": "high",
        "prompt": "恢复任务",
        "retry_prompt": "恢复任务",
        "created_at": "2026-07-28 00:00:00",
        "updated_at": "2026-07-28 00:00:01",
        "created_ts": time.time() - 10,
        "updated_ts": time.time() - 9,
        "priority": 0,
        "last_checkpoint": "queued" if status == "queued" else "upstream_running",
        "timeline": [],
    }


class ImageTaskRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.path = Path(self.temp_dir.name) / "image_tasks.json"
        self.store = ImageTaskStore(self.path.with_suffix(".db"), legacy_json_path=self.path)

    def test_queued_task_is_rebuilt_after_restart_without_new_reservation(self) -> None:
        self.store.upsert(persisted_task("queued-1", "queued"))
        credits = FakeCreditManager()

        def generation(payload):
            payload["progress_callback"]("getting_account")
            payload["progress_callback"]("starting_generation")
            payload["progress_callback"]("receiving_image")
            return {"data": [{"url": "/images/recovered.png"}]}

        service = ImageTaskService(
            self.path,
            generation_handler=generation,
            credit_manager=credits,
            global_concurrency_getter=lambda: 1,
            user_concurrency_getter=lambda: 1,
            queue_capacity_getter=lambda: 10,
        )
        identity = {"id": "owner-1", "role": "user"}
        deadline = time.time() + 3
        task = service.get_task(identity, "queued-1")
        while task["status"] not in {"success", "error"} and time.time() < deadline:
            time.sleep(0.02)
            task = service.get_task(identity, "queued-1")
        while service._active_attempts and time.time() < deadline:
            time.sleep(0.02)

        self.assertEqual(task["status"], "success")
        self.assertEqual(service._active_attempts, {})
        self.assertEqual(credits.consumed, ["queued-1"])
        self.assertEqual(credits.refunded, [])
        stages = [item["stage"] for item in task["timeline"]]
        self.assertIn("recovery_queued", stages)
        self.assertIn("account_selection", stages)
        self.assertIn("completed", stages)

    def test_running_task_without_checkpoint_is_failed_and_refunded(self) -> None:
        self.store.upsert(persisted_task("running-1", "running"))
        credits = FakeCreditManager()

        service = ImageTaskService(
            self.path,
            generation_handler=lambda _payload: {"data": []},
            credit_manager=credits,
            global_concurrency_getter=lambda: 1,
            user_concurrency_getter=lambda: 1,
            queue_capacity_getter=lambda: 10,
        )
        task = service.get_task({"id": "owner-1", "role": "user"}, "running-1")

        self.assertEqual(task["status"], "error")
        self.assertEqual(task["error_code"], "service_restarted")
        self.assertEqual(credits.refunded, ["running-1"])
        self.assertTrue(task["retryable"])


if __name__ == "__main__":
    unittest.main()
