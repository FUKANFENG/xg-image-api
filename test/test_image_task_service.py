from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import services.image_task_service as image_task_module
from services.account_service import account_service
from services.image_task_service import ImageTaskService
from services.openai_backend_api import ImageTaskCancelledError, OpenAIBackendAPI
from services.protocol.conversation import ImageGenerationError


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER_OWNER = {"id": "owner-2", "name": "Other", "role": "user"}


def wait_for_task(service: ImageTaskService, identity: dict[str, object], task_id: str, status: str, timeout: float = 2.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        result = service.list_tasks(identity, [task_id])
        last = (result.get("items") or [None])[0]
        if last and last.get("status") == status:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {status}, last={last}")


class ImageTaskServiceTests(unittest.TestCase):
    def make_service(self, path: Path, handler=None) -> ImageTaskService:
        return ImageTaskService(
            path,
            generation_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/image.png"}]}),
            edit_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/edit.png"}]}),
            retention_days_getter=lambda: 30,
        )

    def test_task_feed_is_bounded_and_reports_pagination(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": f"task-{index}",
                                "owner_id": OWNER["id"],
                                "owner_role": OWNER["role"],
                                "status": "success",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "prompt": "pagination",
                                "created_at": f"2026-07-24 10:00:0{index}",
                                "updated_at": f"2026-07-24 10:00:0{index}",
                            }
                            for index in range(3)
                        ]
                    }
                ),
                encoding="utf-8",
            )
            service = self.make_service(path)

            page = service.list_tasks(OWNER, [], limit=1, offset=1)

            self.assertEqual([item["id"] for item in page["items"]], ["task-1"])
            self.assertEqual(page["total"], 3)
            self.assertTrue(page["has_more"])
            self.assertEqual(page["next_offset"], 2)

    def test_standard_api_call_is_persisted_with_safe_image_metadata(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path)
            started = service.begin_api_call(
                OWNER,
                mode="generate",
                endpoint="/v1/images/generations",
                prompt="cinematic cat",
                model="gpt-image-2",
                size="1024x1536",
                quality="high",
                request_n=1,
                response_format="b64_json",
            )

            with patch.object(
                image_task_module.image_storage_service,
                "inspect_paths",
                return_value=[
                    {
                        "path": "2026/07/30/result.png",
                        "size_bytes": 123456,
                        "width": 1024,
                        "height": 1536,
                        "storage": "local",
                    }
                ],
            ):
                completed = service.complete_api_call(
                    OWNER,
                    started["id"],
                    {
                        "data": [
                            {
                                "b64_json": "large-payload-must-not-be-persisted",
                                "url": "http://127.0.0.1:18080/images/2026/07/30/result.png",
                                "revised_prompt": "cinematic orange cat",
                            }
                        ],
                        "usage": {"total_tokens": 42},
                    },
                )

            self.assertEqual(completed["status"], "success")
            self.assertEqual(completed["source"], "api")
            self.assertEqual(completed["endpoint"], "/v1/images/generations")
            self.assertEqual(completed["caller_key_name"], "Owner")
            self.assertEqual(completed["data"][0]["url"], "/images/2026/07/30/result.png")
            self.assertEqual(completed["data"][0]["width"], 1024)
            self.assertEqual(completed["data"][0]["height"], 1536)
            self.assertEqual(completed["data"][0]["size_bytes"], 123456)
            self.assertNotIn("b64_json", completed["data"][0])

            page = service.list_admin_task_page(
                status="success",
                source="api",
                mode="generate",
                query="cinematic",
            )
            self.assertEqual(page["pagination"]["total"], 1)
            self.assertEqual(page["summary"]["api"], 1)
            self.assertEqual(page["items"][0]["id"], started["id"])

            reloaded = self.make_service(path)
            persisted = reloaded.list_admin_task_page(source="api")["items"][0]
            self.assertEqual(persisted["caller_key_name"], "Owner")
            self.assertEqual(persisted["data"][0]["size_bytes"], 123456)

    def test_base64_api_success_is_counted_without_persisting_payload(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            started = service.begin_api_call(
                OWNER,
                mode="generate",
                endpoint="/v1/images/generations",
                prompt="cinematic cat",
                model="gpt-image-2",
                size="1024x1024",
                quality="auto",
                request_n=1,
                response_format="b64_json",
            )

            completed = service.complete_api_call(
                OWNER,
                started["id"],
                {"data": [{"b64_json": "large-payload-must-not-be-persisted"}]},
            )

            self.assertEqual(completed["status"], "success")
            self.assertEqual(completed["result_count"], 1)
            self.assertEqual(completed["data"], [])
            persisted_payload = service.store.load_all()[0]
            self.assertNotIn(
                "large-payload-must-not-be-persisted",
                str(persisted_payload),
            )

    def test_overview_backfills_metadata_for_legacy_local_results(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            started = service.begin_api_call(
                OWNER,
                mode="generate",
                endpoint="/v1/images/generations",
                prompt="legacy result",
                model="gpt-image-2",
                size="1024x1024",
                quality="auto",
                request_n=1,
                response_format="url",
            )
            key = f"{OWNER['id']}:{started['id']}"
            service._tasks[key]["status"] = "success"
            service._tasks[key]["data"] = [
                {"url": "/images/2026/07/29/legacy.png"}
            ]
            service.store.upsert(service._tasks[key])

            with patch.object(
                image_task_module.image_storage_service,
                "inspect_paths",
                return_value=[
                    {
                        "path": "2026/07/29/legacy.png",
                        "size_bytes": 654321,
                        "width": 1536,
                        "height": 1024,
                        "storage": "local",
                    }
                ],
            ):
                item = service.list_admin_task_page()["items"][0]

            self.assertEqual(item["data"][0]["path"], "2026/07/29/legacy.png")
            self.assertEqual(item["data"][0]["width"], 1536)
            self.assertEqual(item["data"][0]["height"], 1024)
            self.assertEqual(item["data"][0]["size_bytes"], 654321)
            self.assertEqual(item["result_count"], 1)

    def test_standard_api_failure_is_visible_in_unified_feed(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            started = service.begin_api_call(
                OWNER,
                mode="edit",
                endpoint="/v1/images/edits",
                prompt="make it blue",
                model="gpt-image-2",
                size=None,
                quality="auto",
                request_n=1,
                response_format="url",
            )

            failed = service.fail_api_call(
                OWNER,
                started["id"],
                RuntimeError("upstream connection failed"),
            )

            self.assertEqual(failed["status"], "error")
            self.assertEqual(failed["source"], "api")
            self.assertEqual(failed["error_code"], "upstream_connection_error")
            self.assertEqual(
                service.list_admin_task_page(status="error")["pagination"]["total"],
                1,
            )

    def test_duplicate_submit_uses_existing_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                time.sleep(0.05)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            first = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            second = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            self.assertEqual(first["id"], "task-1")
            self.assertEqual(second["id"], "task-1")
            task = wait_for_task(service, OWNER, "task-1", "success")
            self.assertEqual(task["data"][0]["url"], "http://example.test/image.png")
            self.assertEqual(calls, 1)

    def test_backend_image_poll_exits_immediately_when_cancelled(self):
        backend = OpenAIBackendAPI()
        backend.cancel_event = threading.Event()
        backend.cancel_event.set()
        try:
            with self.assertRaises(ImageTaskCancelledError):
                backend._poll_image_results("conversation-cancelled", timeout_secs=30)
        finally:
            backend.close()

    def test_different_owner_cannot_query_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            service.submit_generation(
                OWNER,
                client_task_id="private-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            wait_for_task(service, OWNER, "private-task", "success")
            result = service.list_tasks(OTHER_OWNER, ["private-task"])

            self.assertEqual(result["items"], [])
            self.assertEqual(result["missing_ids"], ["private-task"])

    def test_public_task_redacts_internal_upstream_error_details(self):
        def handler(_payload):
            raise ImageGenerationError(
                "/backend-api/codex/responses failed: status=500, body=internal-detail"
            )

        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            service.submit_generation(
                OWNER,
                client_task_id="redacted-error-task",
                prompt="cat",
                model="codex-gpt-image-2",
                size=None,
            )

            task = wait_for_task(service, OWNER, "redacted-error-task", "error")

            self.assertNotIn("backend-api", task["error"])
            self.assertNotIn("internal-detail", task["error"])

    def test_local_image_urls_are_returned_as_host_independent_paths(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(
                Path(tmp_dir) / "image_tasks.json",
                lambda _payload: {
                    "data": [{"url": "http://127.0.0.1:3000/images/2026/07/18/example.png"}]
                },
            )
            service.submit_generation(
                OWNER,
                client_task_id="portable-url-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://127.0.0.1:3000",
            )

            task = wait_for_task(service, OWNER, "portable-url-task", "success")

            self.assertEqual(task["data"][0]["url"], "/images/2026/07/18/example.png")

    def test_thread_start_failure_rolls_back_task_and_reserved_credit(self):
        class Credits:
            def __init__(self):
                self.reserved: list[str] = []
                self.refunded: list[str] = []

            def reserve_image_credit(self, _identity, task_id: str):
                self.reserved.append(task_id)
                return True

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            credits = Credits()
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=lambda _payload: {"data": [{"url": "http://example.test/image.png"}]},
                retention_days_getter=lambda: 30,
                credit_manager=credits,
            )
            identity = {"id": "user-1", "role": "user"}

            with patch("services.image_task_service.threading.Thread.start", side_effect=RuntimeError("thread unavailable")):
                with self.assertRaisesRegex(RuntimeError, "thread unavailable"):
                    service.submit_generation(
                        identity,
                        client_task_id="thread-start-task",
                        prompt="cat",
                        model="gpt-image-2",
                        size=None,
                    )

            self.assertEqual(credits.reserved, ["thread-start-task"])
            self.assertEqual(credits.refunded, ["thread-start-task"])
            self.assertEqual(service.list_tasks(identity, ["thread-start-task"])["missing_ids"], ["thread-start-task"])

    def test_resume_thread_start_failure_restores_failed_task_and_reserved_credit(self):
        class Credits:
            def __init__(self):
                self.refunded: list[str] = []

            def reserve_image_credit(self, _identity, _task_id: str):
                return True

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(json.dumps({"tasks": [{
                "id": "resume-start-task",
                "owner_id": "user-1",
                "owner_role": "user",
                "credit_reserved": False,
                "status": "error",
                "mode": "generate",
                "model": "gpt-image-2",
                "prompt": "cat",
                "retry_prompt": "cat",
                "created_at": "2026-07-18 08:00:00",
                "updated_at": "2026-07-18 08:01:00",
                "error": "图片生成超时",
                "conversation_id": "conversation-1",
                "account_ref": "acct_fixture",
            }]}, ensure_ascii=False), encoding="utf-8")
            credits = Credits()
            service = ImageTaskService(
                path,
                retention_days_getter=lambda: 30,
                credit_manager=credits,
            )
            identity = {"id": "user-1", "role": "user"}

            with (
                patch.object(
                    account_service,
                    "resolve_image_access_token",
                    return_value="original-account-token",
                ),
                patch("services.image_task_service.threading.Thread.start", side_effect=RuntimeError("thread unavailable")),
            ):
                with self.assertRaisesRegex(RuntimeError, "thread unavailable"):
                    service.resume_poll(identity, "resume-start-task", 30)

            task = service.list_tasks(identity, ["resume-start-task"])["items"][0]
            self.assertEqual(task["status"], "error")
            self.assertEqual(task["error"], "图片生成超时")
            self.assertEqual(credits.refunded, ["resume-start-task"])

    def test_resume_poll_rejects_legacy_task_without_account_context_before_reserving_credit(self):
        class Credits:
            def __init__(self):
                self.reserved: list[str] = []

            def reserve_image_credit(self, _identity, task_id: str):
                self.reserved.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(json.dumps({"tasks": [{
                "id": "legacy-timeout-task",
                "owner_id": "user-1",
                "owner_role": "user",
                "credit_reserved": False,
                "status": "error",
                "mode": "generate",
                "model": "gpt-image-2",
                "prompt": "cat",
                "created_at": "2026-07-18 08:00:00",
                "updated_at": "2026-07-18 08:01:00",
                "error": "图片生成超时",
                "conversation_id": "conversation-legacy",
            }]}, ensure_ascii=False), encoding="utf-8")
            credits = Credits()
            service = ImageTaskService(path, credit_manager=credits, retention_days_getter=lambda: 30)

            with self.assertRaisesRegex(ValueError, "缺少原生图账号上下文"):
                service.resume_poll({"id": "user-1", "role": "user"}, "legacy-timeout-task", 30)

            self.assertEqual(credits.reserved, [])

    def test_success_task_persists_to_new_service_instance(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path)
            service.submit_generation(
                OWNER,
                client_task_id="persisted-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "persisted-task", "success")

            reloaded = self.make_service(path)
            result = reloaded.list_tasks(OWNER, ["persisted-task"])

            self.assertEqual(result["missing_ids"], [])
            self.assertEqual(result["items"][0]["status"], "success")
            self.assertEqual(result["items"][0]["data"][0]["url"], "http://example.test/image.png")

    def test_invalid_task_storage_aborts_loading_instead_of_overwriting_history(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            invalid_content = '{"tasks": ['
            path.write_text(invalid_content, encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "图片任务存储"):
                self.make_service(path)

            self.assertEqual(path.read_text(encoding="utf-8"), invalid_content)

    def test_task_keeps_prompt_and_reports_live_then_final_duration(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            started = threading.Event()
            release = threading.Event()

            def handler(_payload):
                started.set()
                if not release.wait(1.0):
                    raise TimeoutError("test task was not released")
                return {"data": [{"url": "http://example.test/image.png"}]}

            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path, handler)
            submitted = service.submit_generation(
                OWNER,
                client_task_id="timed-prompt-task",
                prompt="暮色里的山间小屋，电影感光影",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            self.assertEqual(submitted["prompt"], "暮色里的山间小屋，电影感光影")
            self.assertIn("elapsed_secs", submitted)
            self.assertTrue(started.wait(1.0))

            try:
                running = service.list_tasks(OWNER, ["timed-prompt-task"])["items"][0]
                self.assertEqual(running["status"], "running")
                self.assertEqual(running["prompt"], "暮色里的山间小屋，电影感光影")
                self.assertGreaterEqual(running["elapsed_secs"], 0)
            finally:
                release.set()
            completed = wait_for_task(service, OWNER, "timed-prompt-task", "success")

            self.assertEqual(completed["prompt"], "暮色里的山间小屋，电影感光影")
            self.assertIsInstance(completed["duration_ms"], int)
            self.assertGreaterEqual(completed["duration_ms"], 0)
            self.assertNotIn("retry_prompt", completed)
            stored = service.store.load_all()
            record = next(item for item in stored if item["id"] == "timed-prompt-task")
            self.assertEqual(record["prompt"], "暮色里的山间小屋，电影感光影")
            self.assertEqual(record["retry_prompt"], "")

    def test_cancel_running_task_refunds_credit_and_ignores_late_worker_result(self):
        class Credits:
            def __init__(self):
                self.refunded: list[str] = []
                self.consumed: list[str] = []

            def reserve_image_credit(self, _identity, _task_id: str):
                return True

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

            def consume_image_credit(self, _identity, task_id: str):
                self.consumed.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            started = threading.Event()
            worker_returned = threading.Event()

            def handler(payload):
                started.set()
                self.assertTrue(payload["cancel_event"].wait(1.0))
                worker_returned.set()
                return {"data": [{"url": "http://example.test/late.png"}]}

            credits = Credits()
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=handler,
                retention_days_getter=lambda: 30,
                credit_manager=credits,
            )
            service.submit_generation(
                OWNER,
                client_task_id="cancel-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
            )
            self.assertTrue(started.wait(1.0))

            stopped = service.cancel_task(OWNER, "cancel-task")
            self.assertEqual(stopped["status"], "error")
            self.assertEqual(stopped["error_code"], "cancelled_by_user")
            self.assertEqual(stopped["error"], "已由用户手动停止")
            self.assertTrue(stopped["retryable"])
            self.assertEqual(credits.refunded, ["cancel-task"])
            self.assertTrue(worker_returned.wait(1.0))
            time.sleep(0.05)

            latest = service.list_tasks(OWNER, ["cancel-task"])["items"][0]
            self.assertEqual(latest["status"], "error")
            self.assertEqual(latest["error_code"], "cancelled_by_user")
            self.assertEqual(latest["data"], [])
            self.assertEqual(credits.consumed, [])
            service.cancel_task(OWNER, "cancel-task")
            self.assertEqual(credits.refunded, ["cancel-task"])
            with self.assertRaisesRegex(ValueError, "task not found"):
                service.cancel_task(OTHER_OWNER, "cancel-task")

    def test_late_cancelled_attempt_cannot_overwrite_retried_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            first_started = threading.Event()
            release_first = threading.Event()
            calls = 0
            calls_lock = threading.Lock()

            def handler(payload):
                nonlocal calls
                with calls_lock:
                    calls += 1
                    call_number = calls
                if call_number == 1:
                    first_started.set()
                    self.assertTrue(payload["cancel_event"].wait(1.0))
                    self.assertTrue(release_first.wait(1.0))
                    return {"data": [{"url": "http://example.test/late.png"}]}
                return {"data": [{"url": "http://example.test/fresh.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            service.submit_generation(
                OWNER,
                client_task_id="cancel-retry-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
            )
            self.assertTrue(first_started.wait(1.0))
            service.cancel_task(OWNER, "cancel-retry-task")

            service.retry_generation(OWNER, "cancel-retry-task")
            retried = wait_for_task(service, OWNER, "cancel-retry-task", "success")
            self.assertEqual(retried["data"][0]["url"], "http://example.test/fresh.png")
            release_first.set()
            time.sleep(0.05)

            latest = service.list_tasks(OWNER, ["cancel-retry-task"])["items"][0]
            self.assertEqual(latest["status"], "success")
            self.assertEqual(latest["data"][0]["url"], "http://example.test/fresh.png")

    def test_queue_pause_resume_and_priority_are_owner_scoped(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            first_started = threading.Event()
            release_first = threading.Event()
            execution_order: list[str] = []

            def handler(payload):
                prompt = str(payload.get("prompt") or "")
                execution_order.append(prompt)
                if prompt == "first":
                    first_started.set()
                    self.assertTrue(release_first.wait(2.0))
                return {"data": [{"url": f"http://example.test/{prompt}.png"}]}

            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=handler,
                edit_handler=handler,
                retention_days_getter=lambda: 30,
                global_concurrency_getter=lambda: 1,
                user_concurrency_getter=lambda: 1,
            )
            service.submit_generation(
                OWNER, client_task_id="first", prompt="first", model="gpt-image-2", size=None
            )
            self.assertTrue(first_started.wait(1.0))
            service.submit_generation(
                OWNER, client_task_id="low", prompt="low", model="gpt-image-2", size=None
            )
            service.submit_generation(
                OWNER, client_task_id="high", prompt="high", model="gpt-image-2", size=None
            )
            estimate = service.estimate(OWNER)
            self.assertTrue(estimate["accepting"])
            self.assertEqual(estimate["queue_position"], 3)
            self.assertGreaterEqual(estimate["estimated_wait_secs"], 30)
            self.assertEqual(estimate["confidence"], "low")

            admin = {"id": "admin-control", "role": "admin", "name": "Queue Admin"}
            paused = service.pause_task(admin, "low")
            self.assertEqual(paused["status"], "paused")
            with self.assertRaisesRegex(ValueError, "task not found"):
                service.pause_task(OTHER_OWNER, "low")
            priority = service.set_task_priority(admin, "high", 10)
            self.assertEqual(priority["priority"], 10)
            resumed = service.resume_task(admin, "low")
            self.assertEqual(resumed["status"], "queued")

            release_first.set()
            wait_for_task(service, OWNER, "high", "success")
            wait_for_task(service, OWNER, "low", "success")
            self.assertEqual(execution_order, ["first", "high", "low"])

    def test_startup_marks_unfinished_tasks_as_error(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "queued-task",
                                "owner_id": "owner-1",
                                "status": "queued",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                            {
                                "id": "running-task",
                                "owner_id": "owner-1",
                                "status": "running",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "conversation_id": "restart-conversation",
                                "account_ref": "restart-account",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )

            service = self.make_service(path)
            result = service.list_tasks(OWNER, ["queued-task", "running-task"])

            self.assertEqual([item["status"] for item in result["items"]], ["error", "error"])
            self.assertTrue(all("已中断" in item.get("error", "") for item in result["items"]))
            self.assertEqual(result["items"][1]["recovery_mode"], "resume_poll")

    def test_interrupted_generation_keeps_private_retry_prompt_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "restart-retry-task",
                                "owner_id": "owner-1",
                                "status": "running",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "size": "1024x1024",
                                "quality": "high",
                                "retry_prompt": "private prompt survives restart",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            service = self.make_service(path)
            interrupted = service.list_tasks(OWNER, ["restart-retry-task"])["items"][0]
            self.assertEqual(interrupted["status"], "error")
            self.assertTrue(interrupted["retryable"])
            self.assertNotIn("retry_prompt", interrupted)
            self.assertEqual(interrupted["prompt"], "private prompt survives restart")

            retried = service.retry_generation(OWNER, "restart-retry-task", base_url="http://local.test")
            completed = wait_for_task(service, OWNER, retried["id"], "success")
            self.assertEqual(completed["status"], "success")

    def test_password_user_credit_is_reserved_once_and_refunded_when_task_fails(self):
        class CreditManager:
            def __init__(self):
                self.reserved: list[str] = []
                self.refunded: list[str] = []
                self.consumed: list[str] = []

            def reserve_image_credit(self, _identity, task_id: str):
                self.reserved.append(task_id)
                return True

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

            def consume_image_credit(self, _identity, task_id: str):
                self.consumed.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            credits = CreditManager()
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=lambda _payload: {"data": []},
                credit_manager=credits,
                retention_days_getter=lambda: 30,
            )
            user = {"id": "password-user", "name": "Password User", "role": "user"}

            service.submit_generation(
                user,
                client_task_id="credit-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, user, "credit-task", "error")

            self.assertEqual(credits.reserved, ["credit-task"])
            self.assertEqual(credits.refunded, ["credit-task"])
            self.assertEqual(credits.consumed, [])

    def test_failed_credit_refund_stays_pending_until_recovery_succeeds(self):
        class Credits:
            def __init__(self):
                self.fail_refund = True
                self.refunded: list[str] = []

            def reserve_image_credit(self, _identity, _task_id: str):
                return True

            def refund_image_credit(self, _identity, task_id: str):
                if self.fail_refund:
                    raise OSError("credit storage unavailable")
                self.refunded.append(task_id)
                return True

        def fail(_payload):
            raise RuntimeError("upstream failed")

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            credits = Credits()
            identity = {"id": "user-1", "role": "user"}
            service = ImageTaskService(
                path,
                generation_handler=fail,
                retention_days_getter=lambda: 30,
                credit_manager=credits,
            )
            service.submit_generation(
                identity,
                client_task_id="refund-recovery-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
            )
            wait_for_task(service, identity, "refund-recovery-task", "error")

            stored = service.store.load_all()[0]
            self.assertTrue(stored["credit_reserved"])

            credits.fail_refund = False
            recovered = ImageTaskService(
                path,
                generation_handler=fail,
                retention_days_getter=lambda: 30,
                credit_manager=credits,
            )
            self.assertEqual(recovered.list_tasks(identity, ["refund-recovery-task"])["items"][0]["status"], "error")
            stored = recovered.store.load_all()[0]
            self.assertFalse(stored["credit_reserved"])
            self.assertEqual(credits.refunded, ["refund-recovery-task"])

    def test_failed_credit_consume_keeps_successful_image_and_recovers_settlement(self):
        class Credits:
            def __init__(self):
                self.fail_consume = True
                self.consumed: list[str] = []

            def reserve_image_credit(self, _identity, _task_id: str):
                return True

            def consume_image_credit(self, _identity, task_id: str):
                if self.fail_consume:
                    raise OSError("credit storage unavailable")
                self.consumed.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            credits = Credits()
            identity = {"id": "user-1", "role": "user"}
            service = ImageTaskService(
                path,
                generation_handler=lambda _payload: {"data": [{"url": "http://example.test/image.png"}]},
                retention_days_getter=lambda: 30,
                credit_manager=credits,
            )
            service.submit_generation(
                identity,
                client_task_id="consume-recovery-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
            )
            task = wait_for_task(service, identity, "consume-recovery-task", "success")
            self.assertEqual(task["data"][0]["url"], "http://example.test/image.png")
            stored = service.store.load_all()[0]
            self.assertTrue(stored["credit_reserved"])

            credits.fail_consume = False
            recovered = ImageTaskService(
                path,
                retention_days_getter=lambda: 30,
                credit_manager=credits,
            )
            task = recovered.list_tasks(identity, ["consume-recovery-task"])["items"][0]
            self.assertEqual(task["status"], "success")
            self.assertEqual(task["data"][0]["url"], "http://example.test/image.png")
            stored = recovered.store.load_all()[0]
            self.assertFalse(stored["credit_reserved"])
            self.assertEqual(credits.consumed, ["consume-recovery-task"])

    def test_failed_generation_retry_reuses_the_original_task_with_the_original_prompt(self):
        class CreditManager:
            def __init__(self):
                self.reserved: list[str] = []
                self.refunded: list[str] = []
                self.consumed: list[str] = []

            def reserve_image_credit(self, _identity, task_id: str):
                self.reserved.append(task_id)
                return True

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

            def consume_image_credit(self, _identity, task_id: str):
                self.consumed.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            calls: list[dict] = []

            def handler(payload):
                calls.append(dict(payload))
                if len(calls) == 1:
                    return {"data": []}
                return {"data": [{"url": "http://example.test/retried.png"}]}

            credits = CreditManager()
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=handler,
                credit_manager=credits,
                retention_days_getter=lambda: 30,
            )
            service.submit_generation(
                OWNER,
                client_task_id="failed-task",
                prompt="private retry prompt",
                model="gpt-image-2",
                size="1024x1024",
                quality="high",
                base_url="http://local.test",
            )
            failed = wait_for_task(service, OWNER, "failed-task", "error")

            self.assertTrue(failed["retryable"])
            self.assertNotIn("retry_prompt", failed)

            retried = service.retry_generation(OWNER, "failed-task", base_url="http://retry.test")
            self.assertEqual(retried["id"], "failed-task")

            completed = wait_for_task(service, OWNER, "failed-task", "success")
            self.assertEqual(completed["data"][0]["url"], "http://example.test/retried.png")
            self.assertEqual(calls[1]["prompt"], "private retry prompt")
            self.assertEqual(calls[1]["size"], "1024x1024")
            self.assertEqual(calls[1]["quality"], "high")
            self.assertEqual(credits.reserved, ["failed-task", "failed-task"])
            self.assertEqual(credits.refunded, ["failed-task"])
            self.assertEqual(credits.consumed, ["failed-task"])
            stored = service.store.load_all()
            self.assertEqual([item["id"] for item in stored], ["failed-task"])
            self.assertEqual(stored[0].get("retry_prompt"), "")

    def test_task_feed_hides_legacy_retry_duplicate_and_reuses_the_visible_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "failed-task",
                                "owner_id": OWNER["id"],
                                "owner_role": OWNER["role"],
                                "status": "error",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "prompt": "legacy prompt",
                                "retry_prompt": "legacy prompt",
                                "retry_task_id": "retry-old-task",
                                "created_at": "2026-07-18 10:00:00",
                                "updated_at": "2026-07-18 10:01:00",
                            },
                            {
                                "id": "retry-old-task",
                                "owner_id": OWNER["id"],
                                "owner_role": OWNER["role"],
                                "status": "error",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "prompt": "legacy prompt",
                                "retry_prompt": "legacy prompt",
                                "created_at": "2026-07-18 10:01:00",
                                "updated_at": "2026-07-18 10:02:00",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            service = ImageTaskService(
                path,
                generation_handler=lambda _payload: {"data": [{"url": "http://example.test/retried.png"}]},
                retention_days_getter=lambda: 30,
            )

            self.assertEqual([item["id"] for item in service.list_tasks(OWNER, [])["items"]], ["failed-task"])

            retried = service.retry_generation(OWNER, "failed-task", base_url="http://retry.test")
            self.assertEqual(retried["id"], "failed-task")
            wait_for_task(service, OWNER, "failed-task", "success")

            self.assertEqual([item["id"] for item in service.list_tasks(OWNER, [])["items"]], ["failed-task"])

    def test_content_policy_failure_requires_prompt_edit_instead_of_retry(self):
        class ContentPolicyError(RuntimeError):
            code = "content_policy_violation"

        def handler(_payload):
            raise ContentPolicyError("图片未生成：提示词被上游安全策略拒绝，请调整敏感描述后重试。")

        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            service.submit_generation(
                OWNER,
                client_task_id="policy-task",
                prompt="policy prompt",
                model="codex-gpt-image-2",
                size="1024x1024",
                quality="high",
                base_url="http://local.test",
            )

            failed = wait_for_task(service, OWNER, "policy-task", "error")

            self.assertEqual(failed["error_code"], "content_policy_violation")
            self.assertFalse(failed["retryable"])
            with self.assertRaisesRegex(ValueError, "修改提示词"):
                service.retry_generation(OWNER, "policy-task", base_url="http://retry.test")

    def test_delete_failed_task_removes_only_the_owned_failure(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path, handler=lambda _payload: {"data": []})
            service.submit_generation(
                OWNER,
                client_task_id="failed-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "failed-task", "error")

            deleted = service.delete_failed_task(OWNER, "failed-task")

            self.assertEqual(deleted, {"ok": True, "id": "failed-task"})
            self.assertEqual(service.list_tasks(OWNER, ["failed-task"]), {"items": [], "missing_ids": ["failed-task"]})
            self.assertEqual(service.store.load_all(), [])

    def test_delete_failed_task_rejects_other_owners(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler=lambda _payload: {"data": []})
            service.submit_generation(
                OWNER,
                client_task_id="private-failed-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "private-failed-task", "error")

            with self.assertRaisesRegex(ValueError, "task not found"):
                service.delete_failed_task(OTHER_OWNER, "private-failed-task")

            self.assertEqual(service.list_tasks(OWNER, ["private-failed-task"])["items"][0]["status"], "error")

    def test_delete_failed_task_refunds_an_unreleased_reservation(self):
        class CreditManager:
            def __init__(self):
                self.refunded: list[str] = []

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "stale-credit-task",
                                "owner_id": OWNER["id"],
                                "owner_role": OWNER["role"],
                                "status": "error",
                                "mode": "generate",
                                "credit_reserved": True,
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            credits = CreditManager()
            service = ImageTaskService(path, credit_manager=credits, retention_days_getter=lambda: 30)

            service.delete_failed_task(OWNER, "stale-credit-task")

            self.assertEqual(credits.refunded, ["stale-credit-task"])
            self.assertEqual(service.list_tasks(OWNER, ["stale-credit-task"])["missing_ids"], ["stale-credit-task"])

    def test_delete_failed_task_rejects_successful_tasks(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            service.submit_generation(
                OWNER,
                client_task_id="successful-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "successful-task", "success")

            with self.assertRaisesRegex(ValueError, "only failed tasks can be deleted"):
                service.delete_failed_task(OWNER, "successful-task")

            self.assertEqual(service.list_tasks(OWNER, ["successful-task"])["items"][0]["status"], "success")

    def test_resume_poll_reserves_and_consumes_credit_after_a_timeout(self):
        class CreditManager:
            def __init__(self):
                self.reserved: list[str] = []
                self.refunded: list[str] = []
                self.consumed: list[str] = []

            def reserve_image_credit(self, _identity, task_id: str):
                self.reserved.append(task_id)
                return True

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

            def consume_image_credit(self, _identity, task_id: str):
                self.consumed.append(task_id)
                return True

        class TimedOutError(RuntimeError):
            conversation_id = "conversation-1"
            account_ref = "acct_original"

        class FakeBackend:
            seen_access_token = ""

            def __init__(self, access_token: str):
                self.__class__.seen_access_token = access_token

            def _poll_image_results(self, _conversation_id, _timeout):
                return ["file-1"], []

            def resolve_conversation_image_urls(self, _conversation_id, _file_ids, _sediment_ids, *, poll=False):
                return ["http://example.test/image.png"]

            def download_image_bytes(self, _urls):
                return [b"png"]

            def close(self):
                pass

        def fail_with_timeout(_payload):
            raise TimedOutError("图片生成超时")

        with tempfile.TemporaryDirectory() as tmp_dir:
            credits = CreditManager()
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                generation_handler=fail_with_timeout,
                credit_manager=credits,
                retention_days_getter=lambda: 30,
            )
            user = {"id": "password-user", "name": "Password User", "role": "user"}

            service.submit_generation(
                user,
                client_task_id="timeout-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, user, "timeout-task", "error")
            failed = service.list_tasks(user, ["timeout-task"])["items"][0]
            self.assertEqual(failed["recovery_mode"], "resume_poll")
            self.assertEqual(failed["last_checkpoint"], "recoverable_error")

            with (
                patch("services.openai_backend_api.OpenAIBackendAPI", FakeBackend),
                patch.object(
                    account_service,
                    "resolve_image_access_token",
                    side_effect=[
                        "original-account-token",
                        "original-account-token",
                        "refreshed-account-token",
                    ],
                    create=True,
                ),
                patch.object(
                    account_service,
                    "get_account",
                    return_value={"access_token": "refreshed-account-token"},
                ),
                patch.object(
                    account_service,
                    "refresh_access_token",
                    return_value="refreshed-account-token",
                ),
                patch(
                    "services.protocol.conversation.format_image_result",
                    return_value={"data": [{"url": "http://example.test/image.png"}]},
                ),
            ):
                service.resume_poll(user, "timeout-task", 5)
                wait_for_task(service, user, "timeout-task", "success")

            self.assertEqual(credits.reserved, ["timeout-task", "timeout-task"])
            self.assertEqual(credits.refunded, ["timeout-task"])
            self.assertEqual(credits.consumed, ["timeout-task"])
            self.assertEqual(FakeBackend.seen_access_token, "refreshed-account-token")
            persisted = service.store.load_all()[0]
            self.assertEqual(persisted.get("account_ref"), "acct_original")
            public = service.list_tasks(user, ["timeout-task"])["items"][0]
            self.assertEqual(public["resume_count"], 1)
            self.assertEqual(public["last_checkpoint"], "completed")
            self.assertNotIn("account_ref", public)

    def test_resume_poll_rejects_an_empty_download_instead_of_marking_success(self):
        class Credits:
            def __init__(self):
                self.refunded: list[str] = []
                self.consumed: list[str] = []

            def reserve_image_credit(self, _identity, _task_id: str):
                return True

            def refund_image_credit(self, _identity, task_id: str):
                self.refunded.append(task_id)
                return True

            def consume_image_credit(self, _identity, task_id: str):
                self.consumed.append(task_id)
                return True

        class EmptyDownloadBackend:
            def __init__(self, **_kwargs):
                pass

            def _poll_image_results(self, _conversation_id, _timeout):
                return ["file-1"], []

            def resolve_conversation_image_urls(self, _conversation_id, _file_ids, _sediment_ids, *, poll=False):
                return ["http://example.test/image.png"]

            def download_image_bytes(self, _urls):
                return []

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(json.dumps({"tasks": [{
                "id": "empty-download-task",
                "owner_id": "user-1",
                "owner_role": "user",
                "credit_reserved": False,
                "status": "error",
                "mode": "generate",
                "model": "gpt-image-2",
                "prompt": "cat",
                "retry_prompt": "cat",
                "created_at": "2026-07-18 08:00:00",
                "updated_at": "2026-07-18 08:01:00",
                "error": "图片生成超时",
                "conversation_id": "conversation-1",
                "account_ref": "acct_fixture",
            }]}, ensure_ascii=False), encoding="utf-8")
            credits = Credits()
            service = ImageTaskService(path, credit_manager=credits, retention_days_getter=lambda: 30)
            identity = {"id": "user-1", "role": "user"}

            with (
                patch("services.openai_backend_api.OpenAIBackendAPI", EmptyDownloadBackend),
                patch.object(
                    account_service,
                    "resolve_image_access_token",
                    side_effect=[
                        "original-account-token",
                        "original-account-token",
                        "refreshed-account-token",
                    ],
                ),
                patch.object(
                    account_service,
                    "get_account",
                    return_value={"access_token": "refreshed-account-token"},
                ),
                patch.object(
                    account_service,
                    "refresh_access_token",
                    return_value="refreshed-account-token",
                ),
            ):
                service.resume_poll(identity, "empty-download-task", 5)
                task = wait_for_task(service, identity, "empty-download-task", "error")

            self.assertIn("图片下载结果为空", task["error"])
            self.assertEqual(credits.refunded, ["empty-download-task"])
            self.assertEqual(credits.consumed, [])


if __name__ == "__main__":
    unittest.main()
