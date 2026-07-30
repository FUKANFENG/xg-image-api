from __future__ import annotations

import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import services.backup_service as backup_module
from services.backup_service import BackupError, BackupService


def archive_bytes(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        metadata = json.dumps({"created_at": "2026-07-28T00:00:00Z", "app_version": "test"}).encode()
        info = tarfile.TarInfo("backup-metadata.json")
        info.size = len(metadata)
        archive.addfile(info, io.BytesIO(metadata))
        for name, payload in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return output.getvalue()


class BackupRestoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.data_dir = self.root / "data"
        self.data_dir.mkdir()
        self.config_file = self.root / "config.json"
        self.config_file.write_text('{"before":true}', encoding="utf-8")
        self.service = BackupService()

    def test_verify_rejects_path_traversal(self) -> None:
        payload = archive_bytes({"../outside.txt": b"no"})
        with mock.patch.object(self.service, "_download_decoded_archive", return_value=payload):
            with self.assertRaisesRegex(BackupError, "不安全路径"):
                self.service.verify_restore("unsafe.tar.gz")

    def test_restore_writes_allowed_files_and_creates_rollback_snapshot(self) -> None:
        target = self.data_dir / "sample.json"
        target.write_bytes(b"old")
        payload = archive_bytes({"config.json": b'{"after":true}', "data/sample.json": b"new"})
        with (
            mock.patch.object(self.service, "_download_decoded_archive", return_value=payload),
            mock.patch.object(backup_module, "DATA_DIR", self.data_dir),
            mock.patch.object(backup_module, "CONFIG_FILE", self.config_file),
        ):
            detail = self.service.verify_restore("safe.tar.gz")
            result = self.service.restore_backup("safe.tar.gz", run_id="run-1")

        self.assertEqual(detail["file_count"], 2)
        self.assertEqual(target.read_bytes(), b"new")
        self.assertEqual(self.config_file.read_bytes(), b'{"after":true}')
        self.assertTrue(Path(str(result["rollback_path"])).is_file())


if __name__ == "__main__":
    unittest.main()
