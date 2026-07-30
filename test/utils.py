import base64
import json
import os
import sys
import time
import unittest
import urllib.request
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT_DIR / "data" / "output"
BASE_URL = "http://127.0.0.1:3000"
LIVE_BASE_URL = str(os.getenv("CHATGPT2API_TEST_BASE_URL") or BASE_URL).strip().rstrip("/")
LIVE_TESTS_ENABLED = str(os.getenv("CHATGPT2API_RUN_LIVE_TESTS") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def load_auth_key() -> str:
    return json.loads((ROOT_DIR / "config.json").read_text(encoding="utf-8"))["auth-key"]


def _load_dotenv_auth_key() -> str:
    env_path = ROOT_DIR / ".env"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return ""
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() != "CHATGPT2API_AUTH_KEY":
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        return value.strip()
    return ""


def live_auth_key() -> str:
    return str(
        os.getenv("CHATGPT2API_TEST_AUTH_KEY")
        or os.getenv("CHATGPT2API_AUTH_KEY")
        or _load_dotenv_auth_key()
        or load_auth_key()
    ).strip()


def assert_http_ok(test_case: unittest.TestCase, response, expected_status: int = 200) -> None:
    if response.status_code == expected_status:
        return
    body = str(response.text or "")[:4000]
    test_case.fail(f"HTTP {response.status_code}, expected {expected_status}: {body}")


live_http_test = unittest.skipUnless(
    LIVE_TESTS_ENABLED,
    "set CHATGPT2API_RUN_LIVE_TESTS=1 to run real HTTP integration tests",
)


def post_json(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {load_auth_key()}"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode())


def detect_ext(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        return ".webp"
    if image_bytes.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    return ".png"


def save_image(image_b64: str, name: str) -> Path:
    image_bytes = base64.b64decode(image_b64)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{name}_{int(time.time())}{detect_ext(image_bytes)}"
    path.write_bytes(image_bytes)
    return path
