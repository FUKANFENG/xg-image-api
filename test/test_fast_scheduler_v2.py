from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import services.protocol.conversation as conversation
from services.account_service import AccountService
from services.config import ConfigStore, config
from services.image_task_service import ImageQueueFullError, ImageTaskService
from services.openai_backend_api import image_poll_interval_for_elapsed
from services.storage.json_storage import JSONStorageBackend


ADMIN_A = {"id": "admin-a", "name": "Admin A", "role": "admin"}
ADMIN_B = {"id": "admin-b", "name": "Admin B", "role": "admin"}
USER_A = {"id": "user-a", "name": "User A", "role": "user"}
USER_B = {"id": "user-b", "name": "User B", "role": "user"}


def wait_until(predicate, timeout: float = 3.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not reached before timeout")


class BlockingImageHandler:
    def __init__(self) -> None:
        self.gate = threading.Event()
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.started = 0

    def __call__(self, payload):
        with self.lock:
            self.active += 1
            self.started += 1
            self.max_active = max(self.max_active, self.active)
            index = self.started
        try:
            self.gate.wait(3.0)
            return {
                "created": 100 + index,
                "data": [{"b64_json": f"image-{index}"}],
                "usage": {
                    "input_tokens": 1,
                    "output_tokens": 2,
                    "total_tokens": 3,
                    "input_tokens_details": {
                        "text_tokens": 1,
                        "image_tokens": 2,
                    },
                },
            }
        finally:
            with self.lock:
                self.active -= 1

    def started_count(self) -> int:
        with self.lock:
            return self.started


class UnifiedApiSchedulerTests(unittest.TestCase):
    def test_api_n_children_share_the_global_queue_and_return_one_parent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingImageHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 2,
                user_concurrency_getter=lambda: 2,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 2,
            )
            result: dict[str, object] = {}
            errors: list[BaseException] = []

            def run() -> None:
                try:
                    result.update(service.run_api_generation(
                        ADMIN_A,
                        {
                            "prompt": "four independent images",
                            "model": "gpt-image-2",
                            "n": 4,
                            "size": "1024x1024",
                            "quality": "auto",
                            "response_format": "b64_json",
                            "stream": False,
                        },
                    ))
                except BaseException as exc:  # pragma: no cover - surfaced below
                    errors.append(exc)

            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                wait_until(lambda: handler.started_count() == 2)
                queue = service.metrics()["queue"]
                self.assertEqual(queue["running"], 2)
                self.assertEqual(queue["queued"], 2)
                self.assertEqual(handler.max_active, 2)
                page = service.list_admin_task_page(limit=20)
                self.assertEqual(page["summary"]["total"], 1)
                self.assertEqual(page["summary"]["api"], 1)
                self.assertEqual(page["items"][0]["request_n"], 4)
                self.assertEqual(page["items"][0]["child_total"], 4)
                self.assertEqual(page["items"][0]["status"], "running")
            finally:
                handler.gate.set()
                thread.join(5.0)

            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(len(result["data"]), 4)
            self.assertEqual(result["usage"]["total_tokens"], 12)
            self.assertEqual(
                result["usage"]["input_tokens_details"],
                {"text_tokens": 4, "image_tokens": 8},
            )
            page = service.list_admin_task_page(limit=20)
            self.assertEqual(page["items"][0]["status"], "success")
            self.assertEqual(page["items"][0]["result_count"], 4)
            metrics = service.metrics()
            self.assertEqual(metrics["queue"]["scheduler_mode"], "fast")
            self.assertGreaterEqual(metrics["performance"]["slot_handoff_samples"], 1)
            self.assertLess(metrics["performance"]["slot_handoff_p95_ms"], 100)

    def test_async_and_openai_compatible_calls_cannot_oversubscribe_each_other(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingImageHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 1,
            )
            service.submit_generation(
                ADMIN_A,
                client_task_id="queued-api-task",
                prompt="first async task",
                model="gpt-image-2",
                size=None,
            )
            wait_until(lambda: handler.started_count() == 1)

            result: dict[str, object] = {}
            thread = threading.Thread(
                target=lambda: result.update(service.run_api_generation(
                    ADMIN_B,
                    {
                        "prompt": "compatible api task",
                        "model": "gpt-image-2",
                        "n": 1,
                        "response_format": "b64_json",
                    },
                )),
                daemon=True,
            )
            thread.start()
            try:
                wait_until(lambda: service.metrics()["queue"]["queued"] == 1)
                self.assertEqual(handler.started_count(), 1)
                self.assertEqual(handler.max_active, 1)
            finally:
                handler.gate.set()
                thread.join(5.0)

            self.assertFalse(thread.is_alive())
            self.assertEqual(len(result["data"]), 1)
            self.assertEqual(handler.max_active, 1)

    def test_streaming_returns_queued_progress_then_each_child_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            counter = 0

            def generate(_payload):
                nonlocal counter
                counter += 1
                return {
                    "created": counter,
                    "data": [{"b64_json": f"image-{counter}"}],
                }

            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=generate,
                global_concurrency_getter=lambda: 2,
                user_concurrency_getter=lambda: 2,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 2,
            )

            chunks = list(service.run_api_generation(ADMIN_A, {
                "prompt": "two streaming images",
                "model": "gpt-image-2",
                "n": 2,
                "response_format": "b64_json",
                "stream": True,
            }))

            self.assertEqual(chunks[0]["object"], "image.generation.chunk")
            result_chunks = [
                chunk for chunk in chunks if chunk["object"] == "image.generation.result"
            ]
            self.assertEqual(len(result_chunks), 2)
            self.assertEqual({chunk["index"] for chunk in result_chunks}, {1, 2})

    def test_cancelling_parent_wakes_the_synchronous_api_waiter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingImageHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 1,
            )
            errors: list[BaseException] = []

            def run() -> None:
                try:
                    service.run_api_generation(ADMIN_A, {
                        "prompt": "cancel me",
                        "model": "gpt-image-2",
                        "n": 2,
                        "response_format": "b64_json",
                    })
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            wait_until(lambda: handler.started_count() == 1)
            parent = service.list_admin_task_page(limit=10)["items"][0]
            service.cancel_task(ADMIN_A, str(parent["id"]))
            thread.join(2.0)
            handler.gate.set()

            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], conversation.ImageGenerationError)
            self.assertEqual(
                service.get_task(ADMIN_A, str(parent["id"]))["error_code"],
                "cancelled_by_user",
            )

    def test_partial_child_failure_fails_exact_n_contract_and_tracks_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            call_count = 0

            def generate(_payload):
                nonlocal call_count
                call_count += 1
                if call_count == 2:
                    raise RuntimeError("second child failed")
                return {"created": 1, "data": [{"b64_json": "first-image"}]}

            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=generate,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 1,
            )

            with self.assertRaisesRegex(
                conversation.ImageGenerationError,
                "未完整完成",
            ) as caught:
                service.run_api_generation(ADMIN_A, {
                    "prompt": "one child may fail",
                    "model": "gpt-image-2",
                    "n": 2,
                    "response_format": "b64_json",
                })

            self.assertEqual(caught.exception.code, "partial_generation_failed")
            parent = service.list_admin_task_page(limit=10)["items"][0]
            self.assertEqual(parent["status"], "error")
            self.assertEqual(parent["completed_children"], 1)
            self.assertEqual(parent["failed_children"], 1)
            self.assertEqual(parent["result_count"], 1)
            self.assertEqual(parent["error_code"], "partial_generation_failed")

    def test_edit_children_use_real_scheduler_and_keep_image_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            captured_payloads: list[dict[str, object]] = []
            images = [(b"source", "source.png", "image/png")]
            masks = [(b"mask", "mask.png", "image/png")]

            def edit(payload):
                captured_payloads.append(payload)
                return {
                    "created": len(captured_payloads),
                    "data": [{"b64_json": f"edited-{len(captured_payloads)}"}],
                }

            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                edit_handler=edit,
                global_concurrency_getter=lambda: 2,
                user_concurrency_getter=lambda: 2,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 2,
            )

            result = service.run_api_edit({
                **ADMIN_A,
                "authorization": "Bearer must-not-be-persisted",
                "access_token": "account-token-must-not-be-persisted",
            }, {
                "prompt": "edit both independently",
                "model": "gpt-image-2",
                "n": 2,
                "response_format": "b64_json",
                "images": images,
                "mask": masks,
            })

            self.assertEqual(len(result["data"]), 2)
            self.assertEqual(len(captured_payloads), 2)
            self.assertTrue(all(payload["n"] == 1 for payload in captured_payloads))
            self.assertTrue(all(payload["images"] == images for payload in captured_payloads))
            self.assertTrue(all(payload["mask"] == masks for payload in captured_payloads))
            persisted = json.dumps(service.store.load_all(), ensure_ascii=False)
            self.assertNotIn("edited-1", persisted)
            self.assertNotIn("edited-2", persisted)
            self.assertNotIn("must-not-be-persisted", persisted)
            self.assertNotIn("source.png", persisted)
            self.assertNotIn("mask.png", persisted)

    def test_sync_wait_timeout_does_not_cancel_background_task(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingImageHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 1,
            )
            try:
                with patch.dict(config.data, {"image_v1_sync_wait_timeout_secs": 1}):
                    with self.assertRaisesRegex(
                        conversation.ImageGenerationError,
                        "同步等待超时",
                    ):
                        service.run_api_generation(ADMIN_A, {
                            "prompt": "continue after caller timeout",
                            "model": "gpt-image-2",
                            "n": 1,
                            "response_format": "b64_json",
                        })
            finally:
                handler.gate.set()

            wait_until(
                lambda: service.list_admin_task_page(limit=10)["items"][0]["status"]
                == "success"
            )

    def test_restart_marks_unfinished_api_parent_and_child_as_interrupted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "tasks.json"
            seed = ImageTaskService(path)
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            now_ts = time.time()
            seed.store.upsert_many([
                {
                    "id": "api-restart",
                    "owner_id": "admin-a",
                    "status": "running",
                    "mode": "generate",
                    "source": "api",
                    "child_task_ids": ["api-restart-1"],
                    "created_at": now,
                    "updated_at": now,
                    "created_ts": now_ts,
                    "updated_ts": now_ts,
                },
                {
                    "id": "api-restart-1",
                    "owner_id": "admin-a",
                    "status": "queued",
                    "mode": "generate",
                    "source": "api_child",
                    "parent_task_id": "api-restart",
                    "created_at": now,
                    "updated_at": now,
                    "created_ts": now_ts,
                    "updated_ts": now_ts,
                },
            ])

            restarted = ImageTaskService(path)

            self.assertEqual(
                restarted.get_task(ADMIN_A, "api-restart")["error_code"],
                "service_restarted",
            )
            self.assertEqual(
                restarted.get_task(ADMIN_A, "api-restart-1")["error_code"],
                "service_restarted",
            )

    def test_parent_and_children_remain_isolated_between_non_admin_identities(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=lambda _payload: {
                    "created": 1,
                    "data": [{"b64_json": "private-result"}],
                },
                global_concurrency_getter=lambda: 2,
                user_concurrency_getter=lambda: 2,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 2,
            )

            service.run_api_generation(USER_A, {
                "prompt": "private request",
                "model": "gpt-image-2",
                "n": 2,
                "response_format": "b64_json",
            })
            owner_items = service.list_tasks(USER_A, [])["items"]
            self.assertEqual(len(owner_items), 1)
            parent_id = owner_items[0]["id"]
            self.assertEqual(service.list_tasks(USER_B, [])["items"], [])
            with self.assertRaisesRegex(ValueError, "task not found"):
                service.get_task(USER_B, parent_id)
            for child_id in (f"{parent_id}-1", f"{parent_id}-2"):
                with self.assertRaisesRegex(ValueError, "task not found"):
                    service.get_task(USER_B, child_id)

    def test_queue_bound_holds_when_user_borrowing_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingImageHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 4,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 1,
                account_capacity_getter=lambda: 4,
            )
            with patch.dict(config.data, {"allow_user_borrowing": False}):
                service.submit_generation(
                    ADMIN_A,
                    client_task_id="owner-slot",
                    prompt="occupy owner share",
                    model="gpt-image-2",
                    size=None,
                )
                wait_until(lambda: handler.started_count() == 1)
                try:
                    with self.assertRaises(ImageQueueFullError):
                        service.run_api_generation(ADMIN_A, {
                            "prompt": "would overflow owner queue",
                            "model": "gpt-image-2",
                            "n": 2,
                            "response_format": "b64_json",
                        })
                finally:
                    handler.gate.set()
                    wait_until(
                        lambda: service.get_task(
                            ADMIN_A,
                            service.list_tasks(ADMIN_A, [])["items"][0]["id"],
                        )["status"] in {"success", "error"},
                    )


class AsyncApiSchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_wait_keeps_the_event_loop_responsive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            handler = BlockingImageHandler()
            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=handler,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 1,
            )
            request = asyncio.create_task(service.run_api_generation_async(
                ADMIN_A,
                {
                    "prompt": "event loop must remain responsive",
                    "model": "gpt-image-2",
                    "n": 1,
                    "response_format": "b64_json",
                },
            ))
            try:
                deadline = time.monotonic() + 2.0
                while handler.started_count() < 1 and time.monotonic() < deadline:
                    await asyncio.sleep(0.01)
                self.assertEqual(handler.started_count(), 1)
                self.assertFalse(request.done())
                await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.1)
                self.assertFalse(request.done())
            finally:
                handler.gate.set()

            result = await asyncio.wait_for(request, timeout=3.0)
            self.assertEqual(len(result["data"]), 1)
            deadline = time.monotonic() + 2.0
            while service._active_attempts and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            self.assertEqual(service._active_attempts, {})

    async def test_async_stream_preserves_one_based_child_indexes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            counter = 0

            def generate(_payload):
                nonlocal counter
                counter += 1
                return {
                    "created": counter,
                    "data": [{"b64_json": f"async-image-{counter}"}],
                }

            service = ImageTaskService(
                Path(tmp_dir) / "tasks.json",
                generation_handler=generate,
                global_concurrency_getter=lambda: 2,
                user_concurrency_getter=lambda: 2,
                queue_capacity_getter=lambda: 20,
                account_capacity_getter=lambda: 2,
            )
            stream = await service.run_api_generation_async(
                ADMIN_A,
                {
                    "prompt": "two async streaming images",
                    "model": "gpt-image-2",
                    "n": 2,
                    "response_format": "b64_json",
                    "stream": True,
                },
            )
            chunks = [chunk async for chunk in stream]
            result_chunks = [
                chunk
                for chunk in chunks
                if chunk["object"] == "image.generation.result"
            ]
            self.assertEqual({chunk["index"] for chunk in result_chunks}, {1, 2})
            deadline = time.monotonic() + 2.0
            while service._active_attempts and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            self.assertEqual(service._active_attempts, {})


class SchedulerPolicyTests(unittest.TestCase):
    @staticmethod
    def account_service(tmp_dir: str, accounts: list[dict[str, object]]) -> AccountService:
        service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
        service.add_account_items(accounts)
        return service

    def test_predicted_finish_can_choose_a_loaded_but_faster_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.account_service(tmp_dir, [
                {
                    "access_token": "slow-idle",
                    "status": "正常",
                    "quota": 100,
                    "image_latency_ema_ms": 90_000,
                    "image_latency_samples": 20,
                    "image_dynamic_concurrency": 1,
                    "success": 100,
                    "fail": 0,
                },
                {
                    "access_token": "fast-loaded",
                    "status": "正常",
                    "quota": 100,
                    "image_latency_ema_ms": 35_000,
                    "image_latency_samples": 20,
                    "image_dynamic_concurrency": 3,
                    "success": 100,
                    "fail": 0,
                },
            ])
            service._image_inflight["fast-loaded"] = 1

            with patch.dict(config.data, {"image_account_concurrency": 3, "account_fast_recovery": True}):
                selected = service._select_image_candidate_token(["slow-idle", "fast-loaded"])

            self.assertEqual(selected, "fast-loaded")

    def test_fast_recovery_uses_probes_and_classifies_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.account_service(tmp_dir, [{
                "access_token": "web-token",
                "source_type": "web",
                "status": "正常",
                "quota": 100,
                "image_latency_ema_ms": 30_000,
                "image_latency_samples": 20,
                "image_dynamic_concurrency": 1,
                "success": 100,
                "fail": 0,
            }])
            settings = {
                "image_account_concurrency": 3,
                "account_fast_recovery": True,
                "account_probe_successes": 3,
                "account_soft_recovery_seconds": 0,
                "account_hard_rate_limit_cooldown_seconds": 300,
                "image_circuit_failure_threshold": 2,
            }
            with patch.dict(config.data, settings):
                service.mark_image_result("web-token", True, elapsed_ms=30_000)
                self.assertEqual(service._adaptive_image_concurrency("web-token"), 1)
                service.mark_image_result("web-token", True, elapsed_ms=30_000)
                service.mark_image_result("web-token", True, elapsed_ms=30_000)
                self.assertEqual(service._adaptive_image_concurrency("web-token"), 2)

                service.update_account("web-token", {
                    "image_dynamic_concurrency": 3,
                    "image_success_streak": 0,
                })
                service.mark_image_result("web-token", False, error_kind="server_error")
                self.assertEqual(service._adaptive_image_concurrency("web-token"), 3)
                service.mark_image_result("web-token", False, error_kind="network timeout")
                degraded = service.get_account("web-token")
                self.assertEqual(service._adaptive_image_concurrency("web-token"), 2)
                self.assertNotEqual(degraded["image_circuit_state"], "open")

                # Production adapters use snake_case error codes. They must be
                # classified the same way as human-readable upstream messages.
                service.mark_image_result(
                    "web-token",
                    False,
                    error_kind="rate_limit_exceeded",
                )
                limited = service.get_account("web-token")
                self.assertEqual(limited["image_circuit_state"], "open")
                self.assertEqual(service._adaptive_image_concurrency("web-token"), 0)
                self.assertGreater(
                    service._image_candidate_score_components("web-token")[
                        "rate_limit_penalty_ms"
                    ],
                    0,
                )

    def test_restart_begins_one_step_below_historical_safe_concurrency(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "accounts.json"
            original = AccountService(JSONStorageBackend(path))
            original.add_account_items([{
                "access_token": "historically-stable",
                "status": "正常",
                "quota": 100,
                "image_dynamic_concurrency": 3,
                "image_stable_concurrency": 3,
            }])

            with patch.dict(config.data, {
                "image_account_concurrency": 3,
                "account_fast_recovery": True,
            }):
                restarted = AccountService(JSONStorageBackend(path))

            self.assertEqual(restarted._adaptive_image_concurrency("historically-stable"), 2)

    def test_adaptive_polling_uses_normal_near_and_late_intervals(self) -> None:
        settings = {
            "poll_normal_interval_seconds": 4,
            "poll_near_completion_seconds": 2,
            "poll_late_interval_seconds": 5,
        }
        with patch.dict(config.data, settings):
            self.assertEqual(image_poll_interval_for_elapsed(5, expected_secs=45), 4)
            self.assertEqual(image_poll_interval_for_elapsed(35, expected_secs=45), 2)
            self.assertEqual(image_poll_interval_for_elapsed(90, expected_secs=45), 5)

    def test_legacy_scheduler_settings_stay_in_sync_with_fast_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            path.write_text('{"auth-key":"test-key-value"}', encoding="utf-8")
            settings = ConfigStore(path)

            updated = settings.update({
                "image_global_concurrency": 7,
                "image_poll_interval_secs": 3,
            })

            self.assertEqual(updated["global_max_remote_tasks"], 7)
            self.assertEqual(updated["poll_normal_interval_seconds"], 3)

    def test_real_transport_failures_map_to_recovery_categories(self) -> None:
        self.assertEqual(
            conversation.image_attempt_error_kind(
                conversation.UpstreamHTTPError("image", 429, {"error": "busy"})
            ),
            "rate_limit_exceeded",
        )
        self.assertEqual(
            conversation.image_attempt_error_kind(
                conversation.UpstreamHTTPError("image", 503, {"error": "down"})
            ),
            "server_error",
        )
        self.assertEqual(
            conversation.image_attempt_error_kind(TimeoutError("read timed out")),
            "network_timeout",
        )


class GenerationDeadlineStartTests(unittest.TestCase):
    def test_generation_budget_starts_after_account_slot_acquisition(self) -> None:
        acquisition_remaining: list[float] = []
        submission_remaining: list[float] = []
        generation_remaining: list[float] = []

        class DelayedAccountService:
            @staticmethod
            def get_available_access_token(**kwargs):
                deadline = kwargs.get("deadline_monotonic")
                acquisition_remaining.append(float(deadline) - time.monotonic())
                time.sleep(0.05)
                return "account-token"

            @staticmethod
            def get_account(_token):
                return {"status": "正常", "quota": 9}

            @staticmethod
            def image_account_reference(_token):
                return "acct_fixture"

            @staticmethod
            def mark_image_result(*_args, **_kwargs):
                return None

        class FakeBackend:
            def __init__(self, access_token: str) -> None:
                self.access_token = access_token

            def close(self) -> None:
                pass

        def successful_image(_backend, request, index, total):
            submission_remaining.append(float(request.deadline_monotonic) - time.monotonic())
            request.progress_callback("upstream_accepted")
            accepted_deadline = request.deadline_monotonic
            request.progress_callback("image_stream_resolve_start")
            self.assertEqual(request.deadline_monotonic, accepted_deadline)
            generation_remaining.append(float(request.deadline_monotonic) - time.monotonic())
            yield conversation.ImageOutput(
                kind="result",
                model=request.model,
                index=index,
                total=total,
                data=[{"url": "http://example.test/image.png"}],
            )

        with (
            patch.object(conversation, "account_service", DelayedAccountService()),
            patch.object(conversation, "OpenAIBackendAPI", FakeBackend),
            patch.object(conversation, "stream_image_outputs", successful_image),
            patch.dict(config.data, {
                "image_submit_timeout_secs": 1,
                "generation_timeout_seconds": 30,
                "image_poll_timeout_secs": 30,
            }),
        ):
            outputs = list(conversation.stream_image_outputs_with_pool(
                conversation.ConversationRequest(model="gpt-image-2", prompt="deadline test")
            ))

        self.assertEqual(outputs[-1].kind, "result")
        self.assertLessEqual(acquisition_remaining[0], 1.0)
        self.assertLessEqual(submission_remaining[0], 1.0)
        self.assertGreater(generation_remaining[0], 29.5)


if __name__ == "__main__":
    unittest.main()
