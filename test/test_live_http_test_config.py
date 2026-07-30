from __future__ import annotations

import importlib
import inspect
import os
import unittest
from unittest import mock


LIVE_TEST_MODULES = (
    "test.test_v1_chat_completions",
    "test.test_v1_images_edits",
    "test.test_v1_images_generations",
    "test.test_v1_messages",
    "test.test_v1_models",
    "test.test_v1_responses",
)


def _flatten(suite: unittest.TestSuite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _flatten(item)
        else:
            yield item


class LiveHttpTestConfigTests(unittest.TestCase):
    def test_live_http_tests_are_opt_in(self) -> None:
        suite = unittest.defaultTestLoader.loadTestsFromNames(LIVE_TEST_MODULES)
        live_tests = [test for test in _flatten(suite) if test.id().endswith("_http")]

        self.assertEqual(len(live_tests), 17)
        for test in live_tests:
            method = getattr(test, test._testMethodName)
            skipped = bool(
                getattr(test.__class__, "__unittest_skip__", False)
                or getattr(method, "__unittest_skip__", False)
            )
            self.assertTrue(skipped, test.id())
            self.assertIn("assert_http_ok(", inspect.getsource(method), test.id())

    def test_live_http_defaults_point_to_the_project_service(self) -> None:
        helpers = importlib.import_module("test.utils")
        self.assertEqual(helpers.LIVE_BASE_URL, "http://127.0.0.1:3000")

    def test_live_auth_key_matches_runtime_precedence(self) -> None:
        helpers = importlib.import_module("test.utils")
        with (
            mock.patch.dict(
                os.environ,
                {"CHATGPT2API_TEST_AUTH_KEY": "test-key", "CHATGPT2API_AUTH_KEY": "runtime-key"},
            ),
            mock.patch.object(helpers, "_load_dotenv_auth_key", return_value="dotenv-key"),
        ):
            self.assertEqual(helpers.live_auth_key(), "test-key")
        with (
            mock.patch.dict(
                os.environ,
                {"CHATGPT2API_TEST_AUTH_KEY": "", "CHATGPT2API_AUTH_KEY": "runtime-key"},
            ),
            mock.patch.object(helpers, "_load_dotenv_auth_key", return_value="dotenv-key"),
        ):
            self.assertEqual(helpers.live_auth_key(), "runtime-key")
        with (
            mock.patch.dict(
                os.environ,
                {"CHATGPT2API_TEST_AUTH_KEY": "", "CHATGPT2API_AUTH_KEY": ""},
            ),
            mock.patch.object(helpers, "_load_dotenv_auth_key", return_value="dotenv-key"),
        ):
            self.assertEqual(helpers.live_auth_key(), "dotenv-key")

    def test_http_assertion_does_not_read_successful_stream_body(self) -> None:
        helpers = importlib.import_module("test.utils")

        class StreamingResponse:
            status_code = 200

            @property
            def text(self):
                raise AssertionError("successful stream body must not be consumed")

        helpers.assert_http_ok(self, StreamingResponse())


if __name__ == "__main__":
    unittest.main()
