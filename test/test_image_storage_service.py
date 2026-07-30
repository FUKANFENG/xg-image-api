from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image
from fastapi import HTTPException

import services.image_storage_service as image_storage_module
from services.image_storage_service import ImageStorageError, ImageStorageService, _safe_relative_path


def png_bytes(size: tuple[int, int] = (32, 32)) -> bytes:
    path = Path(tempfile.gettempdir()) / "chatgpt2api-test-image.png"
    Image.new("RGB", size, color=(255, 0, 0)).save(path, format="PNG")
    return path.read_bytes()


class FakeWebDAVClient:
    uploaded: dict[str, bytes] = {}
    deleted: list[str] = []

    def __init__(self, _settings):
        pass

    def put(self, rel: str, payload: bytes) -> str:
        self.uploaded[rel] = payload
        return f"https://dav.example.test/{rel}"

    def get(self, rel: str) -> bytes:
        return self.uploaded[rel]

    def delete(self, rel: str) -> bool:
        self.deleted.append(rel)
        self.uploaded.pop(rel, None)
        return True

    def test(self) -> dict[str, object]:
        self.put(".chatgpt2api_webdav_test.txt", b"chatgpt2api webdav test\n")
        self.delete(".chatgpt2api_webdav_test.txt")
        return {"ok": True, "status": 200, "error": None}


class ImageStorageServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        self.images_dir = self.data_dir / "images"
        self.settings = {
            "enabled": False,
            "mode": "local",
            "webdav_url": "",
            "webdav_username": "",
            "webdav_password": "",
            "webdav_root_path": "chatgpt2api/images",
            "public_base_url": "",
        }
        self.config_patcher = mock.patch("services.image_storage_service.config")
        self.mock_config = self.config_patcher.start()
        self.addCleanup(self.config_patcher.stop)
        self.mock_config.images_dir = self.images_dir
        self.mock_config.base_url = "http://app.test"
        self.mock_config.cleanup_old_images.return_value = 0
        self.mock_config.get_image_storage_settings.side_effect = lambda: dict(self.settings)
        FakeWebDAVClient.uploaded = {}
        FakeWebDAVClient.deleted = []

    def service(self) -> ImageStorageService:
        return ImageStorageService(self.data_dir / "image_index.json")

    def test_local_mode_saves_to_local_directory(self):
        stored = self.service().save(png_bytes(), "http://app.test")

        self.assertEqual(stored.storage, "local")
        self.assertTrue((self.images_dir / stored.rel).is_file())
        self.assertEqual(stored.url, f"http://app.test/images/{stored.rel}")

    def test_webdav_mode_uploads_without_local_file(self):
        self.settings.update({
            "enabled": True,
            "mode": "webdav",
            "webdav_url": "https://dav.example.test",
            "webdav_password": "secret",
        })
        with mock.patch("services.image_storage_service.WebDAVClient", FakeWebDAVClient):
            stored = self.service().save(png_bytes(), "http://app.test")
            payload = self.service().get_bytes(stored.rel)

        self.assertEqual(stored.storage, "webdav")
        self.assertFalse((self.images_dir / stored.rel).exists())
        self.assertIn(stored.rel, FakeWebDAVClient.uploaded)
        self.assertEqual(payload, FakeWebDAVClient.uploaded[stored.rel])

    def test_list_items_ignores_non_image_files(self):
        image = png_bytes()
        image_path = self.images_dir / "2026" / "05" / "07" / "sample.png"
        image_path.parent.mkdir(parents=True, exist_ok=True)
        image_path.write_bytes(image)
        (self.images_dir / ".DS_Store").write_text("not an image", encoding="utf-8")
        (self.images_dir / "2026" / ".DS_Store").write_text("not an image", encoding="utf-8")

        items = self.service().list_items("http://app.test")

        self.assertEqual([item["rel"] for item in items], ["2026/05/07/sample.png"])
        self.assertEqual(items[0]["storage"], "local")

    def test_list_items_excludes_invalid_images_and_caches_validation(self):
        valid_path = self.images_dir / "2026" / "05" / "07" / "valid.png"
        invalid_path = self.images_dir / "2026" / "05" / "07" / "broken.png"
        valid_path.parent.mkdir(parents=True, exist_ok=True)
        valid_path.write_bytes(png_bytes())
        invalid_path.write_bytes(b"not an image")
        service = self.service()

        first = service.list_items("http://app.test")
        with mock.patch(
            "services.image_storage_service._image_dimensions",
            wraps=image_storage_module._image_dimensions,
        ) as dimensions:
            second = service.list_items("http://app.test")

        self.assertEqual([item["rel"] for item in first], ["2026/05/07/valid.png"])
        self.assertEqual([item["rel"] for item in second], ["2026/05/07/valid.png"])
        dimensions.assert_not_called()

    def test_save_rejects_non_image_payload(self):
        service = self.service()

        with self.assertRaises(ImageStorageError):
            service.save(b"not an image", "http://app.test")

        self.assertEqual(list(self.images_dir.rglob("*")), [])

    def test_save_rejects_placeholder_sized_image(self):
        with self.assertRaises(ImageStorageError):
            self.service().save(png_bytes((1, 1)), "http://app.test")

    def test_safe_relative_path_rejects_absolute_and_parent_paths(self):
        for unsafe_path in ("/etc/passwd.png", "C:/Windows/test.png", "../outside.png"):
            with self.subTest(path=unsafe_path), self.assertRaises(HTTPException):
                _safe_relative_path(unsafe_path)

    def test_both_mode_saves_to_local_and_webdav(self):
        self.settings.update({
            "enabled": True,
            "mode": "both",
            "webdav_url": "https://dav.example.test",
            "webdav_password": "secret",
            "public_base_url": "https://cdn.example.test/images",
        })
        with mock.patch("services.image_storage_service.WebDAVClient", FakeWebDAVClient):
            stored = self.service().save(png_bytes(), "http://app.test")

        self.assertEqual(stored.storage, "both")
        self.assertTrue((self.images_dir / stored.rel).is_file())
        self.assertIn(stored.rel, FakeWebDAVClient.uploaded)
        self.assertEqual(stored.url, f"https://cdn.example.test/images/{stored.rel}")

    def test_test_webdav_writes_and_deletes_probe_file(self):
        self.settings.update({
            "enabled": True,
            "mode": "webdav",
            "webdav_url": "https://dav.example.test",
            "webdav_password": "secret",
        })
        with mock.patch("services.image_storage_service.WebDAVClient", FakeWebDAVClient):
            result = self.service().test_webdav()

        self.assertTrue(result["ok"])
        self.assertIn(".chatgpt2api_webdav_test.txt", FakeWebDAVClient.deleted)

    def test_backup_readiness_is_safe_and_distinguishes_copy_modes(self):
        service = self.service()
        local = service.backup_readiness()

        self.assertEqual(local["status"], "unprotected")
        self.assertEqual(local["mode"], "local")
        self.assertFalse(local["remote_enabled"])
        self.assertNotIn("password", local)

        self.settings.update({
            "enabled": True,
            "mode": "both",
            "webdav_url": "https://dav.example.test",
            "webdav_password": "secret",
        })
        dual = service.backup_readiness()

        self.assertEqual(dual["status"], "protected")
        self.assertTrue(dual["remote_enabled"])
        self.assertTrue(dual["remote_configured"])
        self.assertNotIn("secret", str(dual))

        self.settings["mode"] = "webdav"
        remote_only = service.backup_readiness()
        self.assertEqual(remote_only["status"], "warning")
        self.assertEqual(remote_only["mode"], "webdav")

    def test_inspect_restore_and_backup_selected_paths(self):
        self.settings.update({
            "enabled": True,
            "mode": "both",
            "webdav_url": "https://dav.example.test",
            "webdav_password": "secret",
        })
        service = self.service()
        with mock.patch("services.image_storage_service.WebDAVClient", FakeWebDAVClient):
            stored = service.save(png_bytes(), "http://app.test")
            local_path = self.images_dir / stored.rel
            local_path.unlink()

            remote_only = service.inspect_paths([stored.rel])[0]
            restored = service.restore_local(stored.rel)

            self.assertTrue(remote_only["recoverable"])
            self.assertTrue(restored["local"])
            self.assertTrue(restored["remote"])
            self.assertEqual(local_path.read_bytes(), FakeWebDAVClient.uploaded[stored.rel])

            FakeWebDAVClient.uploaded.pop(stored.rel)
            with service._index_lock:
                index = service._load_clean_index()
                index[stored.rel]["webdav"] = False
                index[stored.rel]["storage"] = "local"
                service._save_index(index)
            backup = service.backup_paths([stored.rel])

        self.assertEqual(backup["uploaded"], [stored.rel])
        self.assertEqual(backup["failed"], [])
        self.assertIn(stored.rel, FakeWebDAVClient.uploaded)


if __name__ == "__main__":
    unittest.main()
