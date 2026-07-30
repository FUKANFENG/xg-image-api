from __future__ import annotations

import unittest
from unittest.mock import patch

from api import accounts as accounts_api


def endpoint_for(path: str, method: str):
    router = accounts_api.create_router()
    return next(route.endpoint for route in router.routes if route.path == path and method in route.methods)


class UserAccountsApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_creates_password_user_without_returning_a_key(self) -> None:
        endpoint = endpoint_for("/api/auth/users", "POST")
        created = {
            "id": "user-1",
            "name": "设计同学 A",
            "username": "designer.a",
            "role": "user",
            "enabled": True,
            "image_quota": 10,
            "image_quota_used": 0,
            "password_configured": True,
            "legacy_key_enabled": False,
            "created_at": "2026-01-01T00:00:00+00:00",
            "last_used_at": None,
        }
        body = accounts_api.UserAccountCreateRequest(
            username="designer.a",
            password="safe-password-123",
            name="设计同学 A",
            image_quota=10,
        )

        with (
            patch.object(accounts_api, "require_admin"),
            patch.object(accounts_api.auth_service, "create_user", return_value=created) as create_user,
            patch.object(accounts_api.auth_service, "list_users", return_value=[created]),
        ):
            result = await endpoint(body, authorization=None)

        self.assertEqual(result["item"], created)
        self.assertEqual(result["items"], [created])
        self.assertNotIn("key", result)
        create_user.assert_called_once_with(
            username="designer.a",
            password="safe-password-123",
            name="设计同学 A",
            image_quota=10,
        )


if __name__ == "__main__":
    unittest.main()
