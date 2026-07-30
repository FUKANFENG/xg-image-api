from __future__ import annotations

import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import services.backup_service as backup_module
from services.backup_service import BackupService


class _FakeStorageBackend:
    def get_backend_info(self) -> dict[str, str]:
        return {"type": "test"}


class _FakeConfig:
    app_version = "test"

    def get_storage_backend(self) -> _FakeStorageBackend:
        return _FakeStorageBackend()


class InspirationBackupTests(unittest.TestCase):
    def test_curated_inspirations_are_backed_up_without_the_full_image_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            image_dir = data_dir / "inspiration_images"
            image_dir.mkdir(parents=True)
            (data_dir / "inspirations.json").write_text('{"items": []}\n', encoding="utf-8")
            (image_dir / "curated-example.png").write_bytes(b"PNG")

            with (
                mock.patch.object(backup_module, "DATA_DIR", data_dir),
                mock.patch.object(backup_module, "INSPIRATIONS_FILE", data_dir / "inspirations.json"),
                mock.patch.object(backup_module, "INSPIRATION_IMAGES_DIR", image_dir),
                mock.patch.object(backup_module, "config", _FakeConfig()),
            ):
                archive_bytes = BackupService()._build_backup_archive(
                    {"include": {"inspirations": True, "images": False}},
                    trigger="test",
                )

            with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
                names = archive.getnames()

            self.assertIn("data/inspirations.json", names)
            self.assertIn("data/inspiration_images/curated-example.png", names)
            self.assertNotIn("data/images", names)


if __name__ == "__main__":
    unittest.main()
