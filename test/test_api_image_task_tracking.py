from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ai as ai_module
from services.config import config
from services.protocol.conversation import ImageGenerationError


AUTH_HEADERS = {"Authorization": f"Bearer {config.auth_key}"}


class ApiImageTaskTrackingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tracker = mock.Mock()
        self.tracker.begin_api_call.return_value = {"id": "api-generation-test"}
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
        with mock.patch.object(
            ai_module.openai_v1_image_generations,
            "handle",
            return_value=result,
        ):
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
        self.tracker.begin_api_call.assert_called_once()
        self.tracker.complete_api_call.assert_called_once()
        self.tracker.fail_api_call.assert_not_called()

    def test_failed_generation_updates_the_unified_task(self) -> None:
        with mock.patch.object(
            ai_module.openai_v1_image_generations,
            "handle",
            side_effect=ImageGenerationError("upstream failed"),
        ):
            response = self.client.post(
                "/v1/images/generations",
                headers=AUTH_HEADERS,
                json={"prompt": "cinematic cat", "model": "gpt-image-2"},
            )

        self.assertEqual(response.status_code, 502, response.text)
        self.tracker.begin_api_call.assert_called_once()
        self.tracker.fail_api_call.assert_called_once()
        self.tracker.complete_api_call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
