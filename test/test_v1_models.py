from __future__ import annotations

import json
import unittest
from unittest import mock

import requests

from services.protocol import openai_v1_models
from test.utils import LIVE_BASE_URL, assert_http_ok, live_auth_key, live_http_test


AUTH_KEY = live_auth_key()
BASE_URL = LIVE_BASE_URL


class ModelListTests(unittest.TestCase):
    def test_list_models_only_returns_image_models_backed_by_account_types(self):
        with (
            mock.patch.object(
                openai_v1_models.OpenAIBackendAPI,
                "list_models",
                return_value={"object": "list", "data": []},
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {"access_token": "token-free", "type": "free", "status": "正常", "quota": 3},
                    {"access_token": "token-web-team", "type": "Team", "source_type": "web", "status": "正常", "quota": 3},
                    {"access_token": "token-codex-team", "type": "Team", "source_type": "codex", "status": "正常", "quota": 3},
                ],
            ),
        ):
            result = openai_v1_models.list_models()

        ids = {item["id"] for item in result["data"]}
        self.assertIn("gpt-image-2", ids)
        self.assertIn("codex-gpt-image-2", ids)
        self.assertIn("team-codex-gpt-image-2", ids)
        self.assertNotIn("plus-codex-gpt-image-2", ids)
        self.assertNotIn("pro-codex-gpt-image-2", ids)

    def test_list_models_does_not_return_codex_models_for_web_plus_accounts(self):
        with (
            mock.patch.object(
                openai_v1_models.OpenAIBackendAPI,
                "list_models",
                return_value={"object": "list", "data": []},
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {"access_token": "token-web-plus", "type": "Plus", "source_type": "web", "status": "正常", "quota": 3},
                ],
            ),
        ):
            result = openai_v1_models.list_models()

        ids = {item["id"] for item in result["data"]}
        self.assertIn("gpt-image-2", ids)
        self.assertNotIn("codex-gpt-image-2", ids)
        self.assertNotIn("plus-codex-gpt-image-2", ids)

    def test_list_models_advertises_web_image_for_codex_oauth_accounts(self):
        with (
            mock.patch.object(openai_v1_models.account_service, "get_text_access_token", return_value=""),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {
                        "access_token": "codex-pro-token",
                        "type": "Pro",
                        "source_type": "codex",
                        "status": "正常",
                        "quota": 3,
                    }
                ],
            ),
        ):
            result = openai_v1_models.list_models()

        ids = {item["id"] for item in result["data"]}
        self.assertIn("gpt-image-2", ids)
        self.assertIn("codex-gpt-image-2", ids)

    def test_list_models_treats_oauth_login_accounts_as_web_image_accounts(self):
        with (
            mock.patch.object(openai_v1_models.account_service, "get_text_access_token", return_value=""),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {
                        "access_token": "oauth-login-token",
                        "type": "Plus",
                        "source_type": "oauth_login",
                        "status": "正常",
                        "quota": 3,
                    }
                ],
            ),
        ):
            result = openai_v1_models.list_models()

        self.assertIn("gpt-image-2", {item["id"] for item in result["data"]})

    def test_list_models_uses_authenticated_account_token(self):
        backend = mock.Mock()
        backend.list_models.return_value = {"object": "list", "data": []}
        with (
            mock.patch.object(
                openai_v1_models.account_service,
                "get_text_access_token",
                return_value="authenticated-token",
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[],
            ),
            mock.patch.object(
                openai_v1_models,
                "OpenAIBackendAPI",
                return_value=backend,
            ) as backend_class,
        ):
            result = openai_v1_models.list_models()

        self.assertEqual(result, {"object": "list", "data": []})
        backend_class.assert_called_once_with("authenticated-token")
        backend.close.assert_called_once_with()

    def test_upstream_model_failure_falls_back_to_local_dynamic_models(self):
        backend = mock.Mock()
        backend.list_models.side_effect = RuntimeError("upstream unavailable")
        with (
            mock.patch.object(
                openai_v1_models.account_service,
                "get_text_access_token",
                return_value="authenticated-token",
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {
                        "access_token": "web-token",
                        "source_type": "web",
                        "type": "Plus",
                        "status": "正常",
                        "quota": 2,
                    }
                ],
            ),
            mock.patch.object(openai_v1_models, "OpenAIBackendAPI", return_value=backend),
        ):
            result = openai_v1_models.list_models()

        self.assertIn("gpt-image-2", {item["id"] for item in result["data"]})
        backend.close.assert_called_once_with()

    def test_dynamic_models_ignore_unavailable_accounts(self):
        backend = mock.Mock()
        backend.list_models.return_value = {"object": "list", "data": []}
        with (
            mock.patch.object(
                openai_v1_models.account_service,
                "get_text_access_token",
                return_value="",
            ),
            mock.patch.object(
                openai_v1_models.account_service,
                "list_accounts",
                return_value=[
                    {
                        "access_token": "disabled-web",
                        "source_type": "web",
                        "type": "Plus",
                        "status": "禁用",
                        "quota": 3,
                    },
                    {
                        "access_token": "empty-codex",
                        "source_type": "codex",
                        "type": "Team",
                        "status": "正常",
                        "quota": 0,
                    },
                    {
                        "access_token": "abnormal-codex",
                        "source_type": "codex",
                        "type": "Pro",
                        "status": "异常",
                        "quota": 3,
                    },
                ],
            ),
            mock.patch.object(openai_v1_models, "OpenAIBackendAPI", return_value=backend),
        ):
            result = openai_v1_models.list_models()

        self.assertEqual(result["data"], [])

    def test_list_models_function(self):
        """测试直接调用服务层获取模型列表。"""
        result = openai_v1_models.list_models()
        print("function result:")
        print(json.dumps(result, ensure_ascii=False, indent=2))

    @live_http_test
    def test_list_models_http(self):
        """测试通过 HTTP 接口获取模型列表。"""
        response = requests.get(
            f"{BASE_URL}/v1/models",
            headers={"Authorization": f"Bearer {AUTH_KEY}"},
            timeout=30,
        )
        assert_http_ok(self, response)
        print("http status:")
        print(response.status_code)
        print("http result:")
        print(json.dumps(response.json(), ensure_ascii=False, indent=2))
