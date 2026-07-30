from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from api.app import create_app
import api.support as support_module
import api.system as system_module


class FakeAuthService:
    def authenticate_password(self, username: str, password: str):
        if username == "designer.a" and password == "safe-password-123":
            return {
                "id": "user-1",
                "name": "设计同学 A",
                "role": "user",
                "image_quota": 3,
                "session_version": 1,
            }
        return None

    def create_session(self, identity):
        return f"session-for-{identity['id']}"

    def authenticate_session(self, token: str):
        if token == "session-for-user-1":
            return {
                "id": "user-1",
                "name": "设计同学 A",
                "role": "user",
                "image_quota": 3,
                "session_version": 1,
            }
        return None

    def authenticate_key(self, _token: str):
        return None


class RegisteringFakeAuthService(FakeAuthService):
    def __init__(self) -> None:
        self.created: list[dict[str, object]] = []

    def create_user(self, *, username: str, password: str, name: str, image_quota: int):
        self.created.append(
            {
                "username": username,
                "password": password,
                "name": name,
                "image_quota": image_quota,
            }
        )
        return {
            "id": "registered-user-1",
            "name": name or username,
            "username": username,
            "role": "user",
            "enabled": True,
            "image_quota": image_quota,
        }

    def authenticate_password(self, username: str, password: str):
        if username == "new.user" and password == "safe-password-456":
            return {
                "id": "registered-user-1",
                "name": "新用户",
                "role": "user",
                "image_quota": self.created[-1]["image_quota"] if self.created else 0,
                "session_version": 1,
            }
        return super().authenticate_password(username, password)


class PasswordLoginApiTests(unittest.TestCase):
    def setUp(self) -> None:
        system_module._login_attempts.clear()
        system_module._registration_attempts.clear()
        self.app = FastAPI()
        self.app.include_router(system_module.create_router("test"))
        self.client = TestClient(self.app)

    def test_password_login_sets_http_only_session_cookie(self) -> None:
        with mock.patch.object(system_module, "auth_service", FakeAuthService()):
            response = self.client.post(
                "/auth/login",
                json={"username": "designer.a", "password": "safe-password-123"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["role"], "user")
        self.assertEqual(response.json()["image_quota"], 3)
        cookie = response.headers.get("set-cookie", "")
        self.assertIn("chatgpt2api_session=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=lax", cookie)

    def test_session_probe_returns_anonymous_state_without_console_error_status(self) -> None:
        with mock.patch.object(support_module, "auth_service", FakeAuthService()):
            response = self.client.post("/auth/session")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {"ok": False, "authenticated": False, "version": "test"},
        )

    def test_password_login_returns_generic_error_for_invalid_credentials(self) -> None:
        with mock.patch.object(system_module, "auth_service", FakeAuthService()):
            response = self.client.post(
                "/auth/login",
                json={"username": "designer.a", "password": "wrong-password"},
            )

        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.json()["detail"]["error"], "账号或密码错误")

    def test_separate_login_endpoints_enforce_the_expected_role(self) -> None:
        fake_auth = FakeAuthService()
        admin_identity = {"id": "admin", "name": "管理员", "role": "admin", "session_version": 1}

        def admin_identity_for(username: str, password: str):
            return admin_identity if username == "admin" and password == "admin-password" else None

        with (
            mock.patch.object(system_module, "auth_service", fake_auth),
            mock.patch.object(system_module, "_admin_password_identity", side_effect=admin_identity_for),
        ):
            user_response = self.client.post(
                "/auth/user-login",
                json={"username": "designer.a", "password": "safe-password-123"},
            )
            admin_response = self.client.post(
                "/auth/admin-login",
                json={"username": "admin", "password": "admin-password"},
            )
            user_at_admin_response = self.client.post(
                "/auth/admin-login",
                json={"username": "designer.a", "password": "safe-password-123"},
            )
            admin_at_user_response = self.client.post(
                "/auth/user-login",
                json={"username": "admin", "password": "admin-password"},
            )

        self.assertEqual(user_response.status_code, 200, user_response.text)
        self.assertEqual(user_response.json()["role"], "user")
        self.assertEqual(admin_response.status_code, 200, admin_response.text)
        self.assertEqual(admin_response.json()["role"], "admin")
        self.assertEqual(user_at_admin_response.status_code, 401, user_at_admin_response.text)
        self.assertEqual(admin_at_user_response.status_code, 401, admin_at_user_response.text)

    def test_http_only_cookie_authenticates_follow_up_requests(self) -> None:
        fake_auth = FakeAuthService()
        app = create_app()
        client = TestClient(app)

        with (
            mock.patch.object(system_module, "auth_service", fake_auth),
            mock.patch.object(support_module, "auth_service", fake_auth),
        ):
            login_response = client.post(
                "/auth/login",
                json={"username": "designer.a", "password": "safe-password-123"},
            )
            session_response = client.post("/auth/session")

        self.assertEqual(login_response.status_code, 200, login_response.text)
        self.assertEqual(session_response.status_code, 200, session_response.text)
        self.assertEqual(session_response.json()["subject_id"], "user-1")

    def test_public_registration_creates_a_one_hundred_quota_user_and_logs_them_in(self) -> None:
        fake_auth = RegisteringFakeAuthService()

        with mock.patch.object(system_module, "auth_service", fake_auth):
            response = self.client.post(
                "/auth/register",
                json={"username": "new.user", "password": "safe-password-456", "name": "新用户"},
            )

        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["role"], "user")
        self.assertEqual(response.json()["image_quota"], 100)
        self.assertNotIn("password", response.json())
        self.assertEqual(fake_auth.created, [{"username": "new.user", "password": "safe-password-456", "name": "新用户", "image_quota": 100}])
        self.assertIn("HttpOnly", response.headers.get("set-cookie", ""))

    def test_public_registration_is_rate_limited_per_source(self) -> None:
        request = Request(
            {
                "type": "http",
                "method": "POST",
                "scheme": "http",
                "path": "/auth/register",
                "query_string": b"",
                "headers": [],
                "client": ("192.0.2.10", 4312),
                "server": ("testserver", 80),
            }
        )

        for _ in range(system_module._REGISTRATION_ATTEMPT_LIMIT):
            system_module._consume_registration_attempt(request)

        with self.assertRaises(HTTPException) as context:
            system_module._consume_registration_attempt(request)
        self.assertEqual(context.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
