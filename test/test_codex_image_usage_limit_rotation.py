from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

import services.protocol.conversation as conversation
from services.account_service import AccountService
from services.config import config
from services.storage.json_storage import JSONStorageBackend
from utils.helper import UpstreamHTTPError


_ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlCFrYAAAAASUVORK5CYII="


class CodexUsageLimitRotationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.storage_patcher = patch.object(
            conversation,
            "save_image_bytes",
            return_value="http://testserver/images/fake.png",
        )
        self.storage_patcher.start()
        self.addCleanup(self.storage_patcher.stop)

    def test_codex_rejection_is_reported_as_content_policy_without_penalizing_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([{
                "access_token": "policy-token",
                "status": "正常",
                "quota": 9,
                "source_type": "codex",
                "type": "Plus",
            }])
            service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)

            class FakeCodexBackend:
                def __init__(self, access_token: str) -> None:
                    self.access_token = access_token

                def iter_codex_image_response_events(self, **_kwargs):
                    yield {
                        "type": "response.output_item.added",
                        "item": {"id": "ig-policy", "type": "image_generation_call", "status": "in_progress"},
                    }
                    yield {
                        "type": "response.output_text.delta",
                        "delta": "Sorry, I can't generate that image because the request was rejected",
                    }
                    yield {
                        "type": "response.output_text.done",
                        "text": "Sorry, I can't generate that image because the request was rejected.",
                    }

                def close(self) -> None:
                    pass

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", FakeCodexBackend),
                patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}),
            ):
                with self.assertRaises(conversation.ImageGenerationError) as raised:
                    list(conversation.stream_image_outputs_with_pool(
                        conversation.ConversationRequest(model="codex-gpt-image-2", prompt="policy test")
                    ))

            account = service.get_account("policy-token")
            self.assertEqual(raised.exception.code, "content_policy_violation")
            self.assertIn("安全策略", str(raised.exception))
            self.assertIsNotNone(account)
            self.assertEqual(account["status"], "正常")
            self.assertEqual(account["quota"], 9)
            self.assertEqual(account["image_consecutive_failures"], 0)

    def test_usage_limit_rotates_to_next_codex_account_before_failing_request(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([
                {
                    "access_token": "limited-token",
                    "status": "正常",
                    "quota": 9,
                    "source_type": "codex",
                    "type": "Plus",
                },
                {
                    "access_token": "healthy-token",
                    "status": "正常",
                    "quota": 9,
                    "source_type": "codex",
                    "type": "Plus",
                },
            ])
            service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)

            class FakeCodexBackend:
                attempted_tokens: list[str] = []

                def __init__(self, access_token: str) -> None:
                    self.access_token = access_token
                    self.attempted_tokens.append(access_token)

                def iter_codex_image_response_events(self, **_kwargs):
                    if self.access_token == "limited-token":
                        raise UpstreamHTTPError(
                            "/backend-api/codex/responses",
                            429,
                            {"error": {"type": "usage_limit_reached", "resets_at": 1_800_000_000}},
                        )
                    yield {
                        "type": "image_generation_call",
                        "result": f"data:image/png;base64,{_ONE_PIXEL_PNG}",
                    }

                def close(self) -> None:
                    pass

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", FakeCodexBackend),
                patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}),
            ):
                outputs = list(conversation.stream_image_outputs_with_pool(
                    conversation.ConversationRequest(model="codex-gpt-image-2", prompt="draw a square")
                ))

            limited = service.get_account("limited-token")
            healthy = service.get_account("healthy-token")
            self.assertEqual(FakeCodexBackend.attempted_tokens, ["limited-token", "healthy-token"])
            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0].kind, "result")
            self.assertEqual(outputs[0].data[0]["b64_json"], _ONE_PIXEL_PNG)
            self.assertIsNotNone(limited)
            self.assertEqual(limited["status"], "限流")
            self.assertEqual(limited["quota"], 0)
            self.assertEqual(
                limited["restore_at"],
                datetime.fromtimestamp(1_800_000_000, timezone.utc).isoformat(),
            )
            self.assertIsNotNone(healthy)
            self.assertEqual(healthy["status"], "正常")
            self.assertEqual(healthy["quota"], 8)

    def test_other_429_response_does_not_quarantine_the_codex_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([{
                "access_token": "temporarily-limited-token",
                "status": "正常",
                "quota": 9,
                "source_type": "codex",
                "type": "Plus",
            }])
            service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)

            class FakeCodexBackend:
                def __init__(self, access_token: str) -> None:
                    self.access_token = access_token

                def iter_codex_image_response_events(self, **_kwargs):
                    raise UpstreamHTTPError(
                        "/backend-api/codex/responses",
                        429,
                        {"error": {"type": "rate_limit_exceeded", "resets_at": 1_800_000_000}},
                    )

                def close(self) -> None:
                    pass

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", FakeCodexBackend),
                patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}),
            ):
                with self.assertRaises(conversation.ImageGenerationError):
                    list(conversation.stream_image_outputs_with_pool(
                        conversation.ConversationRequest(model="codex-gpt-image-2", prompt="draw a square")
                    ))

            account = service.get_account("temporarily-limited-token")
            self.assertIsNotNone(account)
            self.assertEqual(account["status"], "正常")
            self.assertEqual(account["quota"], 9)
            self.assertEqual(account["fail"], 1)

    def test_empty_codex_result_rotates_to_next_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([
                {
                    "access_token": "empty-token",
                    "status": "正常",
                    "quota": 9,
                    "source_type": "codex",
                    "type": "Plus",
                },
                {
                    "access_token": "healthy-token",
                    "status": "正常",
                    "quota": 9,
                    "source_type": "codex",
                    "type": "Plus",
                },
            ])
            service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)

            class FakeCodexBackend:
                attempted_tokens: list[str] = []

                def __init__(self, access_token: str) -> None:
                    self.access_token = access_token
                    self.attempted_tokens.append(access_token)

                def iter_codex_image_response_events(self, **_kwargs):
                    if self.access_token == "empty-token":
                        return
                    yield {
                        "type": "image_generation_call",
                        "result": f"data:image/png;base64,{_ONE_PIXEL_PNG}",
                    }

                def close(self) -> None:
                    pass

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", FakeCodexBackend),
                patch.dict(config.data, {"image_transient_server_retries": 2}),
            ):
                outputs = list(conversation.stream_image_outputs_with_pool(
                    conversation.ConversationRequest(model="codex-gpt-image-2", prompt="draw a square")
                ))

            self.assertEqual(FakeCodexBackend.attempted_tokens, ["empty-token", "healthy-token"])
            self.assertEqual(len(outputs), 1)
            first = service.get_account("empty-token")
            second = service.get_account("healthy-token")
            self.assertIsNotNone(first)
            self.assertIsNotNone(second)
            self.assertEqual(first["quota"], 9)
            self.assertEqual(first["fail"], 1)
            self.assertEqual(second["quota"], 8)

    def test_codex_stream_reports_generation_and_receiving_progress(self) -> None:
        class FakeCodexBackend:
            def iter_codex_image_response_events(self, **_kwargs):
                yield {
                    "type": "image_generation_call",
                    "result": f"data:image/png;base64,{_ONE_PIXEL_PNG}",
                }

        progress: list[str] = []
        outputs = list(conversation.stream_codex_image_outputs(
            FakeCodexBackend(),
            conversation.ConversationRequest(
                model="codex-gpt-image-2",
                prompt="draw a square",
                progress_callback=progress.append,
            ),
        ))

        self.assertEqual(len(outputs), 1)
        self.assertEqual(progress, ["starting_generation", "receiving_image"])

    def test_codex_stream_deduplicates_repeated_image_events(self) -> None:
        class FakeCodexBackend:
            def iter_codex_image_response_events(self, **_kwargs):
                event = {
                    "type": "image_generation_call",
                    "result": f"data:image/png;base64,{_ONE_PIXEL_PNG}",
                }
                yield event
                yield {"type": "response.completed", "response": {"output": [event]}}

        outputs = list(conversation.stream_codex_image_outputs(
            FakeCodexBackend(),
            conversation.ConversationRequest(model="codex-gpt-image-2", prompt="draw a square"),
        ))

        self.assertEqual(len(outputs), 1)
        self.assertEqual(len(outputs[0].data), 1)

    def test_malformed_codex_image_rotates_to_next_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_account_items([
                {
                    "access_token": "malformed-token",
                    "status": "正常",
                    "quota": 9,
                    "source_type": "codex",
                    "type": "Plus",
                },
                {
                    "access_token": "healthy-token",
                    "status": "正常",
                    "quota": 9,
                    "source_type": "codex",
                    "type": "Plus",
                },
            ])
            service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)

            class FakeCodexBackend:
                attempted_tokens: list[str] = []

                def __init__(self, access_token: str) -> None:
                    self.access_token = access_token
                    self.attempted_tokens.append(access_token)

                def iter_codex_image_response_events(self, **_kwargs):
                    result = "bm90IGFuIGltYWdl" if self.access_token == "malformed-token" else _ONE_PIXEL_PNG
                    yield {"type": "image_generation_call", "result": result}

                def close(self) -> None:
                    pass

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", FakeCodexBackend),
                patch.dict(config.data, {"image_transient_server_retries": 2}),
            ):
                outputs = list(conversation.stream_image_outputs_with_pool(
                    conversation.ConversationRequest(model="codex-gpt-image-2", prompt="draw a square")
                ))

            self.assertEqual(FakeCodexBackend.attempted_tokens, ["malformed-token", "healthy-token"])
            self.assertEqual(len(outputs), 1)


if __name__ == "__main__":
    unittest.main()
