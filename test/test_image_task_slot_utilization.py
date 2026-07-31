from __future__ import annotations

import tempfile
import threading
import time
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from services.account_service import AccountService
from services.config import config
from services.image_task_service import ImageTaskService
from services.storage.json_storage import JSONStorageBackend


OWNER_A = {"id": "owner-a", "name": "Owner A", "role": "admin"}
OWNER_B = {"id": "owner-b", "name": "Owner B", "role": "admin"}


def wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not reached before timeout")


class BlockingHandler:
    def __init__(self) -> None:
        self.gate = threading.Event()
        self.lock = threading.Lock()
        self.started: Counter[str] = Counter()

    def __call__(self, payload):
        with self.lock:
            self.started[str(payload.get("prompt") or "unknown")] += 1
        self.gate.wait(3)
        return {"data": [{"url": "http://example.test/image.png"}]}

    def count(self) -> int:
        with self.lock:
            return sum(self.started.values())


class ImageTaskSlotUtilizationTests(unittest.TestCase):
    @staticmethod
    def submit(service: ImageTaskService, identity: dict[str, object], prefix: str, count: int) -> None:
        for index in range(count):
            service.submit_generation(
                identity,
                client_task_id=f"{prefix}-{index}",
                prompt=prefix,
                model="gpt-image-2",
                size=None,
            )

    @staticmethod
    def release_and_wait(handler: BlockingHandler, service: ImageTaskService, total: int) -> None:
        handler.gate.set()
        wait_until(lambda: service.metrics()["tasks"]["success"] == total)

    def test_account_capacity_snapshot_only_counts_ready_accounts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [
                    {"access_token": "ready-a", "status": "正常", "quota": 10},
                    {"access_token": "ready-b", "status": "正常", "quota": 10},
                    {"access_token": "disabled", "status": "禁用", "quota": 10},
                    {"access_token": "empty", "status": "正常", "quota": 0},
                ]
            )
            with patch.dict(config.data, {"image_account_concurrency": 3}):
                first = service._acquire_next_candidate_token()
                try:
                    snapshot = service.image_capacity_snapshot()
                finally:
                    service.release_image_slot(first)

            self.assertEqual(snapshot["healthy_accounts"], 2)
            # Fast recovery starts accounts without historical safe capacity at one
            # probe slot. They expand after consecutive successful generations.
            self.assertEqual(snapshot["total_slots"], 2)
            self.assertEqual(snapshot["used_slots"], 1)
            self.assertEqual(snapshot["available_slots"], 1)

    def test_single_owner_borrows_all_idle_account_slots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                edit_handler=handler,
                global_concurrency_getter=lambda: 8,
                user_concurrency_getter=lambda: 2,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 7,
            )
            self.submit(service, OWNER_A, "single", 7)
            try:
                wait_until(lambda: handler.count() == 7)
                queue = service.metrics()["queue"]
                self.assertEqual(queue["running"], 7)
                self.assertEqual(queue["queued"], 0)
                self.assertEqual(queue["effective_global_concurrency"], 7)
                self.assertEqual(queue["borrowed_user_slots"], 5)
                self.assertEqual(queue["slot_utilization_percent"], 100.0)
            finally:
                self.release_and_wait(handler, service, 7)

    def test_waiting_owner_gets_base_share_before_more_borrowing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingHandler()
            limits = {"global": 1}
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                edit_handler=handler,
                global_concurrency_getter=lambda: limits["global"],
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 4,
            )
            self.submit(service, OWNER_A, "owner-a", 3)
            self.submit(service, OWNER_B, "owner-b", 2)
            limits["global"] = 4
            with service._lock:
                service._dispatch_locked()
            try:
                wait_until(lambda: handler.count() == 4)
                with handler.lock:
                    started = dict(handler.started)
                self.assertEqual(started, {"owner-a": 2, "owner-b": 2})
                self.assertEqual(service._running_by_owner["owner-a"], 2)
                self.assertEqual(service._running_by_owner["owner-b"], 2)
            finally:
                self.release_and_wait(handler, service, 5)

    def test_zero_healthy_capacity_uses_one_probe_worker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                edit_handler=handler,
                global_concurrency_getter=lambda: 8,
                user_concurrency_getter=lambda: 2,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 0,
            )
            self.submit(service, OWNER_A, "probe", 3)
            try:
                wait_until(lambda: handler.count() == 1)
                queue = service.metrics()["queue"]
                self.assertEqual(queue["effective_global_concurrency"], 1)
                self.assertEqual(queue["account_slot_capacity"], 0)
                self.assertEqual(queue["running"], 1)
                self.assertEqual(queue["queued"], 2)
            finally:
                self.release_and_wait(handler, service, 3)

    def test_completed_remote_slot_is_reused_before_postprocessing_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler_started = threading.Event()
            postprocess_started = threading.Event()
            release_postprocess = threading.Event()
            handler_count = 0
            handler_lock = threading.Lock()

            def handler(_payload):
                nonlocal handler_count
                with handler_lock:
                    handler_count += 1
                    if handler_count >= 2:
                        handler_started.set()
                return {"data": [{"url": "http://example.test/image.png"}]}

            def record_success(_task):
                postprocess_started.set()
                release_postprocess.wait(2)
                return []

            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                edit_handler=handler,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 1,
            )
            with patch(
                "services.creative_workspace_service.creative_workspace_service.record_task_success",
                side_effect=record_success,
            ):
                try:
                    self.submit(service, OWNER_A, "handoff", 2)
                    self.assertTrue(postprocess_started.wait(2))
                    self.assertTrue(
                        handler_started.wait(1),
                        "the next remote task should start while local postprocessing is blocked",
                    )
                finally:
                    release_postprocess.set()
                    wait_until(lambda: not service._active_attempts)

    def test_blocked_postprocessing_has_a_separate_hard_concurrency_bound(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            postprocess_gate = threading.Event()
            handler_lock = threading.Lock()
            handler_count = 0

            def handler(_payload):
                nonlocal handler_count
                with handler_lock:
                    handler_count += 1
                return {"data": [{"url": "http://example.test/image.png"}]}

            def record_success(_task):
                postprocess_gate.wait(3)
                return []

            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                edit_handler=handler,
                global_concurrency_getter=lambda: 12,
                user_concurrency_getter=lambda: 12,
                queue_capacity_getter=lambda: 50,
                account_capacity_getter=lambda: 12,
            )
            with patch(
                "services.creative_workspace_service.creative_workspace_service.record_task_success",
                side_effect=record_success,
            ):
                try:
                    self.submit(service, OWNER_A, "bounded-postprocess", 30)
                    wait_until(
                        lambda: service.metrics()["performance"]["postprocess_active"] == 8
                    )
                    time.sleep(0.1)
                    with handler_lock:
                        started_while_blocked = handler_count
                    self.assertLessEqual(started_while_blocked, 20)
                    self.assertEqual(
                        service.metrics()["performance"]["postprocess_concurrency"],
                        8,
                    )
                finally:
                    postprocess_gate.set()
                    wait_until(
                        lambda: not service._active_attempts
                        and service.metrics()["performance"]["postprocess_active"] == 0,
                        timeout=5.0,
                    )

    def test_terminal_reader_cannot_double_settle_project_budget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            consume_started = threading.Event()
            release_consume = threading.Event()

            def consume(_identity, _task_id, _duration_ms=0):
                consume_started.set()
                release_consume.wait(2)
                return True

            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=lambda _payload: {
                    "data": [{"url": "http://example.test/image.png"}]
                },
                account_capacity_getter=lambda: 1,
            )
            with (
                patch.object(service, "_reserve_project_budget", return_value=True),
                patch.object(service, "_consume_project_budget", side_effect=consume) as consume_mock,
                patch(
                    "services.creative_workspace_service.creative_workspace_service.record_task_success",
                    return_value=[],
                ),
            ):
                service.submit_generation(
                    OWNER_A,
                    client_task_id="budget-race",
                    prompt="budget-race",
                    model="gpt-image-2",
                    size=None,
                    workflow={"project_id": "project-1"},
                )
                self.assertTrue(consume_started.wait(2))
                task = service.list_tasks(OWNER_A, ["budget-race"])["items"][0]
                self.assertEqual(task["status"], "success")
                release_consume.set()
                wait_until(
                    lambda: service._running_total == 0
                    and not service._active_attempts
                )

            self.assertEqual(consume_mock.call_count, 1)


if __name__ == "__main__":
    unittest.main()
