from __future__ import annotations

import base64
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ai as ai_module
from services.config import config


AUTH_HEADERS = {"Authorization": f"Bearer {config.auth_key}"}
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="
)
PNG_DATA_URL = f"data:image/png;base64,{base64.b64encode(PNG_BYTES).decode('ascii')}"
IMAGE_RESULT = {
    "created": 1,
    "data": [{"b64_json": base64.b64encode(b"generated-image").decode("ascii")}],
}


class SchedulerImageRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scheduler = mock.Mock()
        self.scheduler.run_api_generation_async = mock.AsyncMock()
        self.scheduler.run_api_edit_async = mock.AsyncMock()
        self.scheduler_patcher = mock.patch.object(
            ai_module,
            "image_task_service",
            self.scheduler,
        )
        self.filter_patcher = mock.patch.object(
            ai_module,
            "filter_or_log",
            new=mock.AsyncMock(),
        )
        self.log_patcher = mock.patch("services.log_service.log_service.add")
        self.scheduler_patcher.start()
        self.filter_patcher.start()
        self.log_patcher.start()
        self.addCleanup(self.scheduler_patcher.stop)
        self.addCleanup(self.filter_patcher.stop)
        self.addCleanup(self.log_patcher.stop)

        app = FastAPI()
        app.include_router(ai_module.create_router())
        self.client = TestClient(app)

    def test_image_chat_completion_uses_unified_generation_scheduler(self) -> None:
        self.scheduler.run_api_generation_async.return_value = IMAGE_RESULT

        response = self.client.post(
            "/v1/chat/completions",
            headers=AUTH_HEADERS,
            json={
                "model": "gpt-image-2",
                "messages": [{"role": "user", "content": "draw a lighthouse"}],
                "n": 1,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        content = response.json()["choices"][0]["message"]["content"]
        self.assertIn("data:image/png;base64,", content)
        self.scheduler.run_api_generation_async.assert_awaited_once()
        _identity, payload = self.scheduler.run_api_generation_async.await_args.args
        self.assertEqual(payload["prompt"], "draw a lighthouse")
        self.assertEqual(
            self.scheduler.run_api_generation_async.await_args.kwargs["endpoint"],
            "/v1/chat/completions",
        )

    def test_reference_image_chat_uses_unified_edit_scheduler(self) -> None:
        self.scheduler.run_api_edit_async.return_value = IMAGE_RESULT

        response = self.client.post(
            "/v1/chat/completions",
            headers=AUTH_HEADERS,
            json={
                "model": "gpt-image-2",
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "make it blue"},
                        {
                            "type": "image_url",
                            "image_url": {"url": PNG_DATA_URL},
                        },
                    ],
                }],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.scheduler.run_api_edit_async.assert_awaited_once()
        _identity, payload = self.scheduler.run_api_edit_async.await_args.args
        self.assertEqual(payload["images"][0][0], PNG_BYTES)
        self.assertEqual(
            self.scheduler.run_api_edit_async.await_args.kwargs["endpoint"],
            "/v1/chat/completions",
        )

    def test_response_image_tool_uses_unified_generation_scheduler(self) -> None:
        self.scheduler.run_api_generation_async.return_value = IMAGE_RESULT

        response = self.client.post(
            "/v1/responses",
            headers=AUTH_HEADERS,
            json={
                "model": "gpt-image-2",
                "input": "draw a mountain",
                "tools": [{"type": "image_generation"}],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "completed")
        self.assertEqual(
            response.json()["output"][0]["type"],
            "image_generation_call",
        )
        self.scheduler.run_api_generation_async.assert_awaited_once()
        self.assertEqual(
            self.scheduler.run_api_generation_async.await_args.kwargs["endpoint"],
            "/v1/responses",
        )

    def test_streaming_image_chat_adapts_scheduler_results_to_chat_sse(self) -> None:
        async def chunks():
            yield {
                "object": "image.generation.chunk",
                "created": 1,
                "model": "gpt-image-2",
                "index": 1,
                "total": 1,
                "progress_text": "0/1",
                "data": [],
            }
            yield {
                "object": "image.generation.result",
                "created": 1,
                "model": "gpt-image-2",
                "index": 1,
                "total": 1,
                "data": IMAGE_RESULT["data"],
            }

        self.scheduler.run_api_generation_async.return_value = chunks()
        response = self.client.post(
            "/v1/chat/completions",
            headers=AUTH_HEADERS,
            json={
                "model": "gpt-image-2",
                "messages": [{"role": "user", "content": "draw a lighthouse"}],
                "stream": True,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("chat.completion.chunk", response.text)
        self.assertIn("data:image/png;base64,", response.text)
        self.assertIn("data: [DONE]", response.text)

    def test_streaming_response_image_adapts_scheduler_results_to_response_sse(self) -> None:
        async def chunks():
            yield {
                "object": "image.generation.chunk",
                "created": 1,
                "model": "gpt-image-2",
                "index": 1,
                "total": 1,
                "progress_text": "0/1",
                "data": [],
            }
            yield {
                "object": "image.generation.result",
                "created": 1,
                "model": "gpt-image-2",
                "index": 1,
                "total": 1,
                "data": IMAGE_RESULT["data"],
            }

        self.scheduler.run_api_generation_async.return_value = chunks()
        response = self.client.post(
            "/v1/responses",
            headers=AUTH_HEADERS,
            json={
                "model": "gpt-image-2",
                "input": "draw a mountain",
                "tools": [{"type": "image_generation"}],
                "stream": True,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('"type": "response.created"', response.text)
        self.assertIn('"type": "response.output_item.done"', response.text)
        self.assertIn('"type": "response.completed"', response.text)
        self.assertIn("data: [DONE]", response.text)


if __name__ == "__main__":
    unittest.main()
