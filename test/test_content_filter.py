from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import services.content_filter as content_filter
from services.content_filter import _extract_review_decision, _is_allow_decision, _is_reject_decision


class ContentFilterTests(unittest.TestCase):
    @staticmethod
    def _review_config(*, fail_open: bool = True) -> SimpleNamespace:
        return SimpleNamespace(
            sensitive_words=[],
            ai_review={
                "enabled": True,
                "base_url": "https://review.example.test",
                "api_key": "test-key",
                "model": "review-model",
                "timeout_secs": 15,
                "max_attempts": 2,
                "fail_open": fail_open,
            },
        )

    @staticmethod
    def _response(decision: str, status_code: int = 200) -> mock.Mock:
        response = mock.Mock(status_code=status_code, text="")
        response.json.return_value = {"choices": [{"message": {"content": decision}}]}
        return response

    def test_minimax_think_block_does_not_hide_allow_verdict(self) -> None:
        response = {
            "choices": [
                {
                    "message": {
                        "content": "<think>Need classify this request before answering.</think>\nALLOW",
                    }
                }
            ]
        }

        decision = _extract_review_decision(response)

        self.assertEqual(decision, "allow")
        self.assertTrue(_is_allow_decision(decision or ""))
        self.assertFalse(_is_reject_decision(decision or ""))

    def test_minimax_think_block_does_not_hide_reject_verdict(self) -> None:
        response = {
            "choices": [
                {
                    "message": {
                        "content": "<think>Policy review completed.</think>\nREJECT",
                    }
                }
            ]
        }

        decision = _extract_review_decision(response)

        self.assertEqual(decision, "reject")
        self.assertTrue(_is_reject_decision(decision or ""))
        self.assertFalse(_is_allow_decision(decision or ""))

    def test_transient_review_failure_retries_then_uses_verdict(self) -> None:
        with (
            mock.patch.object(content_filter, "config", self._review_config()),
            mock.patch.object(content_filter.proxy_settings, "build_session_kwargs", return_value={}),
            mock.patch.object(
                content_filter.requests,
                "post",
                side_effect=[OSError("temporary dns failure"), self._response("ALLOW")],
            ) as request,
        ):
            content_filter.check_request("safe prompt")

        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args.kwargs["timeout"], 15)

    def test_exhausted_review_retries_respect_fail_closed(self) -> None:
        with (
            mock.patch.object(content_filter, "config", self._review_config(fail_open=False)),
            mock.patch.object(content_filter.proxy_settings, "build_session_kwargs", return_value={}),
            mock.patch.object(content_filter.requests, "post", side_effect=OSError("dns unavailable")) as request,
            self.assertRaises(HTTPException) as raised,
        ):
            content_filter.check_request("safe prompt")

        self.assertEqual(request.call_count, 2)
        self.assertEqual(raised.exception.status_code, 503)

    def test_transient_http_status_retries_before_rejecting(self) -> None:
        with (
            mock.patch.object(content_filter, "config", self._review_config()),
            mock.patch.object(content_filter.proxy_settings, "build_session_kwargs", return_value={}),
            mock.patch.object(
                content_filter.requests,
                "post",
                side_effect=[self._response("", 503), self._response("REJECT")],
            ) as request,
            self.assertRaises(HTTPException) as raised,
        ):
            content_filter.check_request("blocked prompt")

        self.assertEqual(request.call_count, 2)
        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
