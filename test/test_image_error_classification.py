from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from services.image_task_service import ImageTaskService, _classify_image_error
from services.openai_backend_api import ImagePollTimeoutError


class ImageErrorClassificationTests(unittest.TestCase):
    def test_typed_and_message_errors_receive_stable_codes(self) -> None:
        self.assertEqual(_classify_image_error(ImagePollTimeoutError("timeout"), "timeout"), "image_timeout")
        self.assertEqual(_classify_image_error(None, "no available image quota"), "account_pool_exhausted")
        self.assertEqual(_classify_image_error(None, "remote account check timeout"), "account_precheck_failed")
        self.assertEqual(_classify_image_error(None, "No image result found in response"), "no_image_result")
        self.assertEqual(_classify_image_error(None, "TLS connection failed"), "upstream_connection_error")
        self.assertEqual(_classify_image_error(None, "unexpected upstream response"), "upstream_error")

    def test_legacy_failed_tasks_are_classified_when_loaded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "tasks.json"
            path.write_text(json.dumps({
                "tasks": [{
                    "id": "legacy-timeout",
                    "owner_id": "owner",
                    "status": "error",
                    "mode": "generate",
                    "error": "ChatGPT 生图超时（已等待 300 秒）",
                    "created_at": "2026-07-18 10:00:00",
                    "updated_at": "2026-07-18 10:05:00",
                }]
            }), encoding="utf-8")

            service = ImageTaskService(path, retention_days_getter=lambda: 365)
            task = service.list_tasks({"id": "owner", "role": "user"}, ["legacy-timeout"])["items"][0]

        self.assertEqual(task["error_code"], "image_timeout")


if __name__ == "__main__":
    unittest.main()
