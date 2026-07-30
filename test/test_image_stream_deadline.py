from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import patch

from services.openai_backend_api import (
    ImagePollTimeoutError,
    ImageTaskCancelledError,
    OpenAIBackendAPI,
)
from scripts.benchmark_image_concurrency import _percentile
from utils.helper import iter_sse_payloads


class FakeResponse:
    def __init__(self, lines: list[bytes] | None = None) -> None:
        self.lines = lines or [b": heartbeat", b'data: {"ok":true}']
        self.closed = False

    def iter_lines(self):
        yield from self.lines

    def close(self) -> None:
        self.closed = True


class ImageStreamDeadlineTests(unittest.TestCase):
    def test_benchmark_percentile_uses_nearest_rank_for_small_batches(self) -> None:
        self.assertEqual(_percentile([52, 92], 0.95), 92)
        self.assertEqual(_percentile([44, 51, 77, 124], 0.95), 124)

    def test_sse_iterator_stops_when_total_deadline_is_exhausted(self) -> None:
        response = FakeResponse()
        with patch("utils.helper.time.monotonic", return_value=20.0):
            with self.assertRaises(TimeoutError):
                list(iter_sse_payloads(response, deadline_monotonic=10.0))

    def test_sse_iterator_stops_when_task_is_cancelled(self) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        with self.assertRaises(InterruptedError):
            list(iter_sse_payloads(FakeResponse(), cancel_event=cancel_event))

    def test_picture_stream_translates_deadline_to_typed_image_error(self) -> None:
        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.access_token = "test-token"
        backend.image_deadline_monotonic = 10.0
        backend.cancel_event = None
        backend._report_progress = lambda _step: None
        backend._bootstrap = lambda: None
        backend._get_chat_requirements = lambda: object()
        backend._prepare_image_conversation = lambda *_args: "conduit"
        response = FakeResponse()
        backend._start_image_generation = lambda *_args: response

        with patch("services.openai_backend_api.iter_sse_payloads", side_effect=TimeoutError("deadline")):
            with self.assertRaises(ImagePollTimeoutError) as raised:
                list(backend._stream_picture_conversation("prompt", "gpt-image-2", []))

        self.assertEqual(getattr(raised.exception, "code", ""), "image_timeout")
        self.assertTrue(response.closed)

    def test_picture_stream_translates_cancel_to_typed_error(self) -> None:
        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.access_token = "test-token"
        backend.image_deadline_monotonic = None
        backend.cancel_event = threading.Event()
        backend._report_progress = lambda _step: None
        backend._bootstrap = lambda: None
        backend._get_chat_requirements = lambda: object()
        backend._prepare_image_conversation = lambda *_args: "conduit"
        response = FakeResponse()
        backend._start_image_generation = lambda *_args: response

        with patch("services.openai_backend_api.iter_sse_payloads", side_effect=InterruptedError("cancelled")):
            with self.assertRaises(ImageTaskCancelledError):
                list(backend._stream_picture_conversation("prompt", "gpt-image-2", []))

        self.assertTrue(response.closed)

    def test_picture_stream_deadline_does_not_wait_for_another_sse_line(self) -> None:
        release_reader = threading.Event()

        class BlockingResponse(FakeResponse):
            def iter_lines(self):
                release_reader.wait(1.0)
                yield b": heartbeat"

        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.access_token = "test-token"
        backend.image_deadline_monotonic = time.monotonic() + 0.05
        backend.cancel_event = None
        backend._report_progress = lambda _step: None
        backend._bootstrap = lambda: None
        backend._get_chat_requirements = lambda: object()
        backend._prepare_image_conversation = lambda *_args: "conduit"
        response = BlockingResponse()
        backend._start_image_generation = lambda *_args: response

        started = time.perf_counter()
        try:
            with self.assertRaises(ImagePollTimeoutError):
                list(backend._stream_picture_conversation("prompt", "gpt-image-2", []))
        finally:
            release_reader.set()

        self.assertLess(time.perf_counter() - started, 0.3)
        self.assertTrue(response.closed)

    def test_codex_response_read_obeys_the_same_hard_deadline(self) -> None:
        release_reader = threading.Event()

        class BlockingRaw:
            headers = {"content-type": "application/json"}
            status = 200

            def __init__(self) -> None:
                self.closed = False

            def read(self) -> bytes:
                release_reader.wait(1.0)
                return b'{}'

            def close(self) -> None:
                self.closed = True

        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.image_deadline_monotonic = time.monotonic() + 0.05
        backend.cancel_event = None
        raw = BlockingRaw()
        started = time.perf_counter()
        try:
            with self.assertRaises(ImagePollTimeoutError):
                list(backend._iter_codex_response_events(raw))
        finally:
            release_reader.set()

        self.assertLess(time.perf_counter() - started, 0.3)
        self.assertTrue(raw.closed)


if __name__ == "__main__":
    unittest.main()
