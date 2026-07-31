from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.account_service import AccountService
from services.auth_service import AuthService
from services.config import config
from services.openai_backend_api import InvalidAccessTokenError
from services.storage.json_storage import JSONStorageBackend
from utils.helper import anonymize_token, split_image_model


class AccountCapabilityTests(unittest.TestCase):
    def test_image_account_reference_survives_access_token_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [{
                    "access_token": "old-secret-token",
                    "account_id": "account-stable-id",
                    "email": "artist@example.test",
                    "status": "正常",
                    "quota": 3,
                }]
            )

            account_ref = service.image_account_reference("old-secret-token")
            rotated_token = service._apply_refreshed_tokens(
                "old-secret-token",
                {"access_token": "new-secret-token", "refresh_token": "refresh-secret"},
                "test",
            )

            self.assertTrue(account_ref.startswith("acct_"))
            self.assertNotIn("account-stable-id", account_ref)
            self.assertNotIn("artist@example.test", account_ref)
            self.assertNotIn("secret-token", account_ref)
            self.assertEqual(rotated_token, "new-secret-token")
            self.assertEqual(service.resolve_image_access_token(account_ref), "new-secret-token")

    def test_disabled_image_account_reference_does_not_resolve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [{
                    "access_token": "disabled-token",
                    "account_id": "disabled-account",
                    "status": "禁用",
                    "quota": 3,
                }]
            )

            account_ref = service.image_account_reference("disabled-token")

            self.assertTrue(account_ref)
            self.assertEqual(service.resolve_image_access_token(account_ref), "")

    def test_ambiguous_email_reference_never_selects_an_arbitrary_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([
                {
                    "access_token": "first-token",
                    "email": "shared@example.test",
                    "status": "正常",
                    "quota": 3,
                },
                {
                    "access_token": "second-token",
                    "email": "shared@example.test",
                    "status": "正常",
                    "quota": 3,
                },
            ])

            account_ref = service.image_account_reference("first-token")

            self.assertTrue(account_ref)
            self.assertEqual(service.resolve_image_access_token(account_ref), "")

    def test_image_accounts_require_positive_quota(self) -> None:
        self.assertFalse(
            AccountService._is_image_account_available(
                {"status": "限流", "quota": 1}
            )
        )
        self.assertFalse(
            AccountService._is_image_account_available(
                {"status": "正常", "quota": 0}
            )
        )
        self.assertTrue(AccountService._is_image_account_available({"status": "正常", "quota": 1}))

    def test_prolite_variants_are_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertEqual(service._normalize_account_type("prolite"), "ProLite")
            self.assertEqual(service._normalize_account_type("pro_lite"), "ProLite")

    def test_search_account_type_ignores_unrelated_scalar_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertIsNone(
                service._search_account_type(
                    {
                        "amr": ["pwd", "otp", "mfa"],
                        "chatgpt_compute_residency": "no_constraint",
                        "chatgpt_data_residency": "no_constraint",
                        "user_id": "user-I52GFfLGFM0dokFk2dBiKEBn",
                    }
                )
            )

    def test_mark_image_result_consumes_quota(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1"])
            service.update_account(
                "token-1",
                {
                    "status": "正常",
                    "quota": 1,
                },
            )

            updated = service.mark_image_result("token-1", success=True)

            self.assertIsNotNone(updated)
            self.assertEqual(updated["quota"], 0)
            self.assertEqual(updated["status"], "限流")

    def test_usage_limit_marks_account_unavailable_and_selects_next_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [
                    {"access_token": "limited-token", "status": "正常", "quota": 9, "source_type": "codex"},
                    {"access_token": "healthy-token", "status": "正常", "quota": 9, "source_type": "codex"},
                ]
            )
            service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)

            with patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}):
                selected = service.get_available_access_token(source_type="codex")
                updated = service.mark_image_usage_limited(selected, resets_at=1_800_000_000)
                next_token = service.get_available_access_token(source_type="codex")
                service.release_image_slot(next_token)

            self.assertEqual(selected, "limited-token")
            self.assertIsNotNone(updated)
            self.assertEqual(updated["status"], "限流")
            self.assertEqual(updated["quota"], 0)
            self.assertEqual(
                updated["restore_at"],
                datetime.fromtimestamp(1_800_000_000, timezone.utc).isoformat(),
            )
            self.assertEqual(next_token, "healthy-token")

    def test_split_image_model_supports_plan_type_prefix(self) -> None:
        self.assertEqual(split_image_model("gpt-image-2"), (None, "gpt-image-2"))
        self.assertEqual(split_image_model("plus-codex-gpt-image-2"), ("plus", "codex-gpt-image-2"))
        self.assertEqual(split_image_model("team-codex-gpt-image-2"), ("team", "codex-gpt-image-2"))
        self.assertEqual(split_image_model("pro-codex-gpt-image-2"), ("pro", "codex-gpt-image-2"))
        self.assertEqual(split_image_model("plus-gpt-image-2"), (None, None))
        self.assertEqual(split_image_model("unknown-image-model"), (None, None))

    def test_get_available_access_token_filters_by_plan_type(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [
                    {"access_token": "token-plus", "type": "Plus", "status": "正常", "quota": 3},
                    {"access_token": "token-pro", "type": "Pro", "status": "正常", "quota": 3},
                ]
            )

            service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)

            plus_token = service.get_available_access_token(plan_type="plus")
            pro_token = service.get_available_access_token(plan_type="pro")
            service.release_image_slot(plus_token)
            service.release_image_slot(pro_token)

            self.assertEqual(plus_token, "token-plus")
            self.assertEqual(pro_token, "token-pro")

    def test_codex_oauth_account_also_supports_web_images_but_not_the_reverse(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            codex_service = AccountService(JSONStorageBackend(Path(tmp_dir) / "codex-accounts.json"))
            codex_service.add_account_items(
                [{
                    "access_token": "codex-token",
                    "source_type": "codex",
                    "type": "Pro",
                    "status": "正常",
                    "quota": 3,
                }]
            )
            codex_service.fetch_remote_info = (
                lambda access_token, event="fetch_remote_info": codex_service.get_account(access_token)
            )

            web_token = codex_service.get_available_access_token(source_type="web")
            codex_service.release_image_slot(web_token)
            self.assertEqual(web_token, "codex-token")

            web_service = AccountService(JSONStorageBackend(Path(tmp_dir) / "web-accounts.json"))
            web_service.add_account_items(
                [{
                    "access_token": "web-token",
                    "source_type": "web",
                    "type": "Plus",
                    "status": "正常",
                    "quota": 3,
                }]
            )
            with self.assertRaisesRegex(RuntimeError, "no available codex image quota"):
                web_service.get_available_access_token(source_type="codex")

    def test_get_available_access_token_reports_preflight_failure_instead_of_quota_exhaustion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [
                    {"access_token": "token-one", "status": "正常", "quota": 3},
                    {"access_token": "token-two", "status": "正常", "quota": 3},
                ]
            )

            def timeout_preflight(_access_token: str, _event: str = "fetch_remote_info") -> None:
                raise TimeoutError("simulated account preflight timeout")

            service.fetch_remote_info = timeout_preflight

            with self.assertRaisesRegex(RuntimeError, "image account precheck failed") as raised:
                service.get_available_access_token()

            self.assertIn("timeout", str(raised.exception).lower())

    def test_get_available_access_token_reuses_recent_preflight_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [{"access_token": "token-one", "status": "正常", "quota": 3}]
            )
            preflight_calls: list[str] = []

            def verify_account(access_token: str, _event: str = "fetch_remote_info") -> dict | None:
                preflight_calls.append(access_token)
                return service.get_account(access_token)

            service.fetch_remote_info = verify_account

            first = service.get_available_access_token()
            service.release_image_slot(first)
            second = service.get_available_access_token()
            service.release_image_slot(second)

            self.assertEqual(first, "token-one")
            self.assertEqual(second, "token-one")
            self.assertEqual(preflight_calls, ["token-one"])

    def test_failed_image_attempt_invalidates_recent_preflight_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [{"access_token": "token-one", "status": "正常", "quota": 3}]
            )
            preflight_calls: list[str] = []

            def verify_account(access_token: str, _event: str = "fetch_remote_info") -> dict | None:
                preflight_calls.append(access_token)
                return service.get_account(access_token)

            service.fetch_remote_info = verify_account

            first = service.get_available_access_token()
            service.mark_image_result(first, success=False)
            second = service.get_available_access_token()
            service.release_image_slot(second)

            self.assertEqual(second, "token-one")
            self.assertEqual(preflight_calls, ["token-one", "token-one"])

    def test_authenticated_server_error_keeps_recent_preflight_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([{"access_token": "token-one", "status": "正常", "quota": 3}])
            preflight_calls: list[str] = []

            def verify_account(access_token: str, _event: str = "fetch_remote_info") -> dict | None:
                preflight_calls.append(access_token)
                return service.get_account(access_token)

            service.fetch_remote_info = verify_account
            first = service.get_available_access_token()
            service.mark_image_result(
                first,
                success=False,
                error_kind="server_error",
                invalidate_preflight=False,
            )
            second = service.get_available_access_token()
            service.release_image_slot(second)

            self.assertEqual(second, "token-one")
            self.assertEqual(preflight_calls, ["token-one"])

    def test_zero_preflight_cache_ttl_disables_an_existing_cache_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [{"access_token": "token-one", "status": "正常", "quota": 3}]
            )
            preflight_calls: list[str] = []

            def verify_account(access_token: str, _event: str = "fetch_remote_info") -> dict | None:
                preflight_calls.append(access_token)
                return service.get_account(access_token)

            service.fetch_remote_info = verify_account

            with patch.dict(config.data, {"image_account_preflight_cache_secs": 180}):
                first = service.get_available_access_token()
                service.release_image_slot(first)
            with patch.dict(config.data, {"image_account_preflight_cache_secs": 0}):
                second = service.get_available_access_token()
                service.release_image_slot(second)

            self.assertEqual(second, "token-one")
            self.assertEqual(preflight_calls, ["token-one", "token-one"])

    def test_image_scheduler_prefers_lower_predicted_finish_until_fast_account_is_full(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [
                    {
                        "access_token": "fast-token",
                        "status": "正常",
                        "quota": 5,
                        "image_latency_ema_ms": 30_000,
                        "image_latency_samples": 4,
                    },
                    {
                        "access_token": "slow-token",
                        "status": "正常",
                        "quota": 5,
                        "image_latency_ema_ms": 100_000,
                        "image_latency_samples": 4,
                    },
                ]
            )

            first = service._acquire_next_candidate_token()
            second = service._acquire_next_candidate_token()
            third = service._acquire_next_candidate_token()

            try:
                self.assertEqual(first, "fast-token")
                self.assertEqual(second, "fast-token")
                self.assertEqual(third, "slow-token")
            finally:
                service.release_image_slot(first)
                service.release_image_slot(second)
                service.release_image_slot(third)

    def test_image_scheduler_penalizes_consecutive_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items(
                [
                    {
                        "access_token": "fast-but-failing",
                        "status": "正常",
                        "quota": 5,
                        "image_latency_ema_ms": 30_000,
                        "image_latency_samples": 4,
                        "image_consecutive_failures": 2,
                    },
                    {
                        "access_token": "reliable-token",
                        "status": "正常",
                        "quota": 5,
                        "image_latency_ema_ms": 50_000,
                        "image_latency_samples": 4,
                    },
                ]
            )

            selected = service._acquire_next_candidate_token()

            try:
                self.assertEqual(selected, "reliable-token")
            finally:
                service.release_image_slot(selected)

    def test_mark_image_result_tracks_ema_and_resets_failure_streak(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([{"access_token": "token-1", "status": "正常", "quota": 5}])

            failed = service.mark_image_result("token-1", success=False, elapsed_ms=50_000)
            first_success = service.mark_image_result("token-1", success=True, elapsed_ms=10_000)
            second_success = service.mark_image_result("token-1", success=True, elapsed_ms=30_000)

            self.assertIsNotNone(failed)
            self.assertEqual(failed["image_consecutive_failures"], 1)
            self.assertIsNotNone(first_success)
            self.assertEqual(first_success["image_latency_ema_ms"], 10_000)
            self.assertEqual(first_success["image_latency_samples"], 1)
            self.assertIsNotNone(second_success)
            self.assertEqual(second_success["image_latency_ema_ms"], 17_000)
            self.assertEqual(second_success["image_consecutive_failures"], 0)

    def test_image_runtime_health_exposes_success_rate_duration_and_score(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([
                {
                    "access_token": "healthy-token",
                    "email": "healthy@example.test",
                    "status": "正常",
                    "quota": 5,
                    "success": 8,
                    "fail": 2,
                    "image_latency_ema_ms": 12_500,
                    "image_consecutive_failures": 0,
                }
            ])

            account = service.image_runtime_health()["accounts"][0]

            self.assertEqual(account["success_count"], 8)
            self.assertEqual(account["failure_count"], 2)
            self.assertEqual(account["success_rate"], 80.0)
            self.assertEqual(account["average_duration_secs"], 12.5)
            self.assertEqual(account["health_score"], 80.0)
            self.assertEqual(account["health_level"], "healthy")

    def test_image_slot_wait_honors_request_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([{"access_token": "token-1", "status": "正常", "quota": 5}])
            with patch.dict(config.data, {"image_account_concurrency": 1}):
                first = service._acquire_next_candidate_token()
                try:
                    with self.assertRaisesRegex(TimeoutError, "slot wait timed out"):
                        service._acquire_next_candidate_token(deadline_monotonic=time.monotonic() + 0.05)
                finally:
                    service.release_image_slot(first)

    def test_image_performance_history_backfills_legacy_accounts_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            storage = JSONStorageBackend(Path(tmp_dir) / "accounts.json")
            storage.save_accounts(
                [
                    {
                        "access_token": "legacy-token",
                        "email": "fast@example.test",
                        "status": "正常",
                        "quota": 5,
                    }
                ]
            )
            history_path = Path(tmp_dir) / "logs.jsonl"
            history_path.write_text(
                json.dumps(
                    {
                        "type": "call",
                        "detail": {
                            "status": "success",
                            "endpoint": "/v1/images/generations",
                            "account_email": "fast@example.test",
                            "duration_ms": 30_000,
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            with patch("services.account_service.log_service.path", history_path):
                service = AccountService(storage)

            account = service.get_account("legacy-token")
            self.assertIsNotNone(account)
            self.assertEqual(account["image_latency_ema_ms"], 30_000)
            self.assertEqual(account["image_latency_samples"], 1)
            self.assertEqual(account["image_performance_version"], 1)

    def test_refresh_accounts_never_removes_token_on_first_invalid_response(self) -> None:
        original_value = config.data.get("auto_remove_invalid_accounts")
        config.data["auto_remove_invalid_accounts"] = True
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
                service.add_account_items([{"access_token": "invalid-token", "status": "正常"}])

                with patch(
                    "services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                    side_effect=InvalidAccessTokenError("token invalidated (/backend-api/me)"),
                ):
                    result = service.refresh_accounts(["invalid-token"], defer_invalid_removal=False)

                self.assertEqual(result["refreshed"], 0)
                self.assertEqual(len(result["errors"]), 1)
                account = service.get_account("invalid-token")
                self.assertIsNotNone(account)
                self.assertEqual(account["invalid_count"], 1)
                self.assertEqual(len(result["items"]), 1)
        finally:
            if original_value is None:
                config.data.pop("auto_remove_invalid_accounts", None)
            else:
                config.data["auto_remove_invalid_accounts"] = original_value

    def test_refresh_accounts_defers_invalid_token_removal_by_default(self) -> None:
        original_value = config.data.get("auto_remove_invalid_accounts")
        config.data["auto_remove_invalid_accounts"] = True
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
                service.add_account_items([{"access_token": "invalid-token", "status": "正常"}])

                with patch(
                    "services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                    side_effect=InvalidAccessTokenError("token invalidated (/backend-api/me)"),
                ):
                    result = service.refresh_accounts(["invalid-token"])

                account = service.get_account("invalid-token")
                self.assertEqual(result["refreshed"], 0)
                self.assertEqual(len(result["errors"]), 1)
                self.assertIsNotNone(account)
                self.assertEqual(account["invalid_count"], 1)
        finally:
            if original_value is None:
                config.data.pop("auto_remove_invalid_accounts", None)
            else:
                config.data["auto_remove_invalid_accounts"] = original_value

    def test_repeated_invalid_token_within_confirm_window_is_confirmed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([{
                "access_token": "invalid-token",
                "status": "正常",
                "created_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
            }])

            first_confirmed = service._record_invalid_token_seen(
                "invalid-token",
                "test",
                "token invalidated (/backend-api/me)",
            )
            second_confirmed = service._record_invalid_token_seen(
                "invalid-token",
                "test",
                "token invalidated (/backend-api/me)",
            )

            self.assertFalse(first_confirmed)
            self.assertTrue(second_confirmed)
            account = service.get_account("invalid-token")
            self.assertIsNotNone(account)
            self.assertEqual(account["invalid_count"], 2)

    def test_preflight_failure_classifies_invalidated_token_as_auth_rejection(self) -> None:
        self.assertEqual(
            AccountService._describe_image_preflight_failure(
                InvalidAccessTokenError("token invalidated (/backend-api/me)")
            ),
            "remote account authentication was rejected",
        )


class TokenLogTests(unittest.TestCase):
    def test_anonymize_token_hides_raw_value(self) -> None:
        token = "super-secret-token"
        token_ref = anonymize_token(token)

        self.assertTrue(token_ref.startswith("token:"))
        self.assertNotIn(token, token_ref)


class AuthServiceTests(unittest.TestCase):
    def test_create_authenticate_disable_and_delete_user_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))

            item, raw_key = service.create_key(role="user", name="Alice")

            self.assertEqual(item["role"], "user")
            self.assertEqual(item["name"], "Alice")
            self.assertTrue(item["enabled"])
            self.assertTrue(raw_key.startswith("sk-"))

            authed = service.authenticate(raw_key)
            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertEqual(authed["role"], "user")
            self.assertIsNotNone(authed["last_used_at"])

            updated = service.update_key(item["id"], {"enabled": False}, role="user")
            self.assertIsNotNone(updated)
            self.assertFalse(updated["enabled"])
            self.assertIsNone(service.authenticate(raw_key))

            self.assertTrue(service.delete_key(item["id"], role="user"))
            self.assertFalse(service.delete_key(item["id"], role="user"))
            self.assertEqual(service.list_keys(role="user"), [])

    def test_authenticate_ignores_last_used_save_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, raw_key = service.create_key(role="user", name="Alice")

            def fail_save() -> None:
                raise OSError("disk unavailable")

            service._save = fail_save

            authed = service.authenticate(raw_key)

            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertIsNotNone(authed["last_used_at"])

    def test_update_user_key_replaces_raw_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, raw_key = service.create_key(role="user", name="Alice")

            updated = service.update_key(item["id"], {"key": "sk-user-custom-key"}, role="user")

            self.assertIsNotNone(updated)
            self.assertIsNone(service.authenticate(raw_key))

            authed = service.authenticate("sk-user-custom-key")
            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])

    def test_user_key_name_must_be_unique(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            first, _ = service.create_key(role="user", name="Alice")
            second, _ = service.create_key(role="user", name="Bob")

            with self.assertRaisesRegex(ValueError, "这个名称已经在使用中了"):
                service.create_key(role="user", name="Alice")

            with self.assertRaisesRegex(ValueError, "这个名称已经在使用中了"):
                service.update_key(second["id"], {"name": "Alice"}, role="user")

            updated = service.update_key(first["id"], {"name": "Alice"}, role="user")
            self.assertIsNotNone(updated)
            self.assertEqual(updated["name"], "Alice")


if __name__ == "__main__":
    unittest.main()
