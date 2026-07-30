from __future__ import annotations

import json
import time
import unittest

import requests

from test.utils import LIVE_BASE_URL, assert_http_ok, live_auth_key, live_http_test

AUTH_KEY = live_auth_key()
BASE_URL = LIVE_BASE_URL
MODEL = "auto"


@live_http_test
class AnthropicMessagesTests(unittest.TestCase):
    @staticmethod
    def _headers() -> dict[str, str]:
        return {
            "x-api-key": AUTH_KEY,
            "anthropic-version": "2023-06-01",
        }

    def test_message_http(self):
        """测试 Anthropic Messages 的非流式 HTTP 调用。"""
        response = requests.post(
            f"{BASE_URL}/v1/messages",
            headers=self._headers(),
            json={
                "model": MODEL,
                "messages": [
                    {"role": "user", "content": "你好，请简单介绍一下你自己。"},
                ],
            },
            timeout=300,
        )
        assert_http_ok(self, response)
        print("messages non-stream status:")
        print(response.status_code)
        print("messages non-stream result:")
        try:
            print(json.dumps(response.json(), ensure_ascii=False, indent=2))
        except Exception:
            print(response.text)

    def test_message_stream_http(self):
        """测试 Anthropic Messages 的流式 HTTP 调用。"""
        started_at = time.time()
        response = requests.post(
            f"{BASE_URL}/v1/messages",
            headers=self._headers(),
            json={
                "model": MODEL,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "你好，请简单介绍一下你自己。"},
                ],
            },
            stream=True,
            timeout=300,
        )
        assert_http_ok(self, response)
        headers_at = time.time()
        print("messages stream status:")
        print(response.status_code)
        print("messages stream content-type:")
        print(response.headers.get("content-type", ""))
        print("messages stream response headers:")
        print(f"{headers_at - started_at:6.2f}s")
        print("messages stream chunks:")
        for line in response.iter_lines(chunk_size=1):
            if not line:
                continue
            text = line.decode("utf-8", errors="replace")
            print(f"{time.time() - started_at:6.2f}s {text}")
            if not text.startswith("data:"):
                continue
            try:
                payload = json.loads(text[5:].strip())
            except Exception:
                continue
            if payload.get("type") == "message_stop":
                break


if __name__ == "__main__":
    unittest.main()
