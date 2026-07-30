from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import Any

from services.creative_workspace_service import CreativeWorkspaceService, creative_workspace_service
from services.image_storage_service import ImageStorageService, image_storage_service


module_logger = logging.getLogger(__name__)


def _clean(value: object) -> str:
    return str(value or "").strip()


class ImageIntegrityService:
    """Correlate durable workspace references with local and remote image copies."""

    def __init__(
        self,
        workspace: CreativeWorkspaceService = creative_workspace_service,
        storage: ImageStorageService = image_storage_service,
        *,
        cache_ttl_secs: float = 30.0,
    ):
        self.workspace = workspace
        self.storage = storage
        self.cache_ttl_secs = max(0.0, float(cache_ttl_secs))
        self._lock = threading.RLock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}

    @staticmethod
    def _cache_key(identity: dict[str, object], include_all: bool) -> str:
        if include_all and _clean(identity.get("role")).lower() == "admin":
            return "admin:all"
        return f"owner:{_clean(identity.get('id')) or 'anonymous'}"

    def invalidate(self) -> None:
        with self._lock:
            self._cache.clear()

    def scan(
        self,
        identity: dict[str, object],
        *,
        include_all: bool = False,
        force: bool = False,
    ) -> dict[str, Any]:
        key = self._cache_key(identity, include_all)
        now = time.time()
        with self._lock:
            cached = self._cache.get(key)
            if not force and cached and now - cached[0] < self.cache_ttl_secs:
                return dict(cached[1])

        references = self.workspace.list_image_references(identity, include_all=include_all)
        paths = list(dict.fromkeys(_clean(item.get("image_path")) for item in references if _clean(item.get("image_path"))))
        statuses = self.storage.inspect_paths(paths)
        references_by_path: dict[str, list[dict[str, str]]] = {}
        for reference in references:
            references_by_path.setdefault(_clean(reference.get("image_path")), []).append(reference)

        items: list[dict[str, object]] = []
        for status in statuses:
            path = _clean(status.get("path"))
            linked = references_by_path.get(path, [])
            items.append(
                {
                    **status,
                    "reference_count": len(linked),
                    "asset_ids": list(dict.fromkeys(_clean(item.get("asset_id")) for item in linked))[:20],
                    "asset_names": list(dict.fromkeys(_clean(item.get("asset_name")) for item in linked))[:5],
                }
            )

        backup_mode = self.storage.mode()
        backup_enabled = backup_mode in {"webdav", "both"}
        problems = [
            item
            for item in items
            if not item["exists"]
            or item["invalid_local"]
            or item["recoverable"]
            or (backup_enabled and item["local"] and not item["remote"])
        ]
        result: dict[str, Any] = {
            "summary": {
                "version_references": len(references),
                "unique_images": len(items),
                "available": sum(1 for item in items if item["exists"]),
                "missing": sum(1 for item in items if not item["exists"]),
                "recoverable": sum(1 for item in items if item["recoverable"]),
                "backed_up": sum(1 for item in items if item["backed_up"]),
                "local_only": sum(1 for item in items if item["local"] and not item["remote"]),
                "remote_only": sum(1 for item in items if item["remote"] and not item["local"]),
                "invalid_local": sum(1 for item in items if item["invalid_local"]),
                "backup_mode": backup_mode,
            },
            "items": items,
            "problems": problems,
            "scanned_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        with self._lock:
            self._cache[key] = (now, result)
        return dict(result)

    def repair(self, identity: dict[str, object], *, include_all: bool = False) -> dict[str, Any]:
        before = self.scan(identity, include_all=include_all, force=True)
        restored: list[str] = []
        backed_up: list[str] = []
        failed: list[dict[str, str]] = []

        for item in before["items"]:
            path = _clean(item.get("path"))
            if item.get("recoverable"):
                try:
                    self.storage.restore_local(path)
                    restored.append(path)
                except Exception as exc:
                    module_logger.warning("image restore failed for %s: %s", path, type(exc).__name__)
                    failed.append({"path": path, "error": "远端备份读取失败"})

        mode = self.storage.mode()
        if mode in {"webdav", "both"}:
            local_only = [
                _clean(item.get("path"))
                for item in before["items"]
                if item.get("local") and not item.get("remote")
            ]
            if local_only:
                backup_result = self.storage.backup_paths(local_only)
                backed_up.extend(str(path) for path in backup_result["uploaded"])
                failed.extend(dict(item) for item in backup_result["failed"])

        self.invalidate()
        after = self.scan(identity, include_all=include_all, force=True)
        return {
            "restored": restored,
            "backed_up": backed_up,
            "failed": failed,
            "before": before["summary"],
            "after": after["summary"],
            "summary": after["summary"],
            "items": after["items"],
            "problems": after["problems"],
            "scanned_at": after["scanned_at"],
        }


image_integrity_service = ImageIntegrityService()
