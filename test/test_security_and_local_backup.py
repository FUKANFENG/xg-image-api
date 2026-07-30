from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import Response
from fastapi.testclient import TestClient

import api.support as support_module
import api.system as system_module
import services.backup_service as backup_module
from api.app import create_app
from services.backup_service import BackupError, LocalBackupClient
from services.config import config
from services.auth_service import auth_service


ROOT_DIR = Path(__file__).resolve().parents[1]


class SecurityAndLocalBackupTests(unittest.TestCase):
    def test_stored_images_require_header_or_session_cookie(self) -> None:
        client = TestClient(create_app())
        with patch.object(system_module, "get_image_response", return_value=Response(content=b"png", media_type="image/png")):
            anonymous = client.get("/images/2026/private.png")
            bearer = client.get(
                "/images/2026/private.png",
                headers={"Authorization": f"Bearer {config.auth_key}"},
            )
            session = auth_service.create_session(
                {"id": "admin", "name": "管理员", "role": "admin", "session_version": 1}
            )
            client.cookies.set(support_module.SESSION_COOKIE_NAME, session)
            cookie = client.get("/images/2026/private.png")

        self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(bearer.status_code, 200)
        self.assertEqual(cookie.status_code, 200)

    def test_application_images_define_a_liveness_healthcheck(self) -> None:
        for name in ("Dockerfile", "Dockerfile.local"):
            dockerfile = (ROOT_DIR / name).read_text(encoding="utf-8")
            self.assertIn("HEALTHCHECK", dockerfile, name)
            self.assertIn("/health?format=json", dockerfile, name)

    def test_local_image_overlays_all_runtime_sources(self) -> None:
        dockerfile = (ROOT_DIR / "Dockerfile.local").read_text(encoding="utf-8")
        for source in ("main.py", "api", "services", "utils", "scripts"):
            self.assertIn(f"COPY {source} /app/{source}", dockerfile, source)

    def test_api_responses_include_security_headers(self) -> None:
        client = TestClient(create_app())
        response = client.post(
            "/auth/session",
            headers={"Authorization": f"Bearer {config.auth_key}"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_cors_accepts_private_lan_origins_but_not_public_origins(self) -> None:
        client = TestClient(create_app())
        lan = client.options(
            "/auth/session",
            headers={"Origin": "http://192.168.1.20:3000", "Access-Control-Request-Method": "POST"},
        )
        public = client.options(
            "/auth/session",
            headers={"Origin": "https://attacker.example", "Access-Control-Request-Method": "POST"},
        )

        self.assertEqual(lan.headers.get("access-control-allow-origin"), "http://192.168.1.20:3000")
        self.assertIsNone(public.headers.get("access-control-allow-origin"))

    def test_force_https_redirect_is_configurable_for_reverse_proxy_deployment(self) -> None:
        with patch.dict(os.environ, {"CHATGPT2API_FORCE_HTTPS": "true"}):
            client = TestClient(create_app(), follow_redirects=False)
            response = client.post("/auth/session")

        self.assertEqual(response.status_code, 308)
        self.assertTrue(response.headers["location"].startswith("https://"))

    def test_web_documents_and_next_route_data_are_always_revalidated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir, patch.object(
            support_module,
            "WEB_DIST_DIR",
            Path(tmp_dir),
        ):
            web_root = Path(tmp_dir)
            (web_root / "tools").mkdir(parents=True)
            (web_root / "_next" / "static" / "chunks").mkdir(parents=True)
            (web_root / "tools" / "index.html").write_text("<html>tools</html>", encoding="utf-8")
            (web_root / "tools" / "index.txt").write_text("route-data", encoding="utf-8")
            (web_root / "_next" / "static" / "chunks" / "navigation.js").write_text(
                "window.navigationVersion = 'current';",
                encoding="utf-8",
            )
            client = TestClient(create_app())

            document = client.get("/tools/")
            route_data = client.get("/tools/index.txt?_rsc=regression")
            navigation_chunk = client.get("/_next/static/chunks/navigation.js")

        self.assertEqual(document.status_code, 200, document.text)
        self.assertEqual(route_data.status_code, 200, route_data.text)
        self.assertEqual(
            document.headers["cache-control"],
            "no-store, no-cache, must-revalidate, max-age=0",
        )
        self.assertEqual(
            route_data.headers["cache-control"],
            "no-store, no-cache, must-revalidate, max-age=0",
        )
        self.assertEqual(
            navigation_chunk.headers["cache-control"],
            "no-cache, must-revalidate, max-age=0",
        )
        self.assertEqual(document.headers["pragma"], "no-cache")
        self.assertEqual(route_data.headers["pragma"], "no-cache")

    def test_local_backup_provider_round_trip_and_path_guard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir, patch.object(
            backup_module,
            "DATA_DIR",
            Path(tmp_dir),
        ):
            client = LocalBackupClient({"prefix": "backups"})
            result = client.upload_bytes(
                "backups/backup-20260718T000000Z-test.tar.gz",
                b"backup-payload",
                content_type="application/octet-stream",
            )

            self.assertEqual(client.download_bytes(str(result["key"])), b"backup-payload")
            self.assertEqual(len(client.list_objects()), 1)
            with self.assertRaises(BackupError):
                client.download_bytes("..")
            client.delete_object(str(result["key"]))
            self.assertEqual(client.list_objects(), [])


if __name__ == "__main__":
    unittest.main()
