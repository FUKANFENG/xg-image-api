from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import ai
from services.prompt_enhancement_service import PromptEnhancementProviderError


class FakeLoggedCall:
    def __init__(self, *_args, **_kwargs) -> None:
        self.events: list[tuple[str, dict[str, object]]] = []

    def log(self, suffix: str, **kwargs) -> None:
        self.events.append((suffix, kwargs))


class PromptEnhancementApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(ai.create_router())
        self.client = TestClient(app)
        self.identity = {"id": "user-1", "name": "设计用户", "role": "user"}

    def test_regular_user_can_enhance_a_prompt(self) -> None:
        enhancement_request = "保留小狗主体，改成暖色童话绘本风，强调柔和逆光。"
        with (
            mock.patch.object(ai, "require_identity", return_value=self.identity),
            mock.patch.object(ai, "filter_or_log", new=mock.AsyncMock()),
            mock.patch.object(ai, "enhance_prompt", return_value="一只小狗在晨光草地奔跑，低机位跟拍，柔和逆光") as enhance,
            mock.patch.object(ai, "LoggedCall", FakeLoggedCall),
        ):
            response = self.client.post(
                "/api/prompt-enhancements",
                json={"prompt": "小狗奔跑", "instruction": enhancement_request},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["prompt"], "一只小狗在晨光草地奔跑，低机位跟拍，柔和逆光")
        enhance.assert_called_once_with("小狗奔跑", enhancement_request)

    def test_blank_prompt_is_rejected_before_calling_provider(self) -> None:
        with (
            mock.patch.object(ai, "require_identity", return_value=self.identity),
            mock.patch.object(ai, "enhance_prompt") as enhance,
        ):
            response = self.client.post("/api/prompt-enhancements", json={"prompt": "   "})

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["error"], "请先输入需要美化的提示词。")
        enhance.assert_not_called()

    def test_provider_error_falls_back_to_the_original_prompt(self) -> None:
        with (
            mock.patch.object(ai, "require_identity", return_value=self.identity),
            mock.patch.object(ai, "filter_or_log", new=mock.AsyncMock()),
            mock.patch.object(ai, "enhance_prompt", side_effect=PromptEnhancementProviderError("提示词美化服务暂时不可用，请保留原提示词后稍后重试。")),
            mock.patch.object(ai, "LoggedCall", FakeLoggedCall),
        ):
            response = self.client.post("/api/prompt-enhancements", json={"prompt": "小狗奔跑"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["prompt"], "小狗奔跑")
        self.assertTrue(response.json()["fallback"])


if __name__ == "__main__":
    unittest.main()
