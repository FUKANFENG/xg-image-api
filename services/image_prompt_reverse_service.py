from __future__ import annotations

import json
import re
import time
from typing import Any

from services.protocol.conversation import ConversationRequest, collect_text, text_backend
from utils.log import logger


MAX_PROMPT_LENGTH = 4_000
MAX_PURPOSE_LENGTH = 500
_DETAILS = {
    "concise": "用精简语言保留主体、构图和风格，提示词控制在 200 字以内。",
    "standard": "完整描述主体、环境、构图、镜头、光线、色彩和风格。",
    "professional": "按专业视觉制作标准描述材质、空间、镜头、光线、色彩、后期质感和画面文字。",
}
_REASONING_BLOCK = re.compile(r"<think\b[^>]*>.*?</think\s*>", re.IGNORECASE | re.DOTALL)
_FENCED_JSON = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.IGNORECASE | re.DOTALL)

REVERSE_PROMPT_SYSTEM_INSTRUCTIONS = """你是专业的 AI 图片提示词反推助手。
准确分析用户上传的图片，生成一条可直接用于 AI 生图的中文提示词。忠实描述可见内容，不猜测真实人物身份，
不虚构看不见的品牌、文字或细节。必须只输出一个 JSON 对象，不要解释、标题或 Markdown。
JSON 字段固定为：prompt、summary、subject、composition、lighting、colors、style、text_content。
prompt、summary、subject、composition、lighting、style 为字符串；colors、text_content 为字符串数组。
如果图片没有可辨识文字，text_content 返回空数组。"""

LOCAL_EDIT_SYSTEM_INSTRUCTIONS = """你是专业的图片局部修改助手。分析图片中可编辑的人物、商品、文字、Logo 和背景区域。
只输出 JSON 对象，不要输出 Markdown。格式为：
{"regions":[{"type":"person|product|text|logo|background","label":"区域名称","x":0.0,"y":0.0,"width":0.5,"height":0.5,"confidence":0.9,"issue":"可见问题","suggestion":"局部修改指令"}],"global_suggestion":"整体建议"}。
x、y、width、height 必须是相对图片宽高的 0 到 1 数值，矩形不得超出图片。仅描述可见内容，不猜测身份或品牌。"""


class ImagePromptReverseError(RuntimeError):
    """Base error with a user-facing message."""


class ImagePromptReverseProviderError(ImagePromptReverseError):
    pass


def _clean(value: object, limit: int = MAX_PROMPT_LENGTH) -> str:
    return str(value or "").strip()[:limit].rstrip()


def _string_list(value: object) -> list[str]:
    if isinstance(value, list):
        source = value
    elif isinstance(value, str):
        source = re.split(r"[、,，;；\n]+", value)
    else:
        source = []
    items: list[str] = []
    for item in source:
        normalized = _clean(item, 120)
        if normalized and normalized not in items:
            items.append(normalized)
    return items[:20]


def _json_payload(text: str) -> dict[str, Any] | None:
    fenced = _FENCED_JSON.search(text)
    candidates = [fenced.group(1)] if fenced else []
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        candidates.append(text[first : last + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            return value
    return None


def parse_reverse_prompt_response(value: object) -> dict[str, object]:
    text = _REASONING_BLOCK.sub("", str(value or "")).strip()
    data = _json_payload(text)
    if data is None:
        prompt = text.strip().strip('"“”')
        data = {"prompt": prompt} if prompt else {}

    prompt = _clean(data.get("prompt"))
    if not prompt:
        raise ImagePromptReverseProviderError("图片分析服务未返回有效提示词，请稍后重试。")
    return {
        "prompt": prompt,
        "summary": _clean(data.get("summary"), 500),
        "subject": _clean(data.get("subject"), 1_000),
        "composition": _clean(data.get("composition"), 1_000),
        "lighting": _clean(data.get("lighting"), 1_000),
        "colors": _string_list(data.get("colors")),
        "style": _clean(data.get("style"), 1_000),
        "text_content": _string_list(data.get("text_content")),
    }


def _messages(payload: bytes, mime_type: str, detail: str, purpose: str) -> list[dict[str, object]]:
    detail_instruction = _DETAILS.get(detail, _DETAILS["standard"])
    purpose_instruction = f"图片用途或用户重点：{purpose}" if purpose else ""
    user_text = "\n".join(item for item in (detail_instruction, purpose_instruction) if item)
    return [
        {"role": "system", "content": REVERSE_PROMPT_SYSTEM_INSTRUCTIONS},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image", "data": payload, "mime": mime_type},
            ],
        },
    ]


def reverse_image_prompt(
    payload: bytes,
    filename: str,
    mime_type: str,
    *,
    detail: str = "standard",
    purpose: str = "",
) -> dict[str, object]:
    if not payload:
        raise ValueError("请上传需要分析的图片。")
    normalized_mime = _clean(mime_type, 80).lower()
    if not normalized_mime.startswith("image/"):
        raise ValueError("仅支持图片文件。")
    normalized_detail = detail if detail in _DETAILS else "standard"
    normalized_purpose = _clean(purpose, MAX_PURPOSE_LENGTH)
    started = time.monotonic()
    try:
        content = collect_text(
            text_backend(),
            ConversationRequest(
                model="auto",
                messages=_messages(payload, normalized_mime, normalized_detail, normalized_purpose),
            ),
        )
        result = parse_reverse_prompt_response(content)
    except ImagePromptReverseError:
        raise
    except Exception as exc:
        logger.warning(
            {
                "event": "image_prompt_reverse_failed",
                "error_type": exc.__class__.__name__,
                "filename": _clean(filename, 160),
                "payload_bytes": len(payload),
            }
        )
        raise ImagePromptReverseProviderError("图片分析服务暂时不可用，请稍后重试。") from exc
    return {
        **result,
        "model": "auto",
        "elapsed_ms": max(0, round((time.monotonic() - started) * 1_000)),
    }


def _bounded_float(value: object, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(0.0, min(1.0, parsed))


def parse_local_edit_response(value: object) -> dict[str, object]:
    text = _REASONING_BLOCK.sub("", str(value or "")).strip()
    data = _json_payload(text)
    if not isinstance(data, dict):
        raise ImagePromptReverseProviderError("局部修改分析未返回有效区域，请稍后重试。")
    raw_regions = data.get("regions") if isinstance(data.get("regions"), list) else []
    regions: list[dict[str, object]] = []
    allowed_types = {"person", "product", "text", "logo", "background"}
    for raw in raw_regions[:20]:
        if not isinstance(raw, dict):
            continue
        region_type = _clean(raw.get("type"), 40).lower()
        if region_type not in allowed_types:
            continue
        x = _bounded_float(raw.get("x"))
        y = _bounded_float(raw.get("y"))
        width = min(_bounded_float(raw.get("width"), 0.1), 1.0 - x)
        height = min(_bounded_float(raw.get("height"), 0.1), 1.0 - y)
        if width <= 0 or height <= 0:
            continue
        regions.append(
            {
                "id": f"region-{len(regions) + 1}",
                "type": region_type,
                "label": _clean(raw.get("label"), 120) or region_type,
                "x": round(x, 4),
                "y": round(y, 4),
                "width": round(width, 4),
                "height": round(height, 4),
                "confidence": round(_bounded_float(raw.get("confidence"), 0.5), 3),
                "issue": _clean(raw.get("issue"), 500),
                "suggestion": _clean(raw.get("suggestion"), 1_000),
            }
        )
    if not regions:
        raise ImagePromptReverseProviderError("没有识别到可安全局部修改的区域，请换一张更清晰的图片。")
    return {
        "regions": regions,
        "global_suggestion": _clean(data.get("global_suggestion"), 1_000),
    }


def suggest_local_edits(
    payload: bytes,
    filename: str,
    mime_type: str,
    *,
    instruction: str = "",
) -> dict[str, object]:
    if not payload:
        raise ValueError("请上传需要分析的图片。")
    normalized_mime = _clean(mime_type, 80).lower()
    if not normalized_mime.startswith("image/"):
        raise ValueError("仅支持图片文件。")
    user_instruction = _clean(instruction, 1_000)
    started = time.monotonic()
    try:
        content = collect_text(
            text_backend(),
            ConversationRequest(
                model="auto",
                messages=[
                    {"role": "system", "content": LOCAL_EDIT_SYSTEM_INSTRUCTIONS},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_instruction or "识别适合局部修改的区域并给出建议。"},
                            {"type": "image", "data": payload, "mime": normalized_mime},
                        ],
                    },
                ],
            ),
        )
        result = parse_local_edit_response(content)
    except ImagePromptReverseError:
        raise
    except Exception as exc:
        logger.warning(
            {
                "event": "local_edit_suggestion_failed",
                "error_type": exc.__class__.__name__,
                "filename": _clean(filename, 160),
                "payload_bytes": len(payload),
            }
        )
        raise ImagePromptReverseProviderError("局部修改分析暂时不可用，请稍后重试。") from exc
    return {
        **result,
        "model": "auto",
        "elapsed_ms": max(0, round((time.monotonic() - started) * 1_000)),
    }
