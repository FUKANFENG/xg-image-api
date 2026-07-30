from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services import image_service


class ImageThumbnailCleanupTests(unittest.TestCase):
    def test_cleanup_uses_one_bulk_existence_lookup(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            thumbnail_root = Path(tmp_dir) / "thumbnails"
            first = thumbnail_root / "2026/07/20/first.png.png"
            second = thumbnail_root / "2026/07/20/second.png.png"
            first.parent.mkdir(parents=True, exist_ok=True)
            first.write_bytes(b"thumbnail")
            second.write_bytes(b"thumbnail")

            with (
                mock.patch.object(image_service, "config") as config,
                mock.patch.object(
                    image_service.image_storage_service,
                    "existing_paths",
                    return_value={"2026/07/20/first.png"},
                    create=True,
                ) as existing_paths,
                mock.patch.object(image_service.image_storage_service, "exists") as exists,
            ):
                config.image_thumbnails_dir = thumbnail_root
                removed = image_service.cleanup_image_thumbnails()

            existing_paths.assert_called_once_with(
                {"2026/07/20/first.png", "2026/07/20/second.png"}
            )
            exists.assert_not_called()
            self.assertEqual(removed, 1)
            self.assertTrue(first.is_file())
            self.assertFalse(second.exists())


if __name__ == "__main__":
    unittest.main()
