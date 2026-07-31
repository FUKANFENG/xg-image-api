from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from services.account_service import AccountService
from services.config import config
from services.image_task_service import ImageQueueFullError, ImageTaskService
from services.image_task_store import ImageTaskStore
from services.storage.json_storage import JSONStorageBackend


def _wait_status(service: ImageTaskService, identity: dict[str, object], task_id: str, status: str) -> dict:
    deadline = time.time() + 2.0
    while time.time() < deadline:
        items = service.list_tasks(identity, [task_id])["items"]
        if items and items[0]["status"] == status:
            return items[0]
        time.sleep(0.01)
    raise AssertionError(f"task {task_id} did not reach {status}")


class ImageQueueAndStoreTests(unittest.TestCase):
    def test_queue_is_bounded_and_reports_position_and_eta(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            release = threading.Event()

            def handler(payload):
                if payload["prompt"] == "first":
                    release.wait(1.0)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 1,
            )
            owner = {"id": "owner-1", "role": "admin"}
            service.submit_generation(owner, client_task_id="first", prompt="first", model="gpt-image-2", size=None)
            queued = service.submit_generation(owner, client_task_id="second", prompt="second", model="gpt-image-2", size=None)

            self.assertEqual(queued["status"], "queued")
            self.assertEqual(queued["queue_position"], 1)
            self.assertGreaterEqual(queued["estimated_wait_secs"], 1)
            with self.assertRaises(ImageQueueFullError):
                service.submit_generation(owner, client_task_id="third", prompt="third", model="gpt-image-2", size=None)
            release.set()
            _wait_status(service, owner, "second", "success")

    def test_round_robin_dispatch_prevents_one_owner_from_hogging(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            first_release = threading.Event()
            started: list[str] = []
            started_lock = threading.Lock()

            def handler(payload):
                with started_lock:
                    started.append(payload["prompt"])
                if payload["prompt"] == "a-1":
                    first_release.wait(1.0)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 10,
            )
            owner_a = {"id": "owner-a", "role": "admin"}
            owner_b = {"id": "owner-b", "role": "admin"}
            service.submit_generation(owner_a, client_task_id="a-1", prompt="a-1", model="gpt-image-2", size=None)
            service.submit_generation(owner_a, client_task_id="a-2", prompt="a-2", model="gpt-image-2", size=None)
            service.submit_generation(owner_b, client_task_id="b-1", prompt="b-1", model="gpt-image-2", size=None)
            first_release.set()
            _wait_status(service, owner_a, "a-2", "success")
            _wait_status(service, owner_b, "b-1", "success")

            self.assertEqual(started, ["a-1", "b-1", "a-2"])

    def test_json_history_migrates_once_to_wal_without_rewriting_legacy_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            legacy_path = Path(tmp_dir) / "image_tasks.json"
            legacy_payload = {"tasks": [{
                "id": "legacy-1",
                "owner_id": "owner-1",
                "status": "success",
                "mode": "generate",
                "created_at": "2026-07-18 00:00:00",
                "updated_at": "2026-07-18 00:00:01",
            }]}
            original = json.dumps(legacy_payload, ensure_ascii=False)
            legacy_path.write_text(original, encoding="utf-8")

            store = ImageTaskStore(Path(tmp_dir) / "image_tasks.db", legacy_json_path=legacy_path)

            self.assertEqual([task["id"] for task in store.load_all()], ["legacy-1"])
            self.assertEqual(store.health()["journal_mode"], "wal")
            self.assertEqual(legacy_path.read_text(encoding="utf-8"), original)
            self.assertGreater(len(store.snapshot_bytes()), 0)

    def test_only_hard_rate_limit_opens_circuit_then_real_request_runs_half_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([{
                "access_token": "web-token",
                "source_type": "web",
                "status": "正常",
                "quota": 10,
            }])
            with patch.dict(config.data, {
                "image_circuit_failure_threshold": 2,
                "image_circuit_cooldown_secs": 30,
                "image_account_concurrency": 3,
            }):
                service.mark_image_result("web-token", False, error_kind="timeout")
                degraded = service.mark_image_result("web-token", False, error_kind="timeout")
                self.assertEqual(degraded["image_circuit_state"], "degraded")
                self.assertEqual(service._adaptive_image_concurrency("web-token"), 1)

                opened = service.mark_image_result("web-token", False, error_kind="429 rate limit")
                self.assertEqual(opened["image_circuit_state"], "open")
                self.assertEqual(service._adaptive_image_concurrency("web-token"), 0)

                service.update_account("web-token", {"image_circuit_open_until": time.time() - 1})
                token = service._acquire_next_candidate_token(source_type="web")
                self.assertEqual(token, "web-token")
                self.assertEqual(service.get_account(token)["image_circuit_state"], "half_open")
                self.assertEqual(service._adaptive_image_concurrency(token), 1)
                closed = service.mark_image_result(token, True, elapsed_ms=20_000)
                self.assertEqual(closed["image_circuit_state"], "closed")


if __name__ == "__main__":
    unittest.main()
