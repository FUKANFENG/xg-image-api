from __future__ import annotations

import io
import unittest

from PIL import Image

from services.image_tool_service import process_local_image


def make_png(size: tuple[int, int] = (64, 48), mode: str = "RGBA") -> bytes:
    image = Image.new(mode, size, (255, 0, 0, 128) if mode == "RGBA" else (255, 0, 0))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class ImageToolServiceTests(unittest.TestCase):
    def test_resize_preserves_requested_dimensions(self):
        result = process_local_image(
            make_png(),
            operation="resize",
            width=320,
            height=180,
            output_format="webp",
            quality=80,
        )
        self.assertEqual((result.width, result.height), (320, 180))
        self.assertEqual(result.extension, "webp")
        with Image.open(io.BytesIO(result.payload)) as image:
            self.assertEqual(image.size, (320, 180))
            self.assertEqual(image.format, "WEBP")

    def test_convert_transparent_png_to_jpeg_uses_valid_rgb_output(self):
        result = process_local_image(make_png(), operation="convert", output_format="jpg", quality=85)
        self.assertEqual(result.content_type, "image/jpeg")
        with Image.open(io.BytesIO(result.payload)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.mode, "RGB")

    def test_resize_requires_a_dimension(self):
        with self.assertRaisesRegex(ValueError, "至少需要填写"):
            process_local_image(make_png(), operation="resize", width=0, height=0)

    def test_rejects_invalid_payload_and_format(self):
        with self.assertRaisesRegex(ValueError, "有效图片"):
            process_local_image(b"not-an-image", operation="compress")
        with self.assertRaisesRegex(ValueError, "输出格式"):
            process_local_image(make_png(), operation="convert", output_format="gif")


if __name__ == "__main__":
    unittest.main()
