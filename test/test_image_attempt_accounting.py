from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from curl_cffi import requests


import services.protocol.conversation as conversation
from services.account_service import AccountService
from services.config import config
from services.storage.json_storage import JSONStorageBackend


class ImageAttemptAccountingTests(unittest.TestCase):
    @staticmethod
    def _service(tmp_dir: str) -> AccountService:
        service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
        service.add_account_items([{
            "access_token": "account-token",
            "status": "正常",
            "quota": 9,
            "type": "Plus",
        }])
        service.fetch_remote_info = lambda access_token, event="fetch_remote_info": service.get_account(access_token)
        return service

    @staticmethod
    def _backend():
        class FakeBackend:
            def __init__(self, access_token: str) -> None:
                self.access_token = access_token

            def close(self) -> None:
                pass

        return FakeBackend

    def test_progress_only_attempt_is_counted_as_one_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self._service(tmp_dir)

            def progress_only(_backend, request, index, total):
                yield conversation.ImageOutput(
                    kind="progress",
                    model=request.model,
                    index=index,
                    total=total,
                    text="working",
                )

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", self._backend()),
                patch.object(conversation, "stream_image_outputs", progress_only),
                patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}),
            ):
                with self.assertRaises(conversation.ImageGenerationError):
                    list(conversation.stream_image_outputs_with_pool(
                        conversation.ConversationRequest(model="gpt-image-2", prompt="draw a square")
                    ))

            account = service.get_account("account-token")
            self.assertIsNotNone(account)
            self.assertEqual(account["fail"], 1)
            self.assertEqual(account["image_consecutive_failures"], 1)

    def test_message_policy_rejection_does_not_penalize_account_scheduling(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self._service(tmp_dir)

            def policy_message(_backend, request, index, total):
                yield conversation.ImageOutput(
                    kind="message",
                    model=request.model,
                    index=index,
                    total=total,
                    text="The request was rejected by the image safety policy.",
                )

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", self._backend()),
                patch.object(conversation, "stream_image_outputs", policy_message),
                patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}),
            ):
                with self.assertRaises(conversation.ImageGenerationError) as raised:
                    list(conversation.stream_image_outputs_with_pool(
                        conversation.ConversationRequest(
                            model="gpt-image-2",
                            prompt="policy test",
                            message_as_error=True,
                        )
                    ))

            account = service.get_account("account-token")
            self.assertEqual(raised.exception.code, "content_policy_violation")
            self.assertIsNotNone(account)
            self.assertEqual(account["image_consecutive_failures"], 0)

    def test_account_result_storage_failure_does_not_discard_generated_image(self) -> None:
        class FailingAccountingService:
            @staticmethod
            def get_available_access_token(**_kwargs):
                return "account-token"

            @staticmethod
            def get_account(_token):
                return {"status": "正常", "quota": 9}

            @staticmethod
            def image_account_reference(_token):
                return "acct_fixture"

            @staticmethod
            def mark_image_result(*_args, **_kwargs):
                raise OSError("account storage unavailable")

        def successful_image(_backend, request, index, total):
            yield conversation.ImageOutput(
                kind="result",
                model=request.model,
                index=index,
                total=total,
                data=[{"url": "http://example.test/image.png"}],
            )

        with (
            patch.object(conversation, "account_service", FailingAccountingService()),
            patch.object(conversation, "OpenAIBackendAPI", self._backend()),
            patch.object(conversation, "stream_image_outputs", successful_image),
        ):
            outputs = list(conversation.stream_image_outputs_with_pool(
                conversation.ConversationRequest(model="gpt-image-2", prompt="draw a square")
            ))

        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs[0].kind, "result")
        self.assertEqual(outputs[0].data[0]["url"], "http://example.test/image.png")

    def test_tls_transport_failure_releases_slot_without_penalizing_account(self) -> None:
        class TransportAwareService:
            def __init__(self) -> None:
                self.selected: list[str] = []
                self.results: list[tuple[tuple, dict]] = []
                self.released: list[str] = []

            def get_available_access_token(self, **_kwargs):
                self.selected.append("account-token")
                return "account-token"

            @staticmethod
            def get_account(_token):
                return {"email": "account@example.test", "status": "正常", "quota": 9}

            @staticmethod
            def image_account_reference(_token):
                return "acct_fixture"

            def mark_image_result(self, *args, **kwargs):
                self.results.append((args, kwargs))

            def release_image_slot(self, token: str) -> None:
                self.released.append(token)

        def tls_failure(_backend, _request, _index, _total):
            raise requests.exceptions.SSLError(
                "curl: (35) TLS connect error: OPENSSL_internal:invalid library (0)",
                code=35,
            )
            yield  # pragma: no cover

        service = TransportAwareService()
        with (
            patch.object(conversation, "account_service", service),
            patch.object(conversation, "OpenAIBackendAPI", self._backend()),
            patch.object(conversation, "stream_image_outputs", tls_failure),
            patch.object(conversation, "_wait_for_image_budget", return_value=None),
        ):
            with self.assertRaises(conversation.ImageGenerationError) as raised:
                list(conversation.stream_image_outputs_with_pool(
                    conversation.ConversationRequest(model="gpt-image-2", prompt="transport retry")
                ))

        self.assertEqual(
            str(raised.exception),
            "upstream image connection failed, please retry later",
        )
        self.assertEqual(service.results, [])
        self.assertEqual(service.released, ["account-token"] * 4)
        self.assertEqual(service.selected, ["account-token"] * 4)

    def test_poll_timeout_after_submission_does_not_resubmit_on_another_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self._service(tmp_dir)
            attempts = 0

            def timed_out_image(_backend, _request, _index, _total):
                nonlocal attempts
                attempts += 1
                error = conversation.ImagePollTimeoutError("poll deadline exhausted")
                error.conversation_id = "conversation-already-submitted"
                raise error
                yield  # pragma: no cover

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", self._backend()),
                patch.object(conversation, "stream_image_outputs", timed_out_image),
                patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}),
            ):
                with self.assertRaises(conversation.ImagePollTimeoutError):
                    list(conversation.stream_image_outputs_with_pool(
                        conversation.ConversationRequest(model="gpt-image-2", prompt="slow image")
                    ))

            self.assertEqual(attempts, 1)

    def test_text_reply_with_conversation_id_does_not_submit_a_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self._service(tmp_dir)
            attempts = 0

            def submitted_text_reply(_backend, request, index, total):
                nonlocal attempts
                attempts += 1
                yield conversation.ImageOutput(
                    kind="message",
                    model=request.model,
                    index=index,
                    total=total,
                    text='{"referenced_image_ids":["image-id"]}',
                    conversation_id="conversation-already-submitted",
                )

            with (
                patch.object(conversation, "account_service", service),
                patch.object(conversation, "OpenAIBackendAPI", self._backend()),
                patch.object(conversation, "stream_image_outputs", submitted_text_reply),
                patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}),
            ):
                with self.assertRaises(conversation.ImageGenerationError):
                    list(conversation.stream_image_outputs_with_pool(
                        conversation.ConversationRequest(
                            model="gpt-image-2",
                            prompt="submitted text reply",
                            message_as_error=True,
                        )
                    ))

            self.assertEqual(attempts, 1)

    def test_explicit_codex_server_error_retries_on_another_account(self) -> None:
        class RotatingService:
            def __init__(self) -> None:
                self.selected: list[str] = []

            def get_available_access_token(self, **kwargs):
                excluded = kwargs.get("excluded_tokens") or set()
                token = next(item for item in ("token-one", "token-two") if item not in excluded)
                self.selected.append(token)
                return token

            @staticmethod
            def get_account(token):
                return {"access_token": token, "email": f"{token}@example.test", "status": "正常", "quota": 9}

            @staticmethod
            def image_account_reference(token):
                return f"acct_{token}"

            @staticmethod
            def mark_image_result(*_args, **_kwargs):
                return None

        attempts = 0

        def fail_then_succeed(_backend, request, index, total):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise conversation.ImageGenerationError("temporary failure", code="server_error")
            yield conversation.ImageOutput(
                kind="result",
                model=request.model,
                index=index,
                total=total,
                data=[{"url": "http://example.test/recovered.png"}],
            )

        service = RotatingService()
        with (
            patch.object(conversation, "account_service", service),
            patch.object(conversation, "OpenAIBackendAPI", self._backend()),
            patch.object(conversation, "stream_codex_image_outputs", fail_then_succeed),
        ):
            outputs = list(conversation.stream_image_outputs_with_pool(
                conversation.ConversationRequest(model="codex-gpt-image-2", prompt="retry server error")
            ))

        self.assertEqual(attempts, 2)
        self.assertEqual(service.selected, ["token-one", "token-two"])
        self.assertEqual(outputs[0].data[0]["url"], "http://example.test/recovered.png")

    def test_codex_error_event_preserves_server_error_code(self) -> None:
        class EventBackend:
            @staticmethod
            def iter_codex_image_response_events(**_kwargs):
                yield {
                    "type": "error",
                    "error": {"type": "server_error", "code": "server_error", "message": "temporary failure"},
                }
                yield {
                    "type": "response.failed",
                    "response": {"error": {"code": "server_error", "message": "temporary failure"}},
                }

        with self.assertRaises(conversation.ImageGenerationError) as raised:
            list(conversation.stream_codex_image_outputs(
                EventBackend(),
                conversation.ConversationRequest(model="codex-gpt-image-2", prompt="event error"),
            ))

        self.assertEqual(raised.exception.code, "server_error")
        self.assertEqual(str(raised.exception), "temporary failure")

    def test_server_error_is_preserved_when_no_alternative_account_exists(self) -> None:
        class SingleAccountService:
            @staticmethod
            def get_available_access_token(**kwargs):
                if kwargs.get("excluded_tokens"):
                    raise RuntimeError("no available codex image quota")
                return "only-token"

            @staticmethod
            def get_account(_token):
                return {"email": "only@example.test", "status": "正常", "quota": 9}

            @staticmethod
            def image_account_reference(_token):
                return "acct_only"

            @staticmethod
            def mark_image_result(*_args, **_kwargs):
                return None

        def server_error(_backend, _request, _index, _total):
            raise conversation.ImageGenerationError("temporary failure", code="server_error")
            yield  # pragma: no cover

        with (
            patch.object(conversation, "account_service", SingleAccountService()),
            patch.object(conversation, "OpenAIBackendAPI", self._backend()),
            patch.object(conversation, "stream_codex_image_outputs", server_error),
        ):
            with self.assertRaises(conversation.ImageGenerationError) as raised:
                list(conversation.stream_image_outputs_with_pool(
                    conversation.ConversationRequest(model="codex-gpt-image-2", prompt="single account retry")
                ))

        self.assertEqual(raised.exception.code, "server_error")
        self.assertEqual(str(raised.exception), "temporary failure")

    def test_image_models_are_routed_to_matching_account_sources(self) -> None:
        class RoutingService:
            def __init__(self) -> None:
                self.sources: list[str | None] = []

            def get_available_access_token(self, **kwargs):
                self.sources.append(kwargs.get("source_type"))
                return "account-token"

            @staticmethod
            def get_account(_token):
                return {"status": "正常", "quota": 9}

            @staticmethod
            def image_account_reference(_token):
                return "acct_fixture"

            @staticmethod
            def mark_image_result(*_args, **_kwargs):
                return None

        def successful_image(_backend, request, index, total):
            yield conversation.ImageOutput(
                kind="result",
                model=request.model,
                index=index,
                total=total,
                data=[{"url": "http://example.test/image.png"}],
            )

        service = RoutingService()
        with (
            patch.object(conversation, "account_service", service),
            patch.object(conversation, "OpenAIBackendAPI", self._backend()),
            patch.object(conversation, "stream_image_outputs", successful_image),
            patch.object(conversation, "stream_codex_image_outputs", successful_image),
        ):
            list(conversation.stream_image_outputs_with_pool(
                conversation.ConversationRequest(model="gpt-image-2", prompt="web route")
            ))
            list(conversation.stream_image_outputs_with_pool(
                conversation.ConversationRequest(model="codex-gpt-image-2", prompt="codex route")
            ))

        self.assertEqual(service.sources, ["web", "codex"])


class ImageDeadlineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.storage_patcher = patch.object(
            conversation,
            "save_image_bytes",
            return_value="http://testserver/images/fake.png",
        )
        self.storage_patcher.start()
        self.addCleanup(self.storage_patcher.stop)

    @staticmethod
    def _request() -> conversation.ConversationRequest:
        request = conversation.ConversationRequest(model="gpt-image-2", prompt="deadline test")
        request.deadline_monotonic = time.monotonic() + 30.0
        return request

    def test_initial_poll_uses_remaining_request_budget(self) -> None:
        poll_timeouts: list[float] = []

        class FakeBackend:
            def resolve_conversation_image_urls(
                self, _conversation_id, _file_ids, _sediment_ids, *, poll_timeout_secs=None, **_kwargs
            ):
                poll_timeouts.append(float(poll_timeout_secs))
                return ["image-url"]

            @staticmethod
            def download_image_bytes(_urls):
                return [b"image-bytes"]

        final_event = {
            "conversation_id": "conversation-id",
            "file_ids": [],
            "sediment_ids": [],
            "text": "",
            "turn_use_case": "image gen",
        }
        with patch.object(conversation, "conversation_events", return_value=iter([final_event])):
            outputs = list(conversation.stream_image_outputs(FakeBackend(), self._request()))

        self.assertEqual(outputs[-1].kind, "result")
        self.assertEqual(len(poll_timeouts), 1)
        self.assertGreater(poll_timeouts[0], 0)
        self.assertLessEqual(poll_timeouts[0], 30.0)

    def test_fallback_poll_reuses_the_same_request_budget(self) -> None:
        fallback_timeouts: list[float] = []

        class FakeBackend:
            def resolve_conversation_image_urls(
                self, _conversation_id, _file_ids, _sediment_ids, *, poll_timeout_secs=None, poll=True
            ):
                if poll is False:
                    return ["image-url"]
                return []

            def _poll_image_results(self, _conversation_id, timeout_secs, _file_ids, _sediment_ids):
                fallback_timeouts.append(float(timeout_secs))
                return ["file-id"], []

            @staticmethod
            def download_image_bytes(_urls):
                return [b"image-bytes"]

        final_event = {
            "conversation_id": "conversation-id",
            "file_ids": [],
            "sediment_ids": [],
            "text": "",
            "turn_use_case": "image gen",
        }
        with (
            patch.object(conversation, "conversation_events", return_value=iter([final_event])),
            patch.object(conversation.time, "sleep", return_value=None),
        ):
            outputs = list(conversation.stream_image_outputs(FakeBackend(), self._request()))

        self.assertEqual(outputs[-1].kind, "result")
        self.assertEqual(len(fallback_timeouts), 1)
        self.assertGreater(fallback_timeouts[0], 0)
        self.assertLessEqual(fallback_timeouts[0], 30.0)

    def test_budget_wait_is_cancel_aware(self) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        request = self._request()
        request.cancel_event = cancel_event

        with self.assertRaises(conversation.ImageTaskCancelledError):
            conversation._wait_for_image_budget(request, 10.0, "conversation-id")


if __name__ == "__main__":
    unittest.main()
