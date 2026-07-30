from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_INPUT_BYTES = 50 * 1024 * 1024
MAX_OUTPUT_BYTES = 80 * 1024 * 1024
MAX_EDGE = 8192
MAX_PIXELS = 64_000_000


@dataclass(frozen=True)
class ImageToolResult:
    payload: bytes
    extension: str
    content_type: str
    width: int
    height: int
    original_bytes: int


def _positive_dimension(value: object) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("宽高必须是整数") from exc
    if number < 0 or number > MAX_EDGE:
        raise ValueError(f"宽高必须在 1 到 {MAX_EDGE} 像素之间")
    return number


def _output_format(value: object, fallback: str = "png") -> tuple[str, str, str]:
    normalized = str(value or fallback).strip().lower().lstrip(".")
    if normalized in {"jpg", "jpeg"}:
        return "JPEG", "jpg", "image/jpeg"
    if normalized == "webp":
        return "WEBP", "webp", "image/webp"
    if normalized == "png":
        return "PNG", "png", "image/png"
    raise ValueError("输出格式仅支持 PNG、JPEG 或 WEBP")


def _prepare_for_format(image: Image.Image, image_format: str) -> Image.Image:
    if image_format == "JPEG":
        if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, "white")
            background.paste(rgba, mask=rgba.getchannel("A"))
            return background
        return image.convert("RGB")
    if image.mode not in {"RGB", "RGBA"}:
        return image.convert("RGBA" if "A" in image.getbands() else "RGB")
    return image


def process_local_image(
    payload: bytes,
    *,
    operation: str,
    width: object = 0,
    height: object = 0,
    quality: object = 82,
    output_format: str = "png",
) -> ImageToolResult:
    if not payload or len(payload) > MAX_INPUT_BYTES:
        raise ValueError("图片为空或超过 50 MB")
    try:
        quality_value = max(20, min(100, int(quality or 82)))
    except (TypeError, ValueError) as exc:
        raise ValueError("压缩质量必须是 20 到 100 的整数") from exc
    normalized_operation = str(operation or "").strip().lower()
    if normalized_operation not in {"resize", "compress", "convert"}:
        raise ValueError("不支持的本地图像工具")
    image_format, extension, content_type = _output_format(output_format)
    try:
        with Image.open(io.BytesIO(payload)) as opened:
            opened.load()
            image = ImageOps.exif_transpose(opened).copy()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("上传内容不是有效图片") from exc
    if image.width * image.height > MAX_PIXELS:
        raise ValueError("图片像素总量过大，请先缩小后处理")

    if normalized_operation == "resize":
        target_width = _positive_dimension(width)
        target_height = _positive_dimension(height)
        if not target_width and not target_height:
            raise ValueError("缩放至少需要填写目标宽度或高度")
        if not target_width:
            target_width = max(1, round(image.width * target_height / image.height))
        if not target_height:
            target_height = max(1, round(image.height * target_width / image.width))
        if target_width * target_height > MAX_PIXELS:
            raise ValueError("目标图片像素总量过大")
        image = image.resize((target_width, target_height), Image.Resampling.LANCZOS)

    prepared = _prepare_for_format(image, image_format)
    output = io.BytesIO()
    save_options: dict[str, object] = {"format": image_format}
    if image_format == "PNG":
        save_options["optimize"] = True
        save_options["compress_level"] = 9 if normalized_operation == "compress" else 6
    else:
        save_options["quality"] = quality_value
        save_options["optimize"] = True
        if image_format == "WEBP":
            save_options["method"] = 6
    prepared.save(output, **save_options)
    result = output.getvalue()
    if not result or len(result) > MAX_OUTPUT_BYTES:
        raise ValueError("处理后的图片为空或超过 80 MB")
    return ImageToolResult(
        payload=result,
        extension=extension,
        content_type=content_type,
        width=prepared.width,
        height=prepared.height,
        original_bytes=len(payload),
    )
