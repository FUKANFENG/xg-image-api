from __future__ import annotations

import types
import unittest
from unittest import mock

from services import prompt_enhancement_service as service


class PromptEnhancementServiceTests(unittest.TestCase):
    def test_extracts_text_and_removes_minimax_reasoning_and_label(self) -> None:
        response = {
            "choices": [
                {
                    "message": {
                        "content": "<think>分析主体与画面要素</think>\n优化后的提示词：一只小狗在晨光草地奔跑，低机位跟拍，柔和逆光，细节丰富",
                    }
                }
            ]
        }

        result = service._extract_enhanced_prompt(response)

        self.assertEqual(result, "一只小狗在晨光草地奔跑，低机位跟拍，柔和逆光，细节丰富")

    def test_calls_configured_openai_compatible_provider_without_logging_credentials(self) -> None:
        fake_config = types.SimpleNamespace(
            ai_review={
                "base_url": "https://provider.example.com/",
                "api_key": "secret-key",
                "model": "MiniMax-test",
            }
        )
        fake_response = mock.Mock(
            status_code=200,
            json=mock.Mock(return_value={"choices": [{"message": {"content": "清晨的湖畔木屋，薄雾升起，电影感自然光"}}]}),
        )

        with (
            mock.patch.object(service, "config", fake_config),
            mock.patch.object(service.requests, "post", return_value=fake_response) as post,
        ):
            result = service.enhance_prompt("湖边木屋", "保留木屋主体，改为高级杂志封面风，画面干净留白。")

        self.assertEqual(result, "清晨的湖畔木屋，薄雾升起，电影感自然光")
        self.assertEqual(post.call_args.args[0], "https://provider.example.com/v1/chat/completions")
        self.assertEqual(post.call_args.kwargs["json"]["model"], "MiniMax-test")
        provider_prompt = post.call_args.kwargs["json"]["messages"][1]["content"]
        self.assertIn("原始提示词：\n湖边木屋", provider_prompt)
        self.assertIn("用户美化要求：\n保留木屋主体，改为高级杂志封面风，画面干净留白。", provider_prompt)
        self.assertEqual(post.call_args.kwargs["timeout"], 45)

    def test_reports_missing_provider_configuration_without_trying_network(self) -> None:
        fake_config = types.SimpleNamespace(ai_review={})

        with (
            mock.patch.object(service, "config", fake_config),
            mock.patch.object(service.requests, "post") as post,
            self.assertRaises(service.PromptEnhancementConfigurationError),
        ):
            service.enhance_prompt("湖边木屋")

        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
