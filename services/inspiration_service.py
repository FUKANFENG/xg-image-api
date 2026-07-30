from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.config import INSPIRATIONS_FILE
from services.image_storage_service import image_storage_service


_MAX_TITLE_LENGTH = 72
_MAX_PROMPT_LENGTH = 4_000
_CURATED_CATEGORY = "curated"
_CURATED_CATEGORY_LABEL = "用户精选"
_CURATED_LEVEL = "创意"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _compact(value: str, limit: int) -> str:
    return re.sub(r"\s+", " ", value).strip()[:limit]


def _title_from_prompt(prompt: str) -> str:
    compact_prompt = _compact(prompt, _MAX_TITLE_LENGTH)
    if not compact_prompt:
        return "管理员精选灵感"
    return compact_prompt.rstrip("。；，、,;:：") or "管理员精选灵感"


def _safe_local_preview(value: object) -> str:
    preview = _clean(value)
    path = preview.split("?", 1)[0]
    path_parts = path.split("/")
    if not path.startswith("/images/") or ".." in path_parts:
        raise ValueError("该任务图片未保存在本地，暂时无法收录到灵感库")
    return path


class InspirationService:
    """Persist only administrator-approved user image prompts for the public inspiration library."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.archive_dir = path.parent / "inspiration_images"
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._items = self._load_locked()

    def list_public(self) -> list[dict[str, object]]:
        with self._lock:
            items = [self._public_item(item) for item in self._items]
        return sorted(items, key=lambda item: str(item.get("published_at") or ""), reverse=True)

    def has_source(self, owner_id: str, task_id: str, image_index: int) -> bool:
        normalized_owner = _clean(owner_id)
        normalized_task = _clean(task_id)
        with self._lock:
            return any(
                item.get("source_owner_id") == normalized_owner
                and item.get("source_task_id") == normalized_task
                and item.get("source_image_index") == image_index
                for item in self._items
            )

    def get_archived_image_path(self, image_name: str) -> Path:
        candidate = Path(_clean(image_name))
        if candidate.name != str(candidate) or candidate.suffix.lower() != ".png":
            raise LookupError("灵感图片不存在")
        path = self.archive_dir / candidate.name
        if not path.is_file():
            raise LookupError("灵感图片不存在")
        return path

    def curate_from_task(self, source: dict[str, object]) -> tuple[dict[str, object], bool]:
        owner_id = _clean(source.get("owner_id"))
        task_id = _clean(source.get("task_id"))
        image_index = int(source.get("image_index") or 0)
        prompt = _compact(_clean(source.get("prompt")), _MAX_PROMPT_LENGTH)
        preview = _safe_local_preview(source.get("preview_url"))
        if not owner_id or not task_id or not prompt:
            raise ValueError("收录来源缺少必要的任务信息")

        with self._lock:
            for item in self._items:
                if (
                    item.get("source_owner_id") == owner_id
                    and item.get("source_task_id") == task_id
                    and item.get("source_image_index") == image_index
                ):
                    return self._public_item(item), False

            item_id = f"curated-{uuid.uuid4().hex}"
            archive_name = f"{item_id}.png"
            archive_path = self._archive_source_image(preview, archive_name)
            item: dict[str, object] = {
                "id": item_id,
                "title": _title_from_prompt(prompt),
                "prompt": prompt,
                "size": _clean(source.get("size"), "1024x1024"),
                "quality": _clean(source.get("quality"), "auto"),
                "category": _CURATED_CATEGORY,
                "category_label": _CURATED_CATEGORY_LABEL,
                "level": _CURATED_LEVEL,
                "preview": f"/inspiration-images/{archive_name}",
                "archive_name": archive_name,
                "description": "由管理员从用户原创作品中精选收录，可复制提示词后继续创作。",
                "tags": ["用户精选", "管理员收录"],
                "published_at": _now_iso(),
                "source_owner_id": owner_id,
                "source_task_id": task_id,
                "source_image_index": image_index,
            }
            self._items.append(item)
            try:
                self._save_locked()
            except Exception:
                self._items.pop()
                archive_path.unlink(missing_ok=True)
                raise
            return self._public_item(item), True

    def _load_locked(self) -> list[dict[str, object]]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"无法读取灵感库数据：{self.path}") from exc
        raw_items = raw.get("items") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            raise RuntimeError(f"灵感库数据格式无效：{self.path}")

        items: list[dict[str, object]] = []
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue
            archive_name = _clean(raw_item.get("archive_name"))
            if archive_name:
                try:
                    self.get_archived_image_path(archive_name)
                except LookupError:
                    continue
                preview = f"/inspiration-images/{archive_name}"
            else:
                # Support pre-existing local records while all new entries use a durable archive.
                try:
                    preview = _safe_local_preview(raw_item.get("preview"))
                except ValueError:
                    continue
            source_owner_id = _clean(raw_item.get("source_owner_id"))
            source_task_id = _clean(raw_item.get("source_task_id"))
            prompt = _compact(_clean(raw_item.get("prompt")), _MAX_PROMPT_LENGTH)
            if not source_owner_id or not source_task_id or not prompt:
                continue
            image_index = raw_item.get("source_image_index")
            if not isinstance(image_index, int) or isinstance(image_index, bool) or image_index < 0:
                continue
            items.append({
                "id": _clean(raw_item.get("id")) or f"curated-{uuid.uuid4().hex}",
                "title": _compact(_clean(raw_item.get("title")), _MAX_TITLE_LENGTH) or _title_from_prompt(prompt),
                "prompt": prompt,
                "size": _clean(raw_item.get("size"), "1024x1024"),
                "quality": _clean(raw_item.get("quality"), "auto"),
                "category": _CURATED_CATEGORY,
                "category_label": _CURATED_CATEGORY_LABEL,
                "level": _CURATED_LEVEL,
                "preview": preview,
                **({"archive_name": archive_name} if archive_name else {}),
                "description": _compact(_clean(raw_item.get("description")), 240) or "由管理员从用户原创作品中精选收录，可复制提示词后继续创作。",
                "tags": [str(tag).strip() for tag in raw_item.get("tags", []) if str(tag).strip()][:8] or ["用户精选", "管理员收录"],
                "published_at": _clean(raw_item.get("published_at"), _now_iso()),
                "source_owner_id": source_owner_id,
                "source_task_id": source_task_id,
                "source_image_index": image_index,
            })
        return items

    def _archive_source_image(self, preview: str, archive_name: str) -> Path:
        source_rel = preview.removeprefix("/images/")
        if not source_rel:
            raise ValueError("该任务图片未保存在本地，暂时无法收录到灵感库")
        try:
            payload = image_storage_service.get_bytes(source_rel)
        except Exception as exc:
            raise ValueError("无法读取原始图片，暂时无法收录到灵感库") from exc
        if not payload:
            raise ValueError("原始图片为空，暂时无法收录到灵感库")
        archive_path = self.archive_dir / archive_name
        fd, temporary_name = tempfile.mkstemp(dir=self.archive_dir, prefix=f".{archive_name}.", suffix=".tmp")
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                fd = -1
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, archive_path)
        finally:
            if fd >= 0:
                os.close(fd)
            temporary_path.unlink(missing_ok=True)
        return archive_path

    def _save_locked(self) -> None:
        payload = json.dumps({"items": self._items}, ensure_ascii=False, indent=2) + "\n"
        fd, temporary_name = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.", suffix=".tmp")
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                fd = -1
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if fd >= 0:
                os.close(fd)
            temporary_path.unlink(missing_ok=True)

    @staticmethod
    def _public_item(item: dict[str, object]) -> dict[str, object]:
        return {
            "id": item["id"],
            "title": item["title"],
            "prompt": item["prompt"],
            "size": item["size"],
            "quality": item["quality"],
            "category": item["category"],
            "category_label": item["category_label"],
            "level": item["level"],
            "preview": item["preview"],
            "description": item["description"],
            "tags": list(item["tags"]),
            "published_at": item["published_at"],
        }


inspiration_service = InspirationService(INSPIRATIONS_FILE)
