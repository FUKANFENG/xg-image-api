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
        with patch.dict(
            os.environ,
            {
                "CHATGPT2API_WEB_NO_LOGIN": "true",
                "CHATGPT2API_LAN_NO_LOGIN": "false",
            },
        ):
            response = self.client.post(
                "/auth/session",
                headers={
                    "Host": "192.168.1.20:8000",
                    "Sec-Fetch-Site": "same-origin",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["authenticated"])

    def test_private_lan_browser_gets_admin_access_only_when_explicitly_enabled(self) -> None:
        with patch.dict(
            os.environ,
            {
                "CHATGPT2API_WEB_NO_LOGIN": "true",
                "CHATGPT2API_LAN_NO_LOGIN": "true",
            },
        ):
            response = self.client.post(
                "/auth/session",
                headers={
                    "Host": "192.168.1.118:18082",
                    "Sec-Fetch-Site": "same-origin",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["authenticated"])
        self.assertEqual(response.json()["role"], "admin")

    def test_lan_no_login_does_not_bypass_api_clients_or_public_hosts(self) -> None:
        with patch.dict(
            os.environ,
            {
                "CHATGPT2API_WEB_NO_LOGIN": "true",
                "CHATGPT2API_LAN_NO_LOGIN": "true",
            },
        ):
            api_client = self.client.post(
                "/auth/session",
                headers={"Host": "192.168.1.118:18082"},
            )
            public_host = self.client.post(
                "/auth/session",
                headers={
                    "Host": "203.0.113.10:18082",
                    "Sec-Fetch-Site": "same-origin",
                },
            )

        self.assertFalse(api_client.json()["authenticated"])
        self.assertFalse(public_host.json()["authenticated"])

    def test_public_browser_gets_admin_access_only_for_an_allowlisted_hostname(self) -> None:
        with patch.dict(
            os.environ,
            {
                "CHATGPT2API_WEB_NO_LOGIN": "true",
                "CHATGPT2API_PUBLIC_NO_LOGIN_HOSTS": "picture.museyin.com",
            },
        ):
            allowed = self.client.post(
                "/auth/session",
                headers={
                    "Host": "picture.museyin.com",
                    "Sec-Fetch-Site": "same-origin",
                },
            )
            rejected = self.client.post(
                "/auth/session",
                headers={
                    "Host": "other.museyin.com",
                    "Sec-Fetch-Site": "same-origin",
                },
            )

        self.assertTrue(allowed.json()["authenticated"])
        self.assertEqual(allowed.json()["role"], "admin")
        self.assertFalse(rejected.json()["authenticated"])

    def test_public_document_bootstraps_a_secure_host_bound_session(self) -> None:
        client = TestClient(create_app(), base_url="https://picture.museyin.com")
        plain_client = TestClient(create_app(), base_url="https://picture.museyin.com")
        with patch.dict(
            os.environ,
            {
                "CHATGPT2API_WEB_NO_LOGIN": "true",
                "CHATGPT2API_PUBLIC_NO_LOGIN_HOSTS": "picture.museyin.com",
            },
        ):
            document = client.get("/image/")
            session = client.post("/auth/session")
            plain_api_session = plain_client.post("/auth/session")

        set_cookie = document.headers.get("set-cookie", "").lower()
        self.assertEqual(document.status_code, 200, document.text)
        self.assertIn("chatgpt2api_direct_web=", set_cookie)
        self.assertIn("httponly", set_cookie)
        self.assertIn("secure", set_cookie)
        self.assertIn("samesite=strict", set_cookie)
        self.assertTrue(session.json()["authenticated"])
        self.assertFalse(plain_api_session.json()["authenticated"])

    def test_private_lan_document_bootstraps_an_http_only_direct_session(self) -> None:
        client = TestClient(create_app())
        with patch.dict(
            os.environ,
            {
                "CHATGPT2API_WEB_NO_LOGIN": "true",
                "CHATGPT2API_LAN_NO_LOGIN": "true",
            },
        ):
            document = client.get(
                "/monitor/",
                headers={"Host": "192.168.1.118:18082"},
            )
            session = client.post(
                "/auth/session",
                headers={"Host": "192.168.1.118:18082"},
            )

        set_cookie = document.headers.get("set-cookie", "").lower()
        self.assertEqual(document.status_code, 200, document.text)
        self.assertIn("chatgpt2api_direct_web=", set_cookie)
        self.assertIn("httponly", set_cookie)
        self.assertIn("samesite=strict", set_cookie)
        self.assertTrue(session.json()["authenticated"])
        self.assertEqual(session.json()["role"], "admin")

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
