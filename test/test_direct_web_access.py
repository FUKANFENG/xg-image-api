from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.app import create_app


class DirectWebAccessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app())

    def test_local_same_origin_browser_gets_admin_session_without_login(self) -> None:
        with patch.dict(os.environ, {"CHATGPT2API_WEB_NO_LOGIN": "true"}):
            response = self.client.post(
                "/auth/session",
                headers={
                    "Host": "127.0.0.1:8000",
                    "Sec-Fetch-Site": "same-origin",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["authenticated"])
        self.assertEqual(response.json()["role"], "admin")

    def test_api_client_without_fetch_metadata_still_requires_bearer_key(self) -> None:
        with patch.dict(os.environ, {"CHATGPT2API_WEB_NO_LOGIN": "true"}):
            response = self.client.post(
                "/auth/session",
                headers={"Host": "127.0.0.1:8000"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["authenticated"])

    def test_non_loopback_browser_does_not_get_direct_admin_access(self) -> None:
        with patch.dict(os.environ, {"CHATGPT2API_WEB_NO_LOGIN": "true"}):
            response = self.client.post(
                "/auth/session",
                headers={
                    "Host": "192.168.1.20:8000",
                    "Sec-Fetch-Site": "same-origin",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["authenticated"])

    def test_feature_is_off_unless_explicitly_enabled(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CHATGPT2API_WEB_NO_LOGIN", None)
            response = self.client.post(
                "/auth/session",
                headers={
                    "Host": "127.0.0.1:8000",
                    "Sec-Fetch-Site": "same-origin",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["authenticated"])


if __name__ == "__main__":
    unittest.main()
