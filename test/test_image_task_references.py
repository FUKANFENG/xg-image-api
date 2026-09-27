from __future__ import annotations

import unittest

from services.image_task_service import _public_task


class ImageTaskReferenceTests(unittest.TestCase):
    def test_public_task_exposes_historical_and_multi_image_references(self) -> None:
        task = {
            "id": "edit-1",
            "status": "success",
            "mode": "edit",
            "model": "gpt-image-2",
            "size": "1024x1024",
            "quality": "auto",
            "created_at": "2026-08-28 10:00:00",
            "updated_at": "2026-08-28 10:01:00",
            "workflow": {
                "source_paths": ["2026/08/28/first.png", "2026/08/28/second.png"],
                "source_names": ["人物.png", "服装.png"],
                "profile_reference_paths": ["2026/08/28/style.png"],
                "mask_paths": ["2026/08/28/mask.png"],
            },
        }

        public = _public_task(task)

        self.assertEqual(
            [item["name"] for item in public["reference_images"]],
            ["人物.png", "服装.png", "style.png"],
        )
        self.assertEqual(
            [item["kind"] for item in public["reference_images"]],
            ["reference", "reference", "profile"],
        )
        self.assertEqual(public["reference_images"][0]["url"], "/images/2026/08/28/first.png")
        self.assertEqual(public["mask_images"][0]["kind"], "mask")

    def test_public_task_rejects_unsafe_reference_paths(self) -> None:
        public = _public_task({
            "id": "edit-unsafe",
            "status": "error",
            "mode": "edit",
            "created_at": "2026-08-28 10:00:00",
            "updated_at": "2026-08-28 10:01:00",
            "workflow": {"source_paths": ["../../secret.txt"]},
        })

        self.assertNotIn("reference_images", public)


if __name__ == "__main__":
    unittest.main()
