from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from services.auth_service import AuthService
from services.config import config
from services.image_task_service import ImageQueueFullError, ImageTaskService
from services.storage.json_storage import JSONStorageBackend


def wait_until(predicate) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("scheduler did not reach expected state")


class UserImagePolicyTests(unittest.TestCase):
    def test_four_slot_cap_applies_across_async_edits_and_sync_api_children(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(config.data, {"image_allow_user_borrowing": True}):
            auth = AuthService(JSONStorageBackend(Path(directory) / "accounts.json"))
            user = auth.create_user(username="four-slots", password="test-password", image_quota=0)
            auth.update_user(user["id"], {"image_quota_unlimited": True, "image_concurrency_limit": 4})
            identity = {"id": user["id"], "role": "user", "name": "Four slots"}
            gate, first_gate, lock = threading.Event(), threading.Event(), threading.Lock()
            started: list[str] = []
            active = peak = 0

            def handler(payload):
                nonlocal active, peak
                with lock:
                    started.append(payload["prompt"])
                    active += 1
                    peak = max(peak, active)
                try:
                    (first_gate if payload["prompt"] == "first" else gate).wait(10)
                    return {"data": [{"b64_json": "aW1hZ2U="}]}
                finally:
                    with lock:
                        active -= 1

            service = ImageTaskService(
                Path(directory) / "tasks.json", generation_handler=handler, edit_handler=handler,
                credit_manager=auth, global_concurrency_getter=lambda: 8,
                user_concurrency_getter=lambda: 2, queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 8,
            )
            self.assertEqual(service.estimate(identity)["effective_user_concurrency"], 4)
            result, errors = {}, []

            def run_api():
                try:
                    result.update(service.run_api_generation(identity, {"prompt": "sync", "model": "gpt-image-2", "n": 4}))
                except Exception as exc:
                    errors.append(exc)

            thread = threading.Thread(target=run_api)
            try:
                service.submit_generation(identity, client_task_id="first", prompt="first", model="gpt-image-2", size=None)
                service.submit_edit(identity, client_task_id="edit", prompt="edit", model="gpt-image-2",
                                    size=None, images=[(b"image", "reference.png", "image/png")])
                thread.start()
                wait_until(lambda: len(started) == 4 and service.metrics()["queue"]["queued"] == 2)
                self.assertEqual(service.metrics()["queue"]["running"], 4)
                # Completion immediately replenishes one slot without waiting for a batch.
                first_gate.set()
                wait_until(lambda: len(started) == 5)
                self.assertEqual(service.metrics()["queue"]["running"], 4)
                self.assertEqual(service.metrics()["queue"]["queued"], 1)
                self.assertEqual(peak, 4)
                # The account cap must not throttle unrelated owners.
                service.submit_generation({"id": "other", "role": "admin"}, client_task_id="other",
                                          prompt="other", model="gpt-image-2", size=None)
                wait_until(lambda: len(started) == 6)
                self.assertEqual(service.metrics()["queue"]["running"], 5)
            finally:
                first_gate.set()
                gate.set()
                if thread.ident is not None:
                    thread.join(10)
                wait_until(lambda: service.metrics()["queue"]["running"] == 0)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(len(result["data"]), 4)
            self.assertEqual(auth.list_users()[0]["image_quota"], 0)

    def test_queue_admission_counts_tasks_blocked_by_hard_cap(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(config.data, {"image_allow_user_borrowing": True}):
            auth = AuthService(JSONStorageBackend(Path(directory) / "accounts.json"))
            user = auth.create_user(username="queue-limit", password="test-password")
            auth.update_user(user["id"], {"image_quota_unlimited": True, "image_concurrency_limit": 1})
            identity = {"id": user["id"], "role": "user"}
            gate = threading.Event()

            def handler(payload):
                gate.wait(10)
                return {"data": [{"b64_json": "aW1hZ2U="}]}

            service = ImageTaskService(Path(directory) / "tasks.json", generation_handler=handler, credit_manager=auth,
                                       global_concurrency_getter=lambda: 8, user_concurrency_getter=lambda: 8,
                                       queue_capacity_getter=lambda: 1, account_capacity_getter=lambda: 8)
            try:
                for index in range(2):
                    service.submit_generation(identity, client_task_id=str(index), prompt="limited", model="gpt-image-2", size=None)
                with self.assertRaises(ImageQueueFullError):
                    service.submit_generation(identity, client_task_id="overflow", prompt="limited", model="gpt-image-2", size=None)
                self.assertEqual(service.metrics()["queue"]["running"], 1)
                self.assertEqual(service.metrics()["queue"]["queued"], 1)
            finally:
                gate.set()
                wait_until(lambda: service.metrics()["queue"]["running"] == 0)
