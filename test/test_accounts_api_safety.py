from __future__ import annotations

import unittest
from unittest.mock import patch

from api import accounts as accounts_api


def endpoint_for(path: str, method: str):
    router = accounts_api.create_router()
    return next(
        route.endpoint
        for route in router.routes
        if route.path == path and method in route.methods
    )


async def execute_in_threadpool(func, *args):
    return func(*args)


class AccountsApiSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_account_list_does_not_expose_refresh_or_login_secrets(self) -> None:
        endpoint = endpoint_for("/api/accounts", "GET")
        account = {
            "access_token": "access-visible-for-existing-ui",
            "refresh_token": "refresh-secret",
            "id_token": "id-secret",
            "password": "password-secret",
            "session_id": "session-secret",
            "cookies": {"session": "cookie-secret"},
            "fp": {"oai-session-id": "fingerprint-session-secret"},
            "status": "正常",
        }

        with (
            patch.object(accounts_api, "require_admin"),
            patch.object(accounts_api.account_service, "list_accounts", return_value=[account]),
        ):
            result = await endpoint(authorization=None)

        [item] = result["items"]
        self.assertEqual(item["access_token"], "access-visible-for-existing-ui")
        for field in ("refresh_token", "id_token", "password", "session_id", "cookies", "fp"):
            self.assertNotIn(field, item)

    async def test_account_import_runs_storage_and_refresh_work_in_threadpool(self) -> None:
        endpoint = endpoint_for("/api/accounts", "POST")
        threadpool_functions = []

        async def tracked_threadpool(func, *args):
            threadpool_functions.append(func)
            return func(*args)

        with (
            patch.object(accounts_api, "require_admin"),
            patch.object(
                accounts_api.account_service,
                "add_accounts",
                return_value={"added": 1, "skipped": 0, "items": []},
            ) as add_accounts,
            patch.object(
                accounts_api.account_service,
                "refresh_accounts",
                return_value={"refreshed": 1, "errors": [], "items": []},
            ) as refresh_accounts,
            patch.object(accounts_api, "run_in_threadpool", side_effect=tracked_threadpool),
        ):
            result = await endpoint(
                accounts_api.AccountCreateRequest(tokens=["token-1"]),
                authorization=None,
            )

        self.assertEqual(result["refreshed"], 1)
        self.assertEqual(threadpool_functions, [add_accounts, refresh_accounts])

    async def test_oauth_finish_log_never_contains_callback_code(self) -> None:
        endpoint = endpoint_for("/api/accounts/oauth/finish", "POST")
        callback_secret = "code=oauth-code-must-not-appear"

        with (
            patch.object(accounts_api, "require_admin"),
            patch.object(accounts_api, "run_in_threadpool", side_effect=execute_in_threadpool),
            patch.object(
                accounts_api.oauth_login_service,
                "finish",
                return_value={
                    "access_token": "access-token",
                    "refresh_token": "refresh-token",
                    "id_token": "id-token",
                },
            ),
            patch.object(
                accounts_api.account_service,
                "add_account_items",
                return_value={"added": 1, "skipped": 0, "items": []},
            ),
            patch.object(
                accounts_api.account_service,
                "refresh_accounts",
                return_value={"refreshed": 1, "errors": [], "items": []},
            ),
            patch("builtins.print") as output,
        ):
            await endpoint(
                accounts_api.OAuthLoginFinishRequest(
                    session_id="session-12345678",
                    callback=f"https://localhost/callback?{callback_secret}",
                ),
                authorization=None,
            )

        rendered_logs = " ".join(str(call) for call in output.call_args_list)
        self.assertNotIn(callback_secret, rendered_logs)


if __name__ == "__main__":
    unittest.main()
