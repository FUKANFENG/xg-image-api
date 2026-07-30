from __future__ import annotations

import base64
import json
import unittest
from typing import Any
from unittest.mock import Mock, patch

from services.account_service import AccountService


class MemoryStorage:
    def load_accounts(self) -> list[dict[str, Any]]:
        return []

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        pass

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return []

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        pass

    def health_check(self) -> dict[str, Any]:
        return {"ok": True}

    def get_backend_info(self) -> dict[str, Any]:
        return {"type": "memory"}


def make_jwt(payload: dict[str, Any]) -> str:
    def encode(value: dict[str, Any]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return f'{encode({"alg": "none", "typ": "JWT"})}.{encode(payload)}.sig'


class AccountOAuthRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = AccountService(MemoryStorage())

    def test_codex_id_token_audience_selects_codex_client(self) -> None:
        account = {
            "id_token": make_jwt({"aud": AccountService._CODEX_OAUTH_CLIENT_ID}),
        }

        client_id = self.service._oauth_client_id_for_account(account)

        self.assertEqual(client_id, AccountService._CODEX_OAUTH_CLIENT_ID)

    def test_known_explicit_client_id_takes_precedence(self) -> None:
        account = {
            "oauth_client_id": AccountService._CODEX_OAUTH_CLIENT_ID,
            "id_token": make_jwt({"aud": AccountService._OAUTH_CLIENT_ID}),
        }

        client_id = self.service._oauth_client_id_for_account(account)

        self.assertEqual(client_id, AccountService._CODEX_OAUTH_CLIENT_ID)

    def test_unknown_client_ids_fall_back_to_platform_client(self) -> None:
        account = {
            "oauth_client_id": "unknown-client",
            "id_token": make_jwt({"aud": ["another-unknown-client"]}),
        }

        client_id = self.service._oauth_client_id_for_account(account)

        self.assertEqual(client_id, AccountService._OAUTH_CLIENT_ID)

    def test_refresh_request_uses_client_selected_from_account(self) -> None:
        response = Mock(status_code=200, text="response-body")
        response.json.return_value = {"access_token": "new-access-token"}
        session = Mock()
        session.post.return_value = response
        account = {
            "id_token": make_jwt({"aud": AccountService._CODEX_OAUTH_CLIENT_ID}),
        }

        with (
            patch("curl_cffi.requests.Session", return_value=session),
            patch(
                "services.proxy_service.proxy_settings.build_session_kwargs",
                return_value={},
            ),
        ):
            result = self.service._request_access_token_refresh("refresh-token", account)

        self.assertEqual(result["access_token"], "new-access-token")
        self.assertEqual(
            session.post.call_args.kwargs["data"]["client_id"],
            AccountService._CODEX_OAUTH_CLIENT_ID,
        )
        session.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
