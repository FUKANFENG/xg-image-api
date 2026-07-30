"""Dependency-free Python client for the API-first XG image workflow.

The client intentionally covers only the stable workflow-facing endpoints.
Administrative APIs remain available in the web console but are not coupled
to workflow code.
"""

from __future__ import annotations

import base64
import json
import random
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Sequence


class XGAPIError(RuntimeError):
    """An HTTP or response error returned by the XG API."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response_body: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class XGAPIClient:
    """Minimal synchronous client suitable for scripts and workflow nodes."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 300,
        max_retries: int = 2,
        user_agent: str = "xg-api-client/1.0",
    ) -> None:
        normalized_url = base_url.strip().rstrip("/")
        if normalized_url.endswith("/v1"):
            normalized_url = normalized_url[:-3]
        if not normalized_url:
            raise ValueError("base_url cannot be empty")
        if not api_key.strip():
            raise ValueError("api_key cannot be empty")
        if max_retries < 0:
            raise ValueError("max_retries cannot be negative")

        self.base_url = normalized_url
        self.api_key = api_key.strip()
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health?format=json")

    def list_models(self) -> dict[str, Any]:
        return self._request("GET", "/v1/models")

    def generate_image(
        self,
        prompt: str,
        *,
        model: str = "gpt-image-2",
        n: int = 1,
        response_format: str = "b64_json",
        **options: Any,
    ) -> dict[str, Any]:
        payload = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "response_format": response_format,
            **options,
        }
        return self._request("POST", "/v1/images/generations", payload)

    def edit_image(
        self,
        prompt: str,
        images: Sequence[str | Mapping[str, Any]],
        *,
        model: str = "gpt-image-2",
        n: int = 1,
        response_format: str = "b64_json",
        **options: Any,
    ) -> dict[str, Any]:
        normalized_images = [
            {"image_url": image} if isinstance(image, str) else dict(image)
            for image in images
        ]
        payload = {
            "model": model,
            "prompt": prompt,
            "images": normalized_images,
            "n": n,
            "response_format": response_format,
            **options,
        }
        return self._request("POST", "/v1/images/edits", payload)

    def chat(
        self,
        messages: Sequence[Mapping[str, Any]],
        *,
        model: str = "gpt-5",
        stream: bool = False,
        **options: Any,
    ) -> dict[str, Any]:
        if stream:
            raise ValueError(
                "The small workflow client returns JSON only; use stream=False "
                "or call the endpoint with an SSE-capable HTTP client."
            )
        payload = {
            "model": model,
            "messages": [dict(message) for message in messages],
            "stream": False,
            **options,
        }
        return self._request("POST", "/v1/chat/completions", payload)

    def responses(
        self,
        input_value: Any,
        *,
        model: str = "gpt-5",
        tools: Sequence[Mapping[str, Any]] | None = None,
        stream: bool = False,
        **options: Any,
    ) -> dict[str, Any]:
        if stream:
            raise ValueError(
                "The small workflow client returns JSON only; use stream=False "
                "or call the endpoint with an SSE-capable HTTP client."
            )
        payload: dict[str, Any] = {
            "model": model,
            "input": input_value,
            "stream": False,
            **options,
        }
        if tools is not None:
            payload["tools"] = [dict(tool) for tool in tools]
        return self._request("POST", "/v1/responses", payload)

    def save_images(
        self,
        response: Mapping[str, Any],
        output_dir: str | Path,
        *,
        prefix: str = "xg-image",
    ) -> list[Path]:
        """Save standard ``data[].b64_json`` or ``data[].url`` results."""

        data = response.get("data")
        if not isinstance(data, list):
            raise XGAPIError("Image response does not contain a data array")

        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        saved: list[Path] = []
        for index, item in enumerate(data, start=1):
            if not isinstance(item, Mapping):
                continue
            encoded = item.get("b64_json")
            image_url = item.get("url")
            if isinstance(encoded, str) and encoded:
                try:
                    content = base64.b64decode(encoded, validate=True)
                except (ValueError, TypeError) as exc:
                    raise XGAPIError(f"Image {index} contains invalid base64") from exc
                suffix = ".png"
            elif isinstance(image_url, str) and image_url:
                content, suffix = self._download_image(image_url)
            else:
                continue

            path = destination / f"{prefix}-{index}{suffix}"
            path.write_bytes(content)
            saved.append(path)

        if not saved:
            raise XGAPIError("Image response contains no saveable image result")
        return saved

    def _request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        data = (
            json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if payload is not None
            else None
        )
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": self.user_agent,
        }
        if data is not None:
            headers["Content-Type"] = "application/json"

        for attempt in range(self.max_retries + 1):
            request = urllib.request.Request(
                url,
                data=data,
                headers=headers,
                method=method.upper(),
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read().decode("utf-8")
                    parsed = json.loads(body) if body else {}
                    if not isinstance(parsed, dict):
                        raise XGAPIError("API returned a non-object JSON response")
                    return parsed
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                if exc.code == 429 and attempt < self.max_retries:
                    self._wait_before_retry(exc.headers.get("Retry-After"), attempt)
                    continue
                message = self._error_message(body) or f"HTTP request failed ({exc.code})"
                raise XGAPIError(
                    message,
                    status_code=exc.code,
                    response_body=body,
                ) from exc
            except urllib.error.URLError as exc:
                if attempt < self.max_retries:
                    self._wait_before_retry(None, attempt)
                    continue
                raise XGAPIError(f"Unable to reach XG API: {exc.reason}") from exc
            except json.JSONDecodeError as exc:
                raise XGAPIError("API returned invalid JSON") from exc

        raise XGAPIError("Request failed after retries")

    def _download_image(self, image_url: str) -> tuple[bytes, str]:
        request = urllib.request.Request(
            image_url,
            headers={"User-Agent": self.user_agent},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                content = response.read()
                content_type = response.headers.get_content_type()
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise XGAPIError(f"Unable to download generated image: {exc}") from exc
        suffix = {
            "image/jpeg": ".jpg",
            "image/webp": ".webp",
            "image/gif": ".gif",
        }.get(content_type, ".png")
        return content, suffix

    @staticmethod
    def _error_message(body: str) -> str:
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            return body.strip()[:500]
        if not isinstance(payload, Mapping):
            return ""
        value: Any = payload.get("detail") or payload.get("error") or payload.get(
            "message"
        )
        if isinstance(value, Mapping):
            value = value.get("message") or value.get("error")
        return value if isinstance(value, str) else ""

    @staticmethod
    def _wait_before_retry(retry_after: str | None, attempt: int) -> None:
        try:
            delay = max(0.5, min(float(retry_after or ""), 60.0))
        except ValueError:
            delay = min(2**attempt + random.random(), 10.0)
        time.sleep(delay)
