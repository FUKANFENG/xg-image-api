from __future__ import annotations

import base64
import os
import unittest
from io import BytesIO
from unittest.mock import patch

from curl_cffi import requests
from PIL import Image

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "chatgpt2api")

import services.openai_backend_api as backend_module


class _Response:
    def __init__(self, payload: dict | None = None) -> None:
        self.status_code = 200
        self.headers: dict[str, str] = {}
        self.text = ""
        self._payload = payload or {}

    def json(self) -> dict:
        return dict(self._payload)

    def close(self) -> None:
        pass


class _Session:
    def __init__(
            self,
            *,
            file_id: str = "file-test",
            fail_first_registration: bool = False,
            fail_registration_at: int | None = None,
    ) -> None:
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {}
        self.file_id = file_id
        self.fail_first_registration = fail_first_registration
        self.fail_registration_at = fail_registration_at
        self.registration_calls = 0
        self.post_calls: list[str] = []
        self.post_kwargs: list[dict] = []
        self.put_calls: list[str] = []
        self.closed = False

    def post(self, url: str, **kwargs):
        self.post_calls.append(url)
        self.post_kwargs.append(kwargs)
        if url.endswith("/backend-api/files"):
            self.registration_calls += 1
            if self.fail_first_registration or self.registration_calls == self.fail_registration_at:
                self.fail_first_registration = False
                raise requests.exceptions.SSLError(
                    "curl: (35) TLS connect error: OPENSSL_internal:invalid library (0)",
                    code=35,
                )
            return _Response({
                "file_id": self.file_id,
                "upload_url": f"https://upload.example.test/{self.file_id}",
            })
        return _Response()

    def put(self, url: str, **_kwargs):
        self.put_calls.append(url)
        return _Response()

    def close(self) -> None:
        self.closed = True


def _png_data_url() -> str:
    buffer = BytesIO()
    Image.new("RGB", (1, 1), "white").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class ImageUploadRetryTests(unittest.TestCase):
    def test_tls_registration_failure_rebuilds_session_and_retries_same_upload(self) -> None:
        failed_session = _Session(fail_first_registration=True)
        recovered_session = _Session()

        with (
            patch.object(
                backend_module.requests,
                "Session",
                side_effect=[failed_session, recovered_session],
            ) as session_factory,
            patch.object(
                backend_module.proxy_settings,
                "build_session_kwargs",
                return_value={},
            ),
            patch.object(backend_module.time, "sleep", return_value=None),
        ):
            backend = backend_module.OpenAIBackendAPI(access_token="test-token")
            uploaded = backend._upload_image(
                _png_data_url(),
                "image_1.png",
                image_index=1,
            )

        self.assertEqual(uploaded["file_id"], "file-test")
        self.assertEqual(session_factory.call_count, 2)
        self.assertTrue(failed_session.closed)
        self.assertEqual(len(failed_session.post_calls), 1)
        self.assertEqual(len(recovered_session.post_calls), 2)
        self.assertEqual(len(recovered_session.put_calls), 1)
        self.assertEqual(recovered_session.headers["Authorization"], "Bearer test-token")
        backend.close()

    def test_tls_registration_retry_is_bounded(self) -> None:
        sessions = [_Session(fail_first_registration=True) for _ in range(3)]

        with (
            patch.object(backend_module.requests, "Session", side_effect=sessions) as session_factory,
            patch.object(
                backend_module.proxy_settings,
                "build_session_kwargs",
                return_value={},
            ),
            patch.object(backend_module.time, "sleep", return_value=None),
        ):
            backend = backend_module.OpenAIBackendAPI(access_token="test-token")
            with self.assertRaises(requests.exceptions.SSLError):
                backend._upload_image(
                    _png_data_url(),
                    "image_1.png",
                    image_index=1,
                )

        self.assertEqual(session_factory.call_count, 3)
        self.assertEqual([len(session.post_calls) for session in sessions], [1, 1, 1])
        self.assertTrue(sessions[0].closed)
        self.assertTrue(sessions[1].closed)
        backend.close()

    def test_generation_payload_keeps_both_reference_images(self) -> None:
        session = _Session()
        references = [
            {
                "file_id": "file-one",
                "file_name": "image_1.png",
                "file_size": 101,
                "mime_type": "image/png",
                "width": 10,
                "height": 20,
            },
            {
                "file_id": "file-two",
                "file_name": "image_2.png",
                "file_size": 202,
                "mime_type": "image/png",
                "width": 30,
                "height": 40,
            },
        ]

        with (
            patch.object(backend_module.requests, "Session", return_value=session),
            patch.object(
                backend_module.proxy_settings,
                "build_session_kwargs",
                return_value={},
            ),
        ):
            backend = backend_module.OpenAIBackendAPI(access_token="test-token")
            backend._start_image_generation(
                "combine both images",
                backend_module.ChatRequirements(token="requirements-token"),
                "conduit-token",
                "gpt-image-2",
                references,
            )

        payload = session.post_kwargs[-1]["json"]
        message = payload["messages"][0]
        self.assertEqual(
            [part["asset_pointer"] for part in message["content"]["parts"][:-1]],
            ["file-service://file-one", "file-service://file-two"],
        )
        self.assertEqual(message["content"]["parts"][-1], "combine both images")
        self.assertEqual(
            [item["id"] for item in message["metadata"]["attachments"]],
            ["file-one", "file-two"],
        )
        backend.close()

    def test_second_reference_tls_failure_recovers_and_keeps_both_images(self) -> None:
        first_session = _Session(file_id="file-one", fail_registration_at=2)
        recovered_session = _Session(file_id="file-two")
        captured_references: list[dict] = []

        def start_generation(_prompt, _requirements, _conduit_token, _model, references):
            captured_references.extend(references)
            return _Response()

        with (
            patch.object(
                backend_module.requests,
                "Session",
                side_effect=[first_session, recovered_session],
            ),
            patch.object(
                backend_module.proxy_settings,
                "build_session_kwargs",
                return_value={},
            ),
            patch.object(backend_module.time, "sleep", return_value=None),
        ):
            backend = backend_module.OpenAIBackendAPI(access_token="test-token")
            with (
                patch.object(backend, "_bootstrap", return_value=None),
                patch.object(
                    backend,
                    "_get_chat_requirements",
                    return_value=backend_module.ChatRequirements(token="requirements-token"),
                ),
                patch.object(backend, "_prepare_image_conversation", return_value="conduit-token"),
                patch.object(backend, "_start_image_generation", side_effect=start_generation),
                patch.object(backend, "_iter_image_sse_payloads", return_value=iter(["done"])),
            ):
                events = list(backend._stream_picture_conversation(
                    "combine both images",
                    "gpt-image-2",
                    [_png_data_url(), _png_data_url()],
                ))

        self.assertEqual(events, ["done"])
        self.assertEqual(
            [reference["file_id"] for reference in captured_references],
            ["file-one", "file-two"],
        )
        self.assertTrue(first_session.closed)
        backend.close()


if __name__ == "__main__":
    unittest.main()
