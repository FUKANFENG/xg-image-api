"""Run inside the XG runtime to verify deployed public docs/API without generating images.

Reads the existing admin key in memory. Never prints credentials, prompts or asset URLs.
Only GET and deliberately invalid POST requests; no image credits consumed.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from services.config import config

BASE = "https://picture.museyin.com"


def fetch(path, authenticated=False, payload=None):
    headers = {"User-Agent": "XG-Agent/1.0"}
    if authenticated:
        headers["Authorization"] = "Bearer " + config.auth_key
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = Request(BASE + path, headers=headers, data=None if payload is None else json.dumps(payload).encode())
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except HTTPError as exc:
        return exc.code, exc.read()


def main():
    for path, marker in [
        ("/developers/", "XG 公网生图 API"),
        ("/docs/xg-public-api.md", "# XG 公网生图 API"),
        ("/docs/xg-public-api.openapi.json", '"openapi": "3.0.3"'),
        ("/docs/xg_image_client.py", "class XGImageClient:"),
    ]:
        status, body = fetch(path)
        assert status == 200 and marker in body.decode("utf-8"), (path, status)
        assert config.auth_key.encode() not in body
        print(f"PASS public document {path}: 200, expected content, no embedded deployment key")

    for path in ["/v1/models", "/api/image-tasks"]:
        assert fetch(path)[0] == 401, path
        assert fetch(path, authenticated=True)[0] == 200, path
        print(f"PASS {path}: unauthenticated 401, authenticated 200")
    for path, expected in [("/api/image-tasks/generations", 422), ("/api/image-tasks/edits", 400)]:
        status, _ = fetch(path, authenticated=True, payload={"client_task_id": "invalid-doc-check", "prompt": ""})
        assert status == expected, (path, status)
        print(f"PASS {path}: invalid request rejected with {expected}, no task submitted")

    spec = importlib.util.spec_from_file_location("downloadable_client", "/app/web_dist/docs/xg_image_client.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = module.XGImageClient(config.auth_key)
    _, body = fetch("/api/image-tasks?limit=20", authenticated=True)
    previous = next((task for task in json.loads(body)["items"] if task.get("status") == "success" and task.get("data")), None)
    assert previous is not None, "No existing successful task available for read-only download check"
    task = client.wait(previous["id"], timeout=30)
    image_url = task["data"][0]["url"]
    assert image_url.startswith("/images/"), "Expected portable XG image URL"
    assert fetch(image_url)[0] == 401
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "result.png"
        client.download(image_url, path)
        assert path.stat().st_size > 0
        print(f"PASS Python client: existing successful task polled, authenticated image downloaded ({path.stat().st_size} bytes); anonymous download 401")


if __name__ == "__main__":
    main()
