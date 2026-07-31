from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ai as ai_module
from services.config import config
from services.image_task_service import ImageQueueFullError
from services.protocol.conversation import ImageGenerationError


AUTH_HEADERS = {"Authorization": f"Bearer {config.auth_key}"}


class ApiImageTaskTrackingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tracker = mock.Mock()
        self.tracker.run_api_generation_async = mock.AsyncMock()
        self.tracker_patcher = mock.patch.object(
            ai_module,
            "image_task_service",
            self.tracker,
        )
        self.filter_patcher = mock.patch.object(
            ai_module,
            "filter_or_log",
            new=mock.AsyncMock(),
        )
        self.log_patcher = mock.patch("services.log_service.log_service.add")
        self.tracker_patcher.start()
        self.filter_patcher.start()
        self.log_patcher.start()
        self.addCleanup(self.tracker_patcher.stop)
        self.addCleanup(self.filter_patcher.stop)
        self.addCleanup(self.log_patcher.stop)

        app = FastAPI()
        app.include_router(ai_module.create_router())
        self.client = TestClient(app)

    def test_successful_generation_updates_the_unified_task(self) -> None:
        result = {
            "created": 1,
            "data": [
                {
                    "url": "http://testserver/images/2026/07/30/result.png",
                    "b64_json": "not-returned-to-task-storage",
                }
            ],
        }
        self.tracker.run_api_generation_async.return_value = result
        response = self.client.post(
            "/v1/images/generations",
            headers=AUTH_HEADERS,
            json={
                "prompt": "cinematic cat",
                "model": "gpt-image-2",
                "size": "1024x1024",
                "response_format": "b64_json",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), result)
        self.tracker.run_api_generation_async.assert_awaited_once()

    def test_failed_generation_updates_the_unified_task(self) -> None:
        self.tracker.run_api_generation_async.side_effect = ImageGenerationError("upstream failed")
        response = self.client.post(
            "/v1/images/generations",
            headers=AUTH_HEADERS,
            json={"prompt": "cinematic cat", "model": "gpt-image-2"},
        )

        self.assertEqual(response.status_code, 502, response.text)
        self.tracker.run_api_generation_async.assert_awaited_once()

    def test_full_unified_queue_returns_retryable_openai_error(self) -> None:
        self.tracker.run_api_generation_async.side_effect = ImageQueueFullError("图片任务队列已满")

        response = self.client.post(
            "/v1/images/generations",
            headers=AUTH_HEADERS,
            json={"prompt": "cinematic cat", "model": "gpt-image-2"},
        )

        self.assertEqual(response.status_code, 429, response.text)
        self.assertEqual(response.json()["error"]["code"], "image_queue_full")

    def test_stream_reports_partial_child_failure_as_sse_error(self) -> None:
        async def partial_stream():
            yield {
                "object": "image.generation.result",
                "created": 1,
                "index": 1,
                "total": 2,
                "data": [{"b64_json": "first-image"}],
            }
            raise ImageGenerationError(
                "一个或多个图片子任务失败，本次请求未完整完成",
                code="partial_generation_failed",
            )

        self.tracker.run_api_generation_async.return_value = partial_stream()
        response = self.client.post(
            "/v1/images/generations",
            headers=AUTH_HEADERS,
            json={
                "prompt": "two images",
                "model": "gpt-image-2",
                "n": 2,
                "stream": True,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('"code": "partial_generation_failed"', response.text)
        self.assertIn("data: [DONE]", response.text)


if __name__ == "__main__":
    unittest.main()
