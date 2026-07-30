from __future__ import annotations

import socket
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from api import image_inputs


class FakeStreamingResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        chunks: list[bytes] | None = None,
    ) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self._chunks = chunks or []
        self.closed = False

    @property
    def content(self) -> bytes:
        raise AssertionError("remote images must be consumed as a bounded stream")

    def iter_content(self, chunk_size: int | None = None):
        del chunk_size
        yield from self._chunks

    def close(self) -> None:
        self.closed = True


def public_dns_result(*_args, **_kwargs):
    return [
        (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("93.184.216.34", 443),
        )
    ]


class RemoteImageSecurityTests(unittest.TestCase):
    def test_public_image_is_downloaded_as_a_stream(self) -> None:
        response = FakeStreamingResponse(
            headers={"content-type": "image/png"},
            chunks=[b"png-", b"bytes"],
        )

        with (
            patch("socket.getaddrinfo", side_effect=public_dns_result),
            patch.object(image_inputs.requests, "get", return_value=response) as get,
        ):
            data, filename, mime_type = image_inputs._download_image_url(
                "https://example.com/image.png"
            )

        self.assertEqual(data, b"png-bytes")
        self.assertEqual(filename, "image.png")
        self.assertEqual(mime_type, "image/png")
        self.assertTrue(response.closed)
        self.assertTrue(get.call_args.kwargs["stream"])
        self.assertFalse(get.call_args.kwargs["allow_redirects"])

    def test_loopback_and_private_targets_are_rejected_before_request(self) -> None:
        for url in (
            "http://127.0.0.1/image.png",
            "http://10.0.0.8/image.png",
            "http://[::1]/image.png",
        ):
            with self.subTest(url=url), patch.object(image_inputs.requests, "get") as get:
                with self.assertRaises(HTTPException) as raised:
                    image_inputs._download_image_url(url)
                self.assertIn("publicly routable", str(raised.exception.detail))
                get.assert_not_called()

    def test_redirect_to_private_target_is_revalidated_and_rejected(self) -> None:
        response = FakeStreamingResponse(
            status_code=302,
            headers={"location": "http://127.0.0.1/internal.png"},
        )

        with (
            patch("socket.getaddrinfo", side_effect=public_dns_result),
            patch.object(image_inputs.requests, "get", return_value=response) as get,
        ):
            with self.assertRaises(HTTPException) as raised:
                image_inputs._download_image_url("https://example.com/redirect")

        self.assertIn("publicly routable", str(raised.exception.detail))
        self.assertEqual(get.call_count, 1)
        self.assertTrue(response.closed)

    def test_stream_is_aborted_immediately_after_size_limit(self) -> None:
        response = FakeStreamingResponse(
            headers={"content-type": "image/png"},
            chunks=[b"123", b"456"],
        )

        with (
            patch("socket.getaddrinfo", side_effect=public_dns_result),
            patch.object(image_inputs.requests, "get", return_value=response),
            patch.object(image_inputs, "MAX_IMAGE_REFERENCE_BYTES", 5),
        ):
            with self.assertRaises(HTTPException) as raised:
                image_inputs._download_image_url("https://example.com/large.png")

        self.assertIn("exceeds 50MB limit", str(raised.exception.detail))
        self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
