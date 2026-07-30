from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sdk import XGAPIClient, XGAPIError


class _Response:
    def __init__(
        self,
        payload: dict[str, object],
        content_type: str = "application/json",
    ) -> None:
        self._payload = payload
        self.headers = _Headers(content_type)

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload).encode()


class _Headers:
    def __init__(self, content_type: str) -> None:
        self.content_type = content_type

    def get_content_type(self) -> str:
        return self.content_type


class XGAPIClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = XGAPIClient(
            "http://127.0.0.1:8000/v1/",
            "test-key",
            max_retries=0,
        )

    def test_normalizes_base_url_and_builds_generation_request(self) -> None:
        self.assertEqual(self.client.base_url, "http://127.0.0.1:8000")

        with patch(
            "urllib.request.urlopen",
            return_value=_Response({"data": [{"b64_json": "eA=="}]}),
        ) as urlopen:
            result = self.client.generate_image("测试提示词")

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(
            request.full_url,
            "http://127.0.0.1:8000/v1/images/generations",
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(payload["prompt"], "测试提示词")
        self.assertEqual(payload["model"], "gpt-image-2")
        self.assertEqual(result["data"][0]["b64_json"], "eA==")

    def test_edit_image_normalizes_string_urls(self) -> None:
        with patch(
            "urllib.request.urlopen",
            return_value=_Response({"data": [{"url": "https://example.com/a.png"}]}),
        ) as urlopen:
            self.client.edit_image("变成夜景", ["https://example.com/input.png"])

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(
            payload["images"],
            [{"image_url": "https://example.com/input.png"}],
        )

    def test_save_images_decodes_base64(self) -> None:
        content = b"\x89PNG\r\n\x1a\nsample"
        response = {
            "data": [{"b64_json": base64.b64encode(content).decode("ascii")}]
        }
        with tempfile.TemporaryDirectory() as temporary:
            paths = self.client.save_images(response, temporary, prefix="test")
            self.assertEqual(paths, [Path(temporary) / "test-1.png"])
            self.assertEqual(paths[0].read_bytes(), content)

    def test_streaming_is_rejected_with_clear_message(self) -> None:
        with self.assertRaisesRegex(ValueError, "JSON only"):
            self.client.chat(
                [{"role": "user", "content": "hello"}],
                stream=True,
            )

    def test_missing_image_data_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(XGAPIError):
                self.client.save_images({}, temporary)


if __name__ == "__main__":
    unittest.main()
