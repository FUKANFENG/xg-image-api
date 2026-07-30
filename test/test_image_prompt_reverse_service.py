from __future__ import annotations

import json
import unittest
from unittest import mock

from services.image_prompt_reverse_service import (
    ImagePromptReverseProviderError,
    parse_reverse_prompt_response,
    reverse_image_prompt,
)


class ImagePromptReverseServiceTests(unittest.TestCase):
    def test_reverse_prompt_uses_multimodal_chat_and_returns_structured_result(self) -> None:
        upstream = json.dumps(
            {
                "prompt": "白色背景中的玻璃香水瓶，商业产品摄影，柔和轮廓光",
                "summary": "极简香水产品图",
                "subject": "透明玻璃香水瓶",
                "composition": "居中近景",
                "lighting": "柔和轮廓光",
                "colors": ["白色", "透明"],
                "style": "商业产品摄影",
                "text_content": [],
            },
            ensure_ascii=False,
        )

        with (
            mock.patch("services.image_prompt_reverse_service.text_backend", return_value=object()),
            mock.patch("services.image_prompt_reverse_service.collect_text", return_value=upstream) as collect,
            mock.patch("services.image_prompt_reverse_service.time.monotonic", side_effect=[10.0, 10.125]),
        ):
            result = reverse_image_prompt(
                b"png-bytes",
                "sample.png",
                "image/png",
                detail="standard",
                purpose="电商主图",
            )

        request = collect.call_args.args[1]
        user_content = request.messages[-1]["content"]
        self.assertEqual(result["prompt"], "白色背景中的玻璃香水瓶，商业产品摄影，柔和轮廓光")
        self.assertEqual(result["style"], "商业产品摄影")
        self.assertEqual(result["elapsed_ms"], 125)
        self.assertEqual(request.model, "auto")
        self.assertTrue(any(part.get("type") == "image" and part.get("data") == b"png-bytes" for part in user_content))
        self.assertIn("电商主图", str(user_content))

    def test_parser_recovers_fenced_json_and_normalizes_fields(self) -> None:
        parsed = parse_reverse_prompt_response(
            "分析如下：\n```json\n"
            '{"prompt":"电影感夜景","colors":"蓝色、紫色","text_content":"XG"}'
            "\n```"
        )

        self.assertEqual(parsed["prompt"], "电影感夜景")
        self.assertEqual(parsed["colors"], ["蓝色", "紫色"])
        self.assertEqual(parsed["text_content"], ["XG"])

    def test_parser_falls_back_to_plain_text_prompt(self) -> None:
        parsed = parse_reverse_prompt_response("雨夜霓虹街道，低机位广角镜头，电影感蓝紫色调")

        self.assertEqual(parsed["prompt"], "雨夜霓虹街道，低机位广角镜头，电影感蓝紫色调")
        self.assertEqual(parsed["colors"], [])

    def test_reverse_prompt_rejects_empty_provider_result(self) -> None:
        with (
            mock.patch("services.image_prompt_reverse_service.text_backend", return_value=object()),
            mock.patch("services.image_prompt_reverse_service.collect_text", return_value="  "),
        ):
            with self.assertRaises(ImagePromptReverseProviderError):
                reverse_image_prompt(b"png", "sample.png", "image/png")


if __name__ == "__main__":
    unittest.main()
