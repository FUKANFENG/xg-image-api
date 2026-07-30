from __future__ import annotations

import hashlib
import io
import json
import logging
import stat
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Iterable
from urllib.parse import quote, urlparse

from curl_cffi import requests
from fastapi import HTTPException
from PIL import Image

from services.config import DATA_DIR, config

IMAGE_INDEX_FILE = DATA_DIR / "image_index.json"
IMAGE_INDEX_LOCK = Lock()
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
IMAGE_VALIDATION_VERSION = 1
MIN_IMAGE_EDGE = 16
module_logger = logging.getLogger(__name__)


class ImageStorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class StoredImage:
    rel: str
    url: str
    storage: str
    size: int


def _clean(value: object) -> str:
    return str(value or "").strip()


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _safe_relative_path(path: str) -> str:
    raw_value = str(path or "").strip().replace("\\", "/")
    value = raw_value.lstrip("/")
    if not value:
        raise HTTPException(status_code=404, detail="image not found")
    parts = Path(value).parts
    is_unsafe = (
        raw_value.startswith("/")
        or Path(raw_value).is_absolute()
        or any(part in {"", ".", ".."} for part in parts)
        or (parts and ":" in parts[0])
    )
    if is_unsafe:
        raise HTTPException(status_code=404, detail="image not found")
    return Path(*parts).as_posix()


def _image_dimensions(payload: bytes) -> tuple[int, int] | None:
    try:
        with Image.open(io.BytesIO(payload)) as image:
            size = image.size
            image.verify()
            return size if min(size) >= MIN_IMAGE_EDGE else None
    except Exception:
        return None


def _is_image_rel(path: str) -> bool:
    try:
        safe_rel = _safe_relative_path(path)
    except HTTPException:
        return False
    return Path(safe_rel).suffix.lower() in IMAGE_EXTENSIONS


def _local_image_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    return config.images_dir / rel


def _read_json_object(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_json_object(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


class WebDAVClient:
    def __init__(self, settings: dict[str, object]):
        self.url = _clean(settings.get("webdav_url")).rstrip("/")
        self.username = _clean(settings.get("webdav_username"))
        self.password = _clean(settings.get("webdav_password"))
        self.root_path = _clean(settings.get("webdav_root_path")).strip("/")
        self.session = requests.Session()

    def _auth_kwargs(self) -> dict[str, object]:
        return {"auth": (self.username, self.password)} if self.username or self.password else {}

    def _request(self, method: str, url: str, **kwargs):
        response = self.session.request(method, url, timeout=30, **self._auth_kwargs(), **kwargs)
        if response.status_code >= 400 and not (method == "MKCOL" and response.status_code in {405}):
            raise ImageStorageError(f"WebDAV {method} failed: HTTP {response.status_code}")
        return response

    def remote_url(self, rel: str = "") -> str:
        parts = [part for part in [self.root_path, _safe_relative_path(rel) if rel else ""] if part]
        encoded = "/".join(quote(part, safe="") for item in parts for part in item.split("/") if part)
        return f"{self.url}/{encoded}" if encoded else self.url

    def ensure_dirs(self, rel: str) -> None:
        parts = [part for part in [self.root_path, Path(_safe_relative_path(rel)).parent.as_posix()] if part and part != "."]
        current = self.url
        for item in "/".join(parts).split("/"):
            if not item:
                continue
            current = f"{current}/{quote(item, safe='')}"
            response = self.session.request("MKCOL", current, timeout=30, **self._auth_kwargs())
            if response.status_code in {201, 405}:
                continue
            if response.status_code >= 400:
                raise ImageStorageError(f"WebDAV MKCOL failed: HTTP {response.status_code}")

    def put(self, rel: str, payload: bytes, content_type: str = "image/png") -> str:
        self.ensure_dirs(rel)
        url = self.remote_url(rel)
        self._request("PUT", url, data=payload, headers={"Content-Type": content_type})
        return url

    def get(self, rel: str) -> bytes:
        response = self._request("GET", self.remote_url(rel))
        return bytes(response.content)

    def delete(self, rel: str) -> bool:
        response = self.session.request("DELETE", self.remote_url(rel), timeout=30, **self._auth_kwargs())
        if response.status_code in {200, 202, 204, 404}:
            return response.status_code != 404
        raise ImageStorageError(f"WebDAV DELETE failed: HTTP {response.status_code}")

    def test(self) -> dict[str, object]:
        if not self.url:
            return {"ok": False, "status": 0, "error": "WebDAV URL is required"}
        if urlparse(self.url).scheme not in {"http", "https"}:
            return {"ok": False, "status": 0, "error": "invalid WebDAV URL"}
        test_rel = ".chatgpt2api_webdav_test.txt"
        try:
            self.put(test_rel, b"chatgpt2api webdav test\n", content_type="text/plain")
            self.delete(test_rel)
            return {"ok": True, "status": 200, "error": None}
        except ImageStorageError as exc:
            return {"ok": False, "status": 0, "error": str(exc)}
        except Exception as exc:
            return {"ok": False, "status": 0, "error": str(exc) or exc.__class__.__name__}
        finally:
            self.session.close()


class ImageStorageService:
    def __init__(self, index_file: Path = IMAGE_INDEX_FILE):
        self.index_file = index_file
        self._index_lock = IMAGE_INDEX_LOCK

    def settings(self) -> dict[str, object]:
        return config.get_image_storage_settings()

    def mode(self) -> str:
        return _clean(self.settings().get("mode")) or "local"

    def backup_readiness(self) -> dict[str, object]:
        """Return a safe, operator-facing summary without exposing WebDAV credentials."""
        settings = self.settings()
        mode = self.mode()
        remote_enabled = mode in {"webdav", "both"}
        remote_configured = bool(
            _clean(settings.get("webdav_url"))
            and _clean(settings.get("webdav_password"))
        )

        if not remote_enabled:
            return {
                "mode": "local",
                "status": "unprotected",
                "remote_enabled": False,
                "remote_configured": False,
                "recommendation": "当前图片仅保存在本机；启用“本机 + WebDAV”后可获得异机副本。",
            }
        if not remote_configured:
            return {
                "mode": mode,
                "status": "misconfigured",
                "remote_enabled": True,
                "remote_configured": False,
                "recommendation": "远端图片存储配置不完整，请在系统设置中补齐后再验证连接。",
            }
        if mode == "both":
            return {
                "mode": "both",
                "status": "protected",
                "remote_enabled": True,
                "remote_configured": True,
                "recommendation": "新图片会同时保存到本机和 WebDAV；请定期检查待补传数量。",
            }
        return {
            "mode": "webdav",
            "status": "warning",
            "remote_enabled": True,
            "remote_configured": True,
            "recommendation": "当前图片只保存到 WebDAV；建议改为“本机 + WebDAV”以保留本地恢复副本。",
        }

    def _load_index(self) -> dict[str, dict[str, object]]:
        raw = _read_json_object(self.index_file)
        items = raw.get("items")
        if not isinstance(items, dict):
            return {}
        return {str(key): value for key, value in items.items() if isinstance(value, dict)}

    def _load_clean_index(self) -> dict[str, dict[str, object]]:
        items = self._load_index()
        return {rel: item for rel, item in items.items() if _is_image_rel(rel)}

    def _save_index(self, items: dict[str, dict[str, object]]) -> None:
        _write_json_object(self.index_file, {"items": items})

    def _public_url(self, rel: str, base_url: str | None = None) -> str:
        settings = self.settings()
        public_base_url = _clean(settings.get("public_base_url"))
        if public_base_url:
            return f"{public_base_url.rstrip('/')}/{_safe_relative_path(rel)}"
        return f"{(base_url or config.base_url).rstrip('/')}/images/{_safe_relative_path(rel)}"

    def make_relative_path(self, image_data: bytes, extension: str = "png") -> str:
        file_hash = hashlib.md5(image_data).hexdigest()
        safe_extension = _clean(extension).lower().lstrip(".")
        if safe_extension == "jpeg":
            safe_extension = "jpg"
        if f".{safe_extension}" not in IMAGE_EXTENSIONS:
            safe_extension = "png"
        filename = f"{int(time.time())}_{file_hash}.{safe_extension}"
        relative_dir = Path(time.strftime("%Y"), time.strftime("%m"), time.strftime("%d"))
        return f"{relative_dir.as_posix()}/{filename}"

    def save(self, image_data: bytes, base_url: str | None = None, extension: str = "png") -> StoredImage:
        dimensions = _image_dimensions(image_data)
        if dimensions is None:
            raise ImageStorageError("generated payload is not a valid image")
        config.cleanup_old_images()
        rel = self.make_relative_path(image_data, extension)
        mode = self.mode()
        if mode not in {"local", "webdav", "both"}:
            mode = "local"
        stored_local = False
        stored_webdav = False
        remote_url = ""

        if mode in {"local", "both"}:
            path = _local_image_path(rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(image_data)
            stored_local = True

        if mode in {"webdav", "both"}:
            content_type = {
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
            }.get(Path(rel).suffix.lower(), "image/png")
            client = WebDAVClient(self.settings())
            remote_url = (
                client.put(rel, image_data)
                if content_type == "image/png"
                else client.put(rel, image_data, content_type)
            )
            stored_webdav = True

        item = {
            "rel": rel,
            "path": rel,
            "name": Path(rel).name,
            "date": "-".join(rel.split("/")[:3]),
            "size": len(image_data),
            "created_at": _now_iso(),
            "storage": "both" if stored_local and stored_webdav else ("webdav" if stored_webdav else "local"),
            "local": stored_local,
            "webdav": stored_webdav,
            "remote_url": remote_url,
            "valid": True,
            "_validation_version": IMAGE_VALIDATION_VERSION,
        }
        item["width"], item["height"] = dimensions
        if stored_local:
            local_stat = _local_image_path(rel).stat()
            item["_validated_size"] = local_stat.st_size
            item["_validated_mtime_ns"] = local_stat.st_mtime_ns
        with self._index_lock:
            items = self._load_clean_index()
            items[rel] = item
            self._save_index(items)
        return StoredImage(rel=rel, url=self._public_url(rel, base_url), storage=str(item["storage"]), size=len(image_data))

    def get_bytes(self, rel: str) -> bytes:
        safe_rel = _safe_relative_path(rel)
        if not _is_image_rel(safe_rel):
            raise HTTPException(status_code=404, detail="image not found")
        path = _local_image_path(safe_rel)
        if path.is_file():
            return path.read_bytes()
        item = self._load_clean_index().get(safe_rel, {})
        if item.get("webdav"):
            return WebDAVClient(self.settings()).get(safe_rel)
        raise HTTPException(status_code=404, detail="image not found")

    def exists(self, rel: str) -> bool:
        safe_rel = _safe_relative_path(rel)
        if not _is_image_rel(safe_rel):
            return False
        if _local_image_path(safe_rel).is_file():
            return True
        item = self._load_clean_index().get(safe_rel, {})
        return bool(item.get("webdav"))

    def has_local(self, rel: str) -> bool:
        safe_rel = _safe_relative_path(rel)
        return _is_image_rel(safe_rel) and _local_image_path(safe_rel).is_file()

    def existing_paths(self, relative_paths: set[str]) -> set[str]:
        with self._index_lock:
            indexed = self._load_clean_index()
        existing: set[str] = set()
        for value in relative_paths:
            if not _is_image_rel(value):
                continue
            rel = _safe_relative_path(value)
            item = indexed.get(rel, {})
            local_valid = bool(item.get("local")) and item.get("valid") is not False
            if local_valid or bool(item.get("webdav")):
                existing.add(rel)
        return existing

    def inspect_paths(self, relative_paths: Iterable[str]) -> list[dict[str, object]]:
        """Return reference-aware local and remote health without exposing storage credentials."""
        ordered: list[str] = []
        for value in relative_paths:
            try:
                rel = _safe_relative_path(value)
            except HTTPException:
                continue
            if rel not in ordered:
                ordered.append(rel)
        with self._index_lock:
            indexed = self._load_clean_index()
        items: list[dict[str, object]] = []
        for rel in ordered:
            record = indexed.get(rel, {})
            physical_local = _local_image_path(rel).is_file()
            local = physical_local and record.get("valid") is not False
            remote = bool(record.get("webdav"))
            items.append(
                {
                    "path": rel,
                    "exists": local or remote,
                    "local": local,
                    "remote": remote,
                    "recoverable": not local and remote,
                    "backed_up": local and remote,
                    "invalid_local": physical_local and not local,
                    "size_bytes": int(record.get("size") or 0),
                    "width": int(record.get("width") or 0),
                    "height": int(record.get("height") or 0),
                    "created_at": str(record.get("created_at") or ""),
                    "storage": (
                        "both"
                        if local and remote
                        else "local"
                        if local
                        else "webdav"
                        if remote
                        else "missing"
                    ),
                }
            )
        return items

    def restore_local(self, rel: str) -> dict[str, object]:
        """Restore the exact indexed path from WebDAV so existing asset references remain valid."""
        safe_rel = _safe_relative_path(rel)
        with self._index_lock:
            indexed = self._load_clean_index()
            item = dict(indexed.get(safe_rel, {}))
        if not item.get("webdav"):
            raise ImageStorageError("图片没有可用的远端备份")
        payload = WebDAVClient(self.settings()).get(safe_rel)
        dimensions = _image_dimensions(payload)
        if dimensions is None:
            raise ImageStorageError("远端备份不是有效图片")
        path = _local_image_path(safe_rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f".{path.name}.{time.time_ns()}.restore")
        try:
            temp_path.write_bytes(payload)
            temp_path.replace(path)
        finally:
            temp_path.unlink(missing_ok=True)
        path_stat = path.stat()
        with self._index_lock:
            indexed = self._load_clean_index()
            indexed[safe_rel] = {
                **item,
                "rel": safe_rel,
                "path": safe_rel,
                "name": path.name,
                "size": len(payload),
                "storage": "both",
                "local": True,
                "webdav": True,
                "valid": True,
                "width": dimensions[0],
                "height": dimensions[1],
                "_validation_version": IMAGE_VALIDATION_VERSION,
                "_validated_size": path_stat.st_size,
                "_validated_mtime_ns": path_stat.st_mtime_ns,
            }
            self._save_index(indexed)
        return self.inspect_paths([safe_rel])[0]

    def backup_paths(self, relative_paths: Iterable[str]) -> dict[str, object]:
        """Add remote copies for selected local images without scanning unrelated users' files."""
        if self.mode() not in {"webdav", "both"}:
            raise ImageStorageError("WebDAV 图片备份未启用")
        statuses = self.inspect_paths(relative_paths)
        uploaded: list[str] = []
        skipped: list[str] = []
        failed: list[dict[str, str]] = []
        client = WebDAVClient(self.settings())
        for status in statuses:
            rel = str(status["path"])
            if status["remote"]:
                skipped.append(rel)
                continue
            if not status["local"]:
                failed.append({"path": rel, "error": "本地图片不存在"})
                continue
            try:
                payload = _local_image_path(rel).read_bytes()
                remote_url = client.put(rel, payload)
                with self._index_lock:
                    indexed = self._load_clean_index()
                    item = dict(indexed.get(rel, {}))
                    indexed[rel] = {
                        **item,
                        "rel": rel,
                        "path": rel,
                        "name": Path(rel).name,
                        "size": len(payload),
                        "storage": "both",
                        "local": True,
                        "webdav": True,
                        "remote_url": remote_url,
                        "valid": True,
                    }
                    self._save_index(indexed)
                uploaded.append(rel)
            except Exception as exc:
                module_logger.warning("image backup failed for %s: %s", rel, type(exc).__name__)
                failed.append({"path": rel, "error": "远端备份写入失败"})
        return {"uploaded": uploaded, "skipped": skipped, "failed": failed}

    def list_items(self, base_url: str, start_date: str = "", end_date: str = "") -> list[dict[str, object]]:
        with self._index_lock:
            indexed = self._load_clean_index()
            root = config.images_dir
            local_files = {}
            changed = False
            for path in root.rglob("*"):
                try:
                    path_stat = path.stat()
                except OSError:
                    continue
                if not stat.S_ISREG(path_stat.st_mode) or not _is_image_rel(path.name):
                    continue
                rel = path.relative_to(root).as_posix()
                local_files[rel] = (path, path_stat)
                if rel in indexed:
                    continue
                dimensions = None
                try:
                    dimensions = _image_dimensions(path.read_bytes())
                except Exception:
                    dimensions = None
                indexed[rel] = {
                    "rel": rel,
                    "path": rel,
                    "name": path.name,
                    "date": "-".join(rel.split("/")[:3]) if len(rel.split("/")) >= 4 else datetime.fromtimestamp(path_stat.st_mtime).strftime("%Y-%m-%d"),
                    "size": path_stat.st_size,
                    "created_at": datetime.fromtimestamp(path_stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                    "storage": "local",
                    "local": True,
                    "webdav": False,
                    "valid": dimensions is not None,
                    "_validation_version": IMAGE_VALIDATION_VERSION,
                    "_validated_size": path_stat.st_size,
                    "_validated_mtime_ns": path_stat.st_mtime_ns,
                    **({"width": dimensions[0], "height": dimensions[1]} if dimensions else {}),
                }
                changed = True

            items: list[dict[str, object]] = []
            for rel, item in list(indexed.items()):
                if not _is_image_rel(rel):
                    indexed.pop(rel, None)
                    changed = True
                    continue
                local_entry = local_files.get(rel)
                local = local_entry is not None
                webdav = bool(item.get("webdav"))
                if not local and not webdav:
                    indexed.pop(rel, None)
                    changed = True
                    continue
                storage = "both" if local and webdav else ("webdav" if webdav else "local")
                if local_entry is not None:
                    local_path, local_stat = local_entry
                    needs_validation = (
                        "valid" not in item
                        or item.get("_validation_version") != IMAGE_VALIDATION_VERSION
                        or item.get("_validated_size") != local_stat.st_size
                        or item.get("_validated_mtime_ns") != local_stat.st_mtime_ns
                    )
                    if needs_validation:
                        dimensions = _image_dimensions(local_path.read_bytes())
                        item = {
                            **item,
                            "size": local_stat.st_size,
                            "valid": dimensions is not None,
                            "_validation_version": IMAGE_VALIDATION_VERSION,
                            "_validated_size": local_stat.st_size,
                            "_validated_mtime_ns": local_stat.st_mtime_ns,
                        }
                        if dimensions:
                            item["width"], item["height"] = dimensions
                        else:
                            item.pop("width", None)
                            item.pop("height", None)
                        indexed[rel] = item
                        changed = True
                if item.get("local") != local or item.get("storage") != storage:
                    item = {
                        **item,
                        "local": local,
                        "storage": storage,
                    }
                    indexed[rel] = item
                    changed = True
                if local and item.get("valid") is False:
                    continue
                day = str(item.get("date") or "")
                if start_date and day < start_date:
                    continue
                if end_date and day > end_date:
                    continue
                items.append({
                    **{key: value for key, value in item.items() if not key.startswith("_")},
                    "rel": rel,
                    "path": rel,
                    "url": self._public_url(rel, base_url),
                })
            if changed:
                self._save_index(indexed)
        items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return items

    def delete(self, rel: str) -> bool:
        safe_rel = _safe_relative_path(rel)
        removed = False
        path = _local_image_path(safe_rel)
        if path.is_file():
            path.unlink()
            removed = True
        with self._index_lock:
            items = self._load_clean_index()
            item = items.get(safe_rel, {})
            if item.get("webdav"):
                try:
                    removed = WebDAVClient(self.settings()).delete(safe_rel) or removed
                except ImageStorageError:
                    if not removed:
                        raise
            if safe_rel in items:
                items.pop(safe_rel, None)
                self._save_index(items)
        return removed

    def sync_all(self) -> dict[str, int]:
        settings = self.settings()
        if self.mode() not in {"webdav", "both"}:
            raise ImageStorageError("WebDAV 图片存储未启用")
        uploaded = 0
        skipped = 0
        failed = 0
        with self._index_lock:
            items = self._load_clean_index()
            client = WebDAVClient(settings)
            for path in sorted(config.images_dir.rglob("*")):
                if not path.is_file() or not _is_image_rel(path.name):
                    continue
                rel = path.relative_to(config.images_dir).as_posix()
                item = items.get(rel, {})
                if item.get("webdav"):
                    skipped += 1
                    continue
                try:
                    payload = path.read_bytes()
                    remote_url = client.put(rel, payload)
                    dimensions = _image_dimensions(payload)
                    items[rel] = {
                        **item,
                        "rel": rel,
                        "path": rel,
                        "name": path.name,
                        "date": "-".join(rel.split("/")[:3]) if len(rel.split("/")) >= 4 else datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d"),
                        "size": len(payload),
                        "created_at": str(item.get("created_at") or datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")),
                        "storage": "both",
                        "local": True,
                        "webdav": True,
                        "remote_url": remote_url,
                        **({"width": dimensions[0], "height": dimensions[1]} if dimensions else {}),
                    }
                    uploaded += 1
                except Exception:
                    failed += 1
            self._save_index(items)
        return {"uploaded": uploaded, "skipped": skipped, "failed": failed}

    def test_webdav(self) -> dict[str, object]:
        return WebDAVClient(self.settings()).test()


image_storage_service = ImageStorageService()
