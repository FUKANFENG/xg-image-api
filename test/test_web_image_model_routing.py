from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

import services.protocol.conversation as conversation
from services.openai_backend_api import ChatRequirements, OpenAIBackendAPI
from utils.helper import UpstreamHTTPError


class WebImageModelRoutingTests(unittest.TestCase):
    def make_backend(self) -> OpenAIBackendAPI:
        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.base_url = "https://chatgpt.com"
        backend.session = Mock(headers={})
        backend.progress_callback = Mock()
        backend.image_deadline_monotonic = None
        catalog = Mock(status_code=200, headers={}, text="")
        catalog.json.return_value = {
            "default_model_slug": "gpt-current",
            "models": [
                {"slug": "gpt-other", "enabled_tools": ["image_gen_tool_enabled"]},
                {"slug": "gpt-current", "enabled_tools": ["image_gen_tool_enabled"]},
            ],
        }
        backend.session.get.return_value = catalog
        self.addCleanup(backend.close)
        return backend

    def test_public_image_alias_resolves_available_web_model_once(self) -> None:
        backend = self.make_backend()
        for _ in range(3):
            self.assertEqual(backend._image_model_slug("gpt-image-2"), "gpt-current")
        self.assertEqual(backend._image_model_slug("codex-gpt-image-2"), "codex-gpt-image-2")
        backend.session.get.assert_called_once()

    def test_codex_route_does_not_query_the_web_catalog(self) -> None:
        backend = self.make_backend()
        self.assertEqual(backend._image_model_slug("codex-gpt-image-2"), "codex-gpt-image-2")
        backend.session.get.assert_not_called()

    def test_missing_default_uses_only_a_model_advertising_image_support(self) -> None:
        backend = self.make_backend()
        backend.session.get.return_value.json.return_value = {
            "default_model_slug": "retired-model",
            "models": [
                None,
                {"slug": "gpt-text-only", "enabled_tools": []},
                {"slug": "research", "enabled_tools": ["image_gen_tool_enabled"]},
                {"slug": "gpt-supported", "enabled_tools": ["image_gen_tool_enabled"]},
            ],
        }
        self.assertEqual(backend._image_model_slug("gpt-image-2"), "gpt-supported")

    def test_missing_image_capability_fails_before_prepare_or_submit(self) -> None:
        backend = self.make_backend()
        backend.session.get.return_value.json.return_value = {"models": []}
        with self.assertRaisesRegex(RuntimeError, "网页生图"):
            backend._prepare_image_conversation("draw", ChatRequirements("test"), "gpt-image-2")
        backend.session.post.assert_not_called()

    def test_catalog_authentication_failure_is_not_retried_or_hidden(self) -> None:
        backend = self.make_backend()
        backend.session.get.return_value.status_code = 403
        with self.assertRaises(UpstreamHTTPError):
            backend._image_model_slug("gpt-image-2")
        backend.session.get.assert_called_once()
        backend.session.post.assert_not_called()

    def test_prepare_and_submit_keep_web_route_and_image_tool_hint(self) -> None:
        backend = self.make_backend()
        response = Mock(status_code=200, headers={}, text="")
        response.json.return_value = {"conduit_token": "test-conduit"}
        backend.session.post.return_value = response
        requirements = ChatRequirements(token="test-requirements")
        conduit = backend._prepare_image_conversation("draw a tree", requirements, "gpt-image-2")
        backend._start_image_generation("draw a tree", requirements, conduit, "gpt-image-2")
        calls = backend.session.post.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].args[0], "https://chatgpt.com/backend-api/f/conversation/prepare")
        self.assertEqual(calls[1].args[0], "https://chatgpt.com/backend-api/f/conversation")
        for call in calls:
            self.assertEqual(call.kwargs["json"]["model"], "gpt-current")
            self.assertEqual(call.kwargs["json"]["system_hints"], ["picture_v2"])
        self.assertEqual(calls[1].kwargs["headers"]["X-Conduit-Token"], conduit)
        backend.progress_callback.assert_called_once_with("upstream_accepted")

    def test_web_404_is_actionable_without_leaking_raw_body_or_retrying(self) -> None:
        error = UpstreamHTTPError("/backend-api/f/conversation", 404, "private-upstream-response")
        with (
            patch.object(conversation.account_service, "get_available_access_token", return_value="test-token") as choose,
            patch.object(conversation.account_service, "get_account", return_value={}),
            patch.object(conversation.account_service, "image_account_reference", return_value="test-account"),
            patch.object(conversation.account_service, "mark_image_result"),
            patch.object(conversation, "OpenAIBackendAPI"),
            patch.object(conversation, "stream_image_outputs", side_effect=error) as web,
            patch.object(conversation, "stream_codex_image_outputs") as codex,
        ):
            with self.assertRaises(conversation.ImageGenerationError) as raised:
                list(conversation.stream_image_outputs_with_pool(
                    conversation.ConversationRequest(model="gpt-image-2", prompt="draw a tree")
                ))
        self.assertEqual(raised.exception.code, "upstream_not_found")
        message = raised.exception.to_openai_error()["error"]["message"]
        self.assertIn("404", message)
        self.assertNotIn("private-upstream-response", message)
        self.assertNotIn("backend-api", message)
        self.assertEqual(choose.call_count, 1)
        web.assert_called_once()
        codex.assert_not_called()


if __name__ == "__main__":
    unittest.main()
