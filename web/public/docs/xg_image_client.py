"""XG public async image client, Python 3.10+, standard library only.

Review this file before use. Read XG_API_KEY from your secret environment.
Persist task_id before submitting; --resume only queries an existing task.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import random
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULT_BASE_URL = "https://picture.museyin.com"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward Bearer credentials through a redirect.
        return None


class XGAPIError(RuntimeError):
    def __init__(self, status: int, retry_after: str | None = None):
        super().__init__(f"XG HTTP {status}; consult the API error table")
        self.status = status
        self.retry_after = retry_after


def retry_delay(value: str | None, attempt: int) -> float:
    if value:
        try:
            return max(0, float(value))
        except ValueError:
            try:
                return max(0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass
    return min(30, 2 ** attempt) + random.random()


class XGImageClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL):
        parsed = urlsplit(base_url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError("Use an HTTPS service root, without /v1, query or credentials")
        if not api_key.strip():
            raise ValueError("XG_API_KEY is required")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key.strip()
        self._opener = build_opener(_NoRedirect())

    def _url(self, path: str) -> str:
        url = urljoin(self.base_url + "/", path)
        parsed = urlsplit(url)
        base = urlsplit(self.base_url)
        if (parsed.scheme, parsed.netloc) != (base.scheme, base.netloc) or parsed.username or parsed.password:
            raise ValueError("Refusing to send the XG API key to another origin")
        return url

    def _request(self, path: str, payload: dict | None = None, *, binary: bool = False, timeout: float = 60):
        headers = {"Authorization": f"Bearer {self._api_key}", "User-Agent": "XG-Agent/1.0"}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = Request(self._url(path), data=body, headers=headers)
        try:
            with self._opener.open(req, timeout=timeout) as response:
                content_type = response.headers.get_content_type()
                if binary and not content_type.startswith("image/"):
                    raise RuntimeError("Expected image bytes; received non-image response")
                if not binary and content_type != "application/json":
                    raise RuntimeError("Expected JSON; check endpoint path and Cloudflare access policy")
                content = response.read()
                return content if binary else json.loads(content)
        except HTTPError as exc:
            # Do not print secret headers or whole proxy HTML pages.
            status, retry_after = exc.code, exc.headers.get("Retry-After")
            exc.close()
            raise XGAPIError(status, retry_after) from None

    def submit(self, task_id: str, prompt: str, *, images: list[Path] | None = None, size: str | None = None) -> dict:
        if not task_id.strip() or not prompt.strip():
            raise ValueError("task_id and prompt are required")
        payload = {"client_task_id": task_id, "prompt": prompt, "model": "gpt-image-2", "quality": "auto"}
        if size:
            payload["size"] = size
        endpoint = "/api/image-tasks/generations"
        if images:
            endpoint = "/api/image-tasks/edits"
            references = []
            for path in images:
                mime = mimetypes.guess_type(path.name)[0]
                if mime not in {"image/png", "image/jpeg", "image/webp"}:
                    raise ValueError("Example client supports PNG, JPEG and WebP reference files")
                references.append(f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii"))
            payload["images"] = references
        # No automatic POST retries. Query persisted task_id after ambiguous failures.
        return self._request(endpoint, payload)

    def get_task(self, task_id: str, *, timeout: float = 30) -> dict:
        reply = self._request("/api/image-tasks?" + urlencode({"ids": task_id}), timeout=timeout)
        task = next((item for item in reply.get("items", []) if item.get("id") == task_id), None)
        if task is None:
            raise LookupError("Task missing: verify ID, calling identity and retention; do not automatically recreate")
        return task

    def wait(self, task_id: str, *, timeout: float = 1200, interval: float = 4) -> dict:
        deadline = time.monotonic() + timeout
        failures = 0
        while time.monotonic() < deadline:
            try:
                task = self.get_task(task_id, timeout=max(0.1, min(30, deadline - time.monotonic())))
                failures = 0
            except (XGAPIError, URLError, TimeoutError) as exc:
                if isinstance(exc, XGAPIError) and exc.status != 429 and not 500 <= exc.status < 600:
                    raise
                failures += 1
                if failures > 3:
                    raise
                delay = retry_delay(getattr(exc, "retry_after", None), failures)
                time.sleep(min(delay, max(0, deadline - time.monotonic())))
                continue
            status = task.get("status")
            if status == "success":
                if not task.get("data"):
                    raise RuntimeError("Successful task contains no image results")
                return task
            if status == "error":
                raise RuntimeError(f"Image task failed: {task.get('error_code', 'unknown')}; query task error for details")
            if status == "paused":
                raise RuntimeError("Task is paused; contact administrator")
            if status not in {"queued", "running"}:
                raise RuntimeError("Unrecognized task status; inspect protocol before continuing")
            time.sleep(min(max(3, interval), max(0, deadline - time.monotonic())))
        raise TimeoutError("Polling deadline reached; keep task_id and resume later, task was not cancelled")

    def download(self, image_url: str, destination: Path) -> None:
        url = self._url(image_url)
        if not urlsplit(url).path.startswith("/images/"):
            raise ValueError("Expected an XG /images/ result URL")
        content = self._request(url, binary=True)
        # Do not silently overwrite the caller's existing asset.
        with destination.open("xb") as output:
            output.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-id", required=True, help="Persisted UUID; reuse for retries/resume")
    parser.add_argument("--prompt")
    parser.add_argument("--image", type=Path, action="append")
    parser.add_argument("--resume", action="store_true", help="Query only; never submit")
    parser.add_argument("--output", type=Path, default=Path("result.png"))
    args = parser.parse_args()
    if not args.resume and not args.prompt:
        parser.error("--prompt is required unless --resume is specified")
    if args.output.exists():
        parser.error("Output already exists; choose a new path")
    client = XGImageClient(os.environ.get("XG_API_KEY", ""))
    print(f"task_id={args.task_id}", flush=True)
    if not args.resume:
        client.submit(args.task_id, args.prompt, images=args.image)
    task = client.wait(args.task_id)
    client.download(task["data"][0]["url"], args.output)
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
