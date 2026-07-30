from __future__ import annotations

import unittest
from unittest.mock import patch

from services import openai_backend_api
from services.log_service import LoggedCall, log_service


SIGNED_URL = "https://files.example.com/image.png?sig=top-secret&expires=999#fragment"
SAFE_URL = "https://files.example.com/image.png"


class LogURLRedactionTests(unittest.TestCase):
    def test_logged_call_strips_query_and_fragment_from_urls(self) -> None:
        call = LoggedCall(
            identity={"id": "admin", "name": "Admin", "role": "admin"},
            endpoint="/v1/images/generations",
            model="gpt-image-2",
            summary="image",
        )

        with patch.object(log_service, "add") as add:
            call.log("done", result={"data": [{"url": SIGNED_URL}]})

        detail = add.call_args.args[2]
        self.assertEqual(detail["urls"], [SAFE_URL])
        self.assertNotIn("top-secret", str(detail))

    def test_backend_debug_log_strips_signed_url_parameters(self) -> None:
        backend = openai_backend_api.OpenAIBackendAPI.__new__(
            openai_backend_api.OpenAIBackendAPI
        )
        backend._get_file_download_url = lambda _file_id: SIGNED_URL

        with patch.object(openai_backend_api.logger, "debug") as debug:
            urls = backend._resolve_image_urls("", ["file-1"], [])

        self.assertEqual(urls, [SIGNED_URL])
        rendered_logs = " ".join(str(call) for call in debug.call_args_list)
        self.assertIn(SAFE_URL, rendered_logs)
        self.assertNotIn("top-secret", rendered_logs)


if __name__ == "__main__":
    unittest.main()
