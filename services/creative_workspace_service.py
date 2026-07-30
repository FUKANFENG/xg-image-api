from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit

from services.config import DATA_DIR


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean(value: object, default: str = "") -> str:
    text = str(value if value is not None else default).strip()
    return text or default


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _json_dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_load(value: object, default: Any) -> Any:
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed


def _normalize_tags(value: object) -> list[str]:
    source: Iterable[object]
    if isinstance(value, str):
        source = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        source = value
    else:
        source = []
    tags: list[str] = []
    for item in source:
        tag = _clean(item)
        if tag and tag not in tags:
            tags.append(tag[:32])
        if len(tags) >= 20:
            break
    return tags


def _image_path_from_url(value: object) -> str:
    source = _clean(value)
    if not source:
        return ""
    try:
        path = unquote(urlsplit(source).path)
    except ValueError:
        path = source.split("?", 1)[0]
    marker = "/images/"
    if marker in path:
        return path.split(marker, 1)[1].strip("/")
    if path.startswith("images/"):
        return path.removeprefix("images/").strip("/")
    return ""


def portable_image_url(value: object, image_path: object = "") -> str:
    """Keep locally stored images bound to the current application origin."""
    source = _clean(value)
    local_path = _clean(image_path) or _image_path_from_url(source)
    if not local_path:
        return source
    if not source or _image_path_from_url(source):
        return f"/images/{local_path.strip('/')}"
    return source


class CreativeWorkspaceService:
    """Persistent project, batch, asset, version and conversation relationships."""

    def __init__(self, path: Path = DATA_DIR / "creative_workspace.db"):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._rate_events: dict[str, deque[float]] = {}
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _ensure_column(connection: sqlite3.Connection, table: str, name: str, definition: str) -> None:
        columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
        if name not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS creative_projects (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    favorite INTEGER NOT NULL DEFAULT 0,
                    tags TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_projects_owner_updated
                    ON creative_projects(owner_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_assets (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    project_id TEXT,
                    name TEXT NOT NULL,
                    asset_type TEXT NOT NULL,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    tags TEXT NOT NULL DEFAULT '[]',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    current_version_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES creative_projects(id) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_assets_owner_project
                    ON creative_assets(owner_id, project_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_versions (
                    id TEXT PRIMARY KEY,
                    asset_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    parent_version_id TEXT,
                    task_id TEXT NOT NULL,
                    image_index INTEGER NOT NULL DEFAULT 0,
                    version_number INTEGER NOT NULL,
                    operation TEXT NOT NULL,
                    image_path TEXT NOT NULL DEFAULT '',
                    image_url TEXT NOT NULL DEFAULT '',
                    prompt TEXT NOT NULL DEFAULT '',
                    params TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(asset_id) REFERENCES creative_assets(id) ON DELETE CASCADE,
                    FOREIGN KEY(parent_version_id) REFERENCES creative_versions(id) ON DELETE SET NULL,
                    UNIQUE(owner_id, task_id, image_index)
                );
                CREATE INDEX IF NOT EXISTS idx_creative_versions_asset_number
                    ON creative_versions(asset_id, version_number DESC);

                CREATE TABLE IF NOT EXISTS creative_batches (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    name TEXT NOT NULL,
                    settings TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_batches_owner_updated
                    ON creative_batches(owner_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_batch_items (
                    id TEXT PRIMARY KEY,
                    batch_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    source_name TEXT NOT NULL DEFAULT '',
                    source_path TEXT NOT NULL DEFAULT '',
                    prompt TEXT NOT NULL DEFAULT '',
                    params TEXT NOT NULL DEFAULT '{}',
                    submit_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(batch_id) REFERENCES creative_batches(id) ON DELETE CASCADE,
                    UNIQUE(owner_id, task_id)
                );
                CREATE INDEX IF NOT EXISTS idx_creative_batch_items_batch
                    ON creative_batch_items(batch_id, created_at);

                CREATE TABLE IF NOT EXISTS creative_conversations (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(asset_id) REFERENCES creative_assets(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_creative_conversations_asset
                    ON creative_conversations(owner_id, asset_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    task_id TEXT NOT NULL DEFAULT '',
                    version_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'success',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(conversation_id) REFERENCES creative_conversations(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_creative_messages_conversation
                    ON creative_messages(conversation_id, created_at);

                CREATE TABLE IF NOT EXISTS creative_policies (
                    subject_id TEXT PRIMARY KEY,
                    subject_type TEXT NOT NULL DEFAULT 'user',
                    features TEXT NOT NULL DEFAULT '{}',
                    rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,
                    frozen INTEGER NOT NULL DEFAULT 0,
                    abnormal_reason TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                );
                """
            )
            for table in ("creative_projects", "creative_assets", "creative_versions"):
                self._ensure_column(connection, table, "deleted_at", "TEXT NOT NULL DEFAULT ''")
            self._ensure_column(connection, "creative_versions", "branch_id", "TEXT")

    @staticmethod
    def _project(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "favorite": bool(row["favorite"]),
            "tags": _normalize_tags(_json_load(row["tags"], [])),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _asset(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "project_id": row["project_id"],
            "name": row["name"],
            "asset_type": row["asset_type"],
            "favorite": bool(row["favorite"]),
            "tags": _normalize_tags(_json_load(row["tags"], [])),
            "metadata": _json_load(row["metadata"], {}),
            "current_version_id": row["current_version_id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _version(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "asset_id": row["asset_id"],
            "parent_version_id": row["parent_version_id"],
            "branch_id": row["branch_id"],
            "task_id": row["task_id"],
            "image_index": int(row["image_index"]),
            "version_number": int(row["version_number"]),
            "operation": row["operation"],
            "image_path": row["image_path"],
            "image_url": portable_image_url(row["image_url"], row["image_path"]),
            "prompt": row["prompt"],
            "params": _json_load(row["params"], {}),
            "created_at": row["created_at"],
        }

    def create_project(
        self,
        identity: dict[str, object],
        *,
        name: str,
        description: str = "",
        tags: object = None,
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        normalized_name = _clean(name)
        if not normalized_name:
            raise ValueError("项目名称不能为空")
        item_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_projects(id, owner_id, name, description, tags, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (item_id, owner, normalized_name[:80], _clean(description)[:500], _json_dump(_normalize_tags(tags)), now, now),
            )
            row = connection.execute("SELECT * FROM creative_projects WHERE id = ?", (item_id,)).fetchone()
        return self._project(row)

    def list_projects(
        self,
        identity: dict[str, object],
        *,
        query: str = "",
        tag: str = "",
        favorite: bool | None = None,
    ) -> list[dict[str, object]]:
        owner = _owner_id(identity)
        clauses = ["p.owner_id = ?", "p.deleted_at = ''"]
        args: list[object] = [owner]
        if _clean(query):
            clauses.append("(p.name LIKE ? OR p.description LIKE ?)")
            pattern = f"%{_clean(query)}%"
            args.extend([pattern, pattern])
        if favorite is not None:
            clauses.append("p.favorite = ?")
            args.append(1 if favorite else 0)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT p.*, COUNT(a.id) AS asset_count FROM creative_projects p "
                "LEFT JOIN creative_assets a ON a.project_id = p.id AND a.owner_id = p.owner_id AND a.deleted_at = '' "
                f"WHERE {' AND '.join(clauses)} GROUP BY p.id ORDER BY p.favorite DESC, p.updated_at DESC",
                args,
            ).fetchall()
        requested_tag = _clean(tag)
        result = []
        for row in rows:
            item = self._project(row)
            if requested_tag and requested_tag not in item["tags"]:
                continue
            item["asset_count"] = int(row["asset_count"])
            result.append(item)
        return result

    def update_project(self, identity: dict[str, object], project_id: str, updates: dict[str, object]) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_projects WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                (_clean(project_id), owner),
            ).fetchone()
            if row is None:
                raise ValueError("project not found")
            name = _clean(updates.get("name"), row["name"])[:80]
            if not name:
                raise ValueError("项目名称不能为空")
            description = _clean(updates.get("description"), row["description"])[:500]
            favorite = int(bool(updates.get("favorite"))) if "favorite" in updates else int(row["favorite"])
            tags = _normalize_tags(updates.get("tags")) if "tags" in updates else _normalize_tags(_json_load(row["tags"], []))
            now = _now_iso()
            connection.execute(
                "UPDATE creative_projects SET name = ?, description = ?, favorite = ?, tags = ?, updated_at = ? "
                "WHERE id = ? AND owner_id = ?",
                (name, description, favorite, _json_dump(tags), now, project_id, owner),
            )
            updated = connection.execute("SELECT * FROM creative_projects WHERE id = ?", (project_id,)).fetchone()
        return self._project(updated)

    def delete_project(self, identity: dict[str, object], project_id: str) -> bool:
        from services.advanced_creative_service import AdvancedCreativeService

        return AdvancedCreativeService(self.path).trash(identity, "project", project_id)

    def create_asset(
        self,
        identity: dict[str, object],
        *,
        name: str,
        asset_type: str = "image",
        project_id: str = "",
        tags: object = None,
        metadata: object = None,
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        normalized_project = _clean(project_id) or None
        item_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            if normalized_project is not None:
                exists = connection.execute(
                    "SELECT 1 FROM creative_projects WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                    (normalized_project, owner),
                ).fetchone()
                if exists is None:
                    raise ValueError("project not found")
            connection.execute(
                "INSERT INTO creative_assets(id, owner_id, project_id, name, asset_type, tags, metadata, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item_id,
                    owner,
                    normalized_project,
                    (_clean(name) or "未命名作品")[:120],
                    (_clean(asset_type) or "image")[:24],
                    _json_dump(_normalize_tags(tags)),
                    _json_dump(metadata if isinstance(metadata, dict) else {}),
                    now,
                    now,
                ),
            )
            row = connection.execute("SELECT * FROM creative_assets WHERE id = ?", (item_id,)).fetchone()
        return self._asset(row)

    @staticmethod
    def _asset_filters(
        owner: str,
        *,
        project_id: str | None,
        asset_type: str,
        query: str,
        tag: str,
        favorite: bool | None,
    ) -> tuple[list[str], list[object]]:
        clauses = ["a.owner_id = ?", "a.deleted_at = ''"]
        args: list[object] = [owner]
        if project_id is not None:
            if _clean(project_id):
                clauses.append("a.project_id = ?")
                args.append(_clean(project_id))
            else:
                clauses.append("a.project_id IS NULL")
        if _clean(asset_type):
            clauses.append("a.asset_type = ?")
            args.append(_clean(asset_type))
        if _clean(query):
            clauses.append("a.name LIKE ?")
            args.append(f"%{_clean(query)}%")
        if _clean(tag):
            clauses.append("instr(a.tags, ?) > 0")
            args.append(json.dumps(_clean(tag), ensure_ascii=False))
        if favorite is not None:
            clauses.append("a.favorite = ?")
            args.append(1 if favorite else 0)
        return clauses, args

    def list_assets(
        self,
        identity: dict[str, object],
        *,
        project_id: str | None = None,
        asset_type: str = "",
        query: str = "",
        tag: str = "",
        favorite: bool | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict[str, object]]:
        owner = _owner_id(identity)
        clauses, args = self._asset_filters(
            owner,
            project_id=project_id,
            asset_type=asset_type,
            query=query,
            tag=tag,
            favorite=favorite,
        )
        page_sql = ""
        if limit is not None:
            page_sql = " LIMIT ? OFFSET ?"
            args.extend([max(1, min(int(limit), 200)), max(0, int(offset))])
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT a.*, v.image_url AS current_image_url, v.image_path AS current_image_path, "
                "v.version_number AS current_version_number FROM creative_assets a "
                "LEFT JOIN creative_versions v ON v.id = a.current_version_id AND v.deleted_at = '' "
                f"WHERE {' AND '.join(clauses)} ORDER BY a.favorite DESC, a.updated_at DESC{page_sql}",
                args,
            ).fetchall()
        result = []
        for row in rows:
            item = self._asset(row)
            item["current_image_url"] = portable_image_url(
                row["current_image_url"], row["current_image_path"]
            )
            item["current_image_path"] = row["current_image_path"] or ""
            item["current_version_number"] = int(row["current_version_number"] or 0)
            result.append(item)
        return result

    def list_assets_page(
        self,
        identity: dict[str, object],
        *,
        project_id: str | None = None,
        asset_type: str = "",
        query: str = "",
        tag: str = "",
        favorite: bool | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        clauses, args = self._asset_filters(
            owner,
            project_id=project_id,
            asset_type=asset_type,
            query=query,
            tag=tag,
            favorite=favorite,
        )
        with self._connection() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM creative_assets a WHERE {' AND '.join(clauses)}",
                    args,
                ).fetchone()[0]
            )
        page_limit = max(1, min(int(limit), 200))
        page_offset = max(0, int(offset))
        items = self.list_assets(
            identity,
            project_id=project_id,
            asset_type=asset_type,
            query=query,
            tag=tag,
            favorite=favorite,
            limit=page_limit,
            offset=page_offset,
        )
        next_offset = page_offset + len(items)
        has_more = next_offset < total
        return {
            "items": items,
            "total": total,
            "has_more": has_more,
            "next_offset": next_offset if has_more else None,
        }

    def list_image_references(
        self,
        identity: dict[str, object],
        *,
        include_all: bool = False,
    ) -> list[dict[str, str]]:
        owner = _owner_id(identity)
        is_admin_scope = include_all and _clean(identity.get("role")).lower() == "admin"
        clauses = ["a.deleted_at = ''", "v.deleted_at = ''", "v.image_path <> ''"]
        args: list[object] = []
        if not is_admin_scope:
            clauses.append("a.owner_id = ?")
            args.append(owner)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT v.id AS version_id, v.asset_id, v.image_path, a.owner_id, a.name AS asset_name "
                "FROM creative_versions v JOIN creative_assets a ON a.id = v.asset_id "
                f"WHERE {' AND '.join(clauses)} ORDER BY v.created_at DESC",
                args,
            ).fetchall()
        return [
            {
                "version_id": _clean(row["version_id"]),
                "asset_id": _clean(row["asset_id"]),
                "image_path": _clean(row["image_path"]),
                "owner_id": _clean(row["owner_id"]),
                "asset_name": _clean(row["asset_name"]),
            }
            for row in rows
        ]

    def bulk_archive_assets(
        self,
        identity: dict[str, object],
        asset_ids: Iterable[str],
        project_id: str | None,
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        normalized_ids = list(dict.fromkeys(_clean(value) for value in asset_ids if _clean(value)))
        if not normalized_ids:
            raise ValueError("请至少选择一个作品")
        if len(normalized_ids) > 100:
            raise ValueError("单次最多归档 100 个作品")
        target_project_id = _clean(project_id) or None
        placeholders = ",".join("?" for _ in normalized_ids)
        now = _now_iso()
        with self._connection() as connection:
            if target_project_id is not None:
                project = connection.execute(
                    "SELECT 1 FROM creative_projects WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                    (target_project_id, owner),
                ).fetchone()
                if project is None:
                    raise ValueError("project not found")
            rows = connection.execute(
                f"SELECT id FROM creative_assets WHERE owner_id = ? AND deleted_at = '' AND id IN ({placeholders})",
                [owner, *normalized_ids],
            ).fetchall()
            found_ids = {str(row["id"]) for row in rows}
            missing_ids = [asset_id for asset_id in normalized_ids if asset_id not in found_ids]
            if missing_ids:
                raise ValueError("部分作品不存在或无权操作")
            connection.execute(
                f"UPDATE creative_assets SET project_id = ?, updated_at = ? "
                f"WHERE owner_id = ? AND id IN ({placeholders})",
                [target_project_id, now, owner, *normalized_ids],
            )
        return {
            "updated": len(normalized_ids),
            "asset_ids": normalized_ids,
            "project_id": target_project_id,
        }

    def get_asset(self, identity: dict[str, object], asset_id: str) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_assets WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                (_clean(asset_id), owner),
            ).fetchone()
            if row is None:
                raise ValueError("asset not found")
            versions = connection.execute(
                "SELECT * FROM creative_versions WHERE asset_id = ? AND owner_id = ? AND deleted_at = '' ORDER BY version_number",
                (_clean(asset_id), owner),
            ).fetchall()
        item = self._asset(row)
        item["versions"] = [self._version(version) for version in versions]
        return item

    def update_asset(self, identity: dict[str, object], asset_id: str, updates: dict[str, object]) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_assets WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                (_clean(asset_id), owner),
            ).fetchone()
            if row is None:
                raise ValueError("asset not found")
            project_id = row["project_id"]
            if "project_id" in updates:
                project_id = _clean(updates.get("project_id")) or None
                if project_id is not None:
                    exists = connection.execute(
                        "SELECT 1 FROM creative_projects WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                        (project_id, owner),
                    ).fetchone()
                    if exists is None:
                        raise ValueError("project not found")
            name = (_clean(updates.get("name"), row["name"]) or "未命名作品")[:120]
            favorite = int(bool(updates.get("favorite"))) if "favorite" in updates else int(row["favorite"])
            tags = _normalize_tags(updates.get("tags")) if "tags" in updates else _normalize_tags(_json_load(row["tags"], []))
            connection.execute(
                "UPDATE creative_assets SET project_id = ?, name = ?, favorite = ?, tags = ?, updated_at = ? "
                "WHERE id = ? AND owner_id = ?",
                (project_id, name, favorite, _json_dump(tags), _now_iso(), asset_id, owner),
            )
            updated = connection.execute("SELECT * FROM creative_assets WHERE id = ?", (asset_id,)).fetchone()
        return self._asset(updated)

    def archive_asset(
        self,
        identity: dict[str, object],
        *,
        name: str,
        asset_type: str,
        project_id: str = "",
        image_path: str = "",
        image_url: str = "",
        prompt: str = "",
        tags: object = None,
        metadata: dict[str, object] | None = None,
    ) -> dict[str, object]:
        asset = self.create_asset(
            identity,
            name=name,
            asset_type=asset_type,
            project_id=project_id,
            tags=tags,
            metadata=metadata,
        )
        path = _clean(image_path) or _image_path_from_url(image_url)
        if path or _clean(image_url):
            self._insert_version(
                owner=_owner_id(identity),
                asset_id=_clean(asset["id"]),
                task_id=f"archive:{uuid.uuid4().hex}",
                image_index=0,
                operation="archive",
                image_path=path,
                image_url=portable_image_url(image_url, path),
                prompt=_clean(prompt),
                params=metadata or {},
                parent_version_id="",
                make_current=True,
            )
        return self.get_asset(identity, _clean(asset["id"]))

    def delete_asset(self, identity: dict[str, object], asset_id: str) -> bool:
        from services.advanced_creative_service import AdvancedCreativeService

        return AdvancedCreativeService(self.path).trash(identity, "asset", asset_id)

    def set_current_version(self, identity: dict[str, object], asset_id: str, version_id: str) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            version = connection.execute(
                "SELECT 1 FROM creative_versions WHERE id = ? AND asset_id = ? AND owner_id = ? AND deleted_at = ''",
                (_clean(version_id), _clean(asset_id), owner),
            ).fetchone()
            if version is None:
                raise ValueError("version not found")
            cursor = connection.execute(
                "UPDATE creative_assets SET current_version_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                (_clean(version_id), _now_iso(), _clean(asset_id), owner),
            )
            if cursor.rowcount == 0:
                raise ValueError("asset not found")
        return self.get_asset(identity, asset_id)

    def create_batch(
        self,
        identity: dict[str, object],
        *,
        mode: str,
        name: str,
        settings: dict[str, object],
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        normalized_mode = _clean(mode)
        if normalized_mode not in {"generate", "restore"}:
            raise ValueError("invalid batch mode")
        batch_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_batches(id, owner_id, mode, name, settings, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (batch_id, owner, normalized_mode, (_clean(name) or "批量任务")[:100], _json_dump(settings), now, now),
            )
        return self.get_batch_record(identity, batch_id)

    def add_batch_item(
        self,
        identity: dict[str, object],
        batch_id: str,
        *,
        task_id: str,
        source_name: str = "",
        source_path: str = "",
        prompt: str = "",
        params: dict[str, object] | None = None,
        submit_error: str = "",
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        item_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            batch = connection.execute(
                "SELECT 1 FROM creative_batches WHERE id = ? AND owner_id = ?",
                (_clean(batch_id), owner),
            ).fetchone()
            if batch is None:
                raise ValueError("batch not found")
            connection.execute(
                "INSERT INTO creative_batch_items(id, batch_id, owner_id, task_id, source_name, source_path, prompt, params, submit_error, created_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item_id,
                    batch_id,
                    owner,
                    _clean(task_id),
                    _clean(source_name)[:200],
                    _clean(source_path),
                    _clean(prompt),
                    _json_dump(params or {}),
                    _clean(submit_error),
                    now,
                ),
            )
            connection.execute(
                "UPDATE creative_batches SET updated_at = ? WHERE id = ? AND owner_id = ?",
                (now, batch_id, owner),
            )
        return {"id": item_id, "task_id": _clean(task_id)}

    def get_batch_record(self, identity: dict[str, object], batch_id: str) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_batches WHERE id = ? AND owner_id = ?",
                (_clean(batch_id), owner),
            ).fetchone()
            if row is None:
                raise ValueError("batch not found")
            items = connection.execute(
                "SELECT * FROM creative_batch_items WHERE batch_id = ? AND owner_id = ? ORDER BY created_at, id",
                (_clean(batch_id), owner),
            ).fetchall()
        return {
            "id": row["id"],
            "mode": row["mode"],
            "name": row["name"],
            "settings": _json_load(row["settings"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "items": [
                {
                    "id": item["id"],
                    "task_id": item["task_id"],
                    "source_name": item["source_name"],
                    "source_path": item["source_path"],
                    "prompt": item["prompt"],
                    "params": _json_load(item["params"], {}),
                    "submit_error": item["submit_error"],
                    "created_at": item["created_at"],
                }
                for item in items
            ],
        }

    def list_batches(self, identity: dict[str, object], limit: int = 30) -> list[dict[str, object]]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT b.*, COUNT(i.id) AS item_count FROM creative_batches b "
                "LEFT JOIN creative_batch_items i ON i.batch_id = b.id "
                "WHERE b.owner_id = ? GROUP BY b.id ORDER BY b.updated_at DESC LIMIT ?",
                (owner, max(1, min(int(limit), 100))),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "mode": row["mode"],
                "name": row["name"],
                "settings": _json_load(row["settings"], {}),
                "item_count": int(row["item_count"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def delete_batch(self, identity: dict[str, object], batch_id: str) -> bool:
        owner = _owner_id(identity)
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM creative_batches WHERE id = ? AND owner_id = ?",
                (_clean(batch_id), owner),
            )
        return cursor.rowcount > 0

    def batch_result_paths(self, identity: dict[str, object], batch_id: str) -> list[str]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            exists = connection.execute(
                "SELECT 1 FROM creative_batches WHERE id = ? AND owner_id = ?",
                (_clean(batch_id), owner),
            ).fetchone()
            if exists is None:
                raise ValueError("batch not found")
            rows = connection.execute(
                "SELECT v.image_path FROM creative_versions v JOIN creative_batch_items i "
                "ON i.task_id = v.task_id AND i.owner_id = v.owner_id "
                "WHERE i.batch_id = ? AND v.owner_id = ? AND v.image_path <> '' ORDER BY i.created_at, v.image_index",
                (_clean(batch_id), owner),
            ).fetchall()
        return list(dict.fromkeys(_clean(row["image_path"]) for row in rows if _clean(row["image_path"])))

    def batch_task_ids(self, identity: dict[str, object], batch_id: str) -> list[str]:
        record = self.get_batch_record(identity, batch_id)
        return [_clean(item.get("task_id")) for item in record["items"] if _clean(item.get("task_id"))]

    def get_batch_item(self, identity: dict[str, object], batch_id: str, item_id: str) -> dict[str, object]:
        record = self.get_batch_record(identity, batch_id)
        item = next((entry for entry in record["items"] if entry.get("id") == _clean(item_id)), None)
        if item is None:
            raise ValueError("batch item not found")
        return item

    def clear_batch_item_error(self, identity: dict[str, object], batch_id: str, item_id: str) -> None:
        owner = _owner_id(identity)
        with self._connection() as connection:
            cursor = connection.execute(
                "UPDATE creative_batch_items SET submit_error = '' WHERE id = ? AND batch_id = ? AND owner_id = ?",
                (_clean(item_id), _clean(batch_id), owner),
            )
            if cursor.rowcount == 0:
                raise ValueError("batch item not found")
            connection.execute(
                "UPDATE creative_batches SET updated_at = ? WHERE id = ? AND owner_id = ?",
                (_now_iso(), _clean(batch_id), owner),
            )

    def record_task_success(self, task: dict[str, Any]) -> list[dict[str, object]]:
        workflow = task.get("workflow")
        data = task.get("data")
        if task.get("status") != "success" or not isinstance(workflow, dict) or not isinstance(data, list):
            return []
        owner = _clean(task.get("owner_id"))
        task_id = _clean(task.get("id"))
        if not owner or not task_id:
            return []
        identity: dict[str, object] = {"id": owner, "role": task.get("owner_role") or "user"}
        created: list[dict[str, object]] = []
        with self._lock:
            for index, result in enumerate(data):
                if not isinstance(result, dict):
                    continue
                image_url = portable_image_url(result.get("url"))
                image_path = _image_path_from_url(image_url)
                if not image_url and not image_path:
                    continue
                with self._connection() as connection:
                    duplicate = connection.execute(
                        "SELECT * FROM creative_versions WHERE owner_id = ? AND task_id = ? AND image_index = ?",
                        (owner, task_id, index),
                    ).fetchone()
                    if duplicate is not None:
                        created.append(self._version(duplicate))
                        continue

                requested_asset_id = _clean(workflow.get("asset_id"))
                project_id = _clean(workflow.get("project_id"))
                if requested_asset_id:
                    try:
                        asset = self.get_asset(identity, requested_asset_id)
                    except ValueError:
                        requested_asset_id = ""
                        asset = None
                else:
                    asset = None
                if asset is None:
                    source_name = _clean(workflow.get("asset_name"))
                    if not source_name:
                        source_name = _clean(task.get("prompt"))[:48] or f"作品 {task_id[:8]}"
                    asset = self.create_asset(
                        identity,
                        name=source_name,
                        project_id=project_id,
                        asset_type="image",
                        metadata={"batch_id": _clean(workflow.get("batch_id"))},
                    )
                    requested_asset_id = _clean(asset["id"])
                    source_path = _clean(workflow.get("source_path"))
                    if source_path:
                        self._insert_version(
                            owner=owner,
                            asset_id=requested_asset_id,
                            task_id=f"source:{requested_asset_id}",
                            image_index=0,
                            operation="original",
                            image_path=source_path,
                            image_url=f"/images/{source_path}",
                            prompt="",
                            params={"source_name": _clean(workflow.get("source_name"))},
                            parent_version_id="",
                            make_current=False,
                        )

                version = self._insert_version(
                    owner=owner,
                    asset_id=requested_asset_id,
                    task_id=task_id,
                    image_index=index,
                    operation=_clean(workflow.get("operation_type"), _clean(task.get("mode"), "generate")),
                    image_path=image_path,
                    image_url=image_url,
                    prompt=_clean(task.get("prompt")),
                    params={
                        "model": task.get("model"),
                        "size": task.get("size"),
                        "quality": task.get("quality"),
                        **(workflow.get("params") if isinstance(workflow.get("params"), dict) else {}),
                    },
                    parent_version_id=_clean(workflow.get("parent_version_id")),
                    make_current=True,
                    branch_id=_clean(workflow.get("branch_id")),
                )
                created.append(version)
                conversation_id = _clean(workflow.get("conversation_id"))
                if conversation_id:
                    self.complete_conversation_task(identity, conversation_id, task_id, _clean(version["id"]))
        return created

    def _insert_version(
        self,
        *,
        owner: str,
        asset_id: str,
        task_id: str,
        image_index: int,
        operation: str,
        image_path: str,
        image_url: str,
        prompt: str,
        params: dict[str, object],
        parent_version_id: str,
        make_current: bool,
        branch_id: str = "",
    ) -> dict[str, object]:
        version_id = uuid.uuid4().hex
        now = _now_iso()
        normalized_image_url = portable_image_url(image_url, image_path)
        with self._connection() as connection:
            asset = connection.execute(
                "SELECT current_version_id FROM creative_assets WHERE id = ? AND owner_id = ?",
                (asset_id, owner),
            ).fetchone()
            if asset is None:
                raise ValueError("asset not found")
            parent_id = parent_version_id or _clean(asset["current_version_id"])
            if parent_id:
                parent_exists = connection.execute(
                    "SELECT 1 FROM creative_versions WHERE id = ? AND asset_id = ? AND owner_id = ?",
                    (parent_id, asset_id, owner),
                ).fetchone()
                if parent_exists is None:
                    parent_id = ""
            normalized_branch_id = _clean(branch_id)
            if normalized_branch_id:
                branch_exists = connection.execute(
                    "SELECT 1 FROM creative_branches WHERE id = ? AND asset_id = ? AND owner_id = ?",
                    (normalized_branch_id, asset_id, owner),
                ).fetchone() if connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='creative_branches'"
                ).fetchone() else None
                if branch_exists is None:
                    normalized_branch_id = ""
            next_number = int(
                connection.execute(
                    "SELECT COALESCE(MAX(version_number), 0) + 1 FROM creative_versions WHERE asset_id = ?",
                    (asset_id,),
                ).fetchone()[0]
            )
            connection.execute(
                "INSERT OR IGNORE INTO creative_versions(id, asset_id, owner_id, parent_version_id, task_id, image_index, "
                "version_number, operation, image_path, image_url, prompt, params, branch_id, created_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    version_id,
                    asset_id,
                    owner,
                    parent_id or None,
                    task_id,
                    int(image_index),
                    next_number,
                    operation[:32],
                    image_path,
                    normalized_image_url,
                    prompt,
                    _json_dump(params),
                    normalized_branch_id or None,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM creative_versions WHERE owner_id = ? AND task_id = ? AND image_index = ?",
                (owner, task_id, int(image_index)),
            ).fetchone()
            if make_current and row is not None:
                connection.execute(
                    "UPDATE creative_assets SET current_version_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                    (row["id"], now, asset_id, owner),
                )
            if normalized_branch_id and row is not None:
                connection.execute(
                    "UPDATE creative_branches SET head_version_id = ?, updated_at = ? "
                    "WHERE id = ? AND asset_id = ? AND owner_id = ?",
                    (row["id"], now, normalized_branch_id, asset_id, owner),
                )
        return self._version(row)

    def create_conversation(self, identity: dict[str, object], asset_id: str, title: str = "") -> dict[str, object]:
        owner = _owner_id(identity)
        self.get_asset(identity, asset_id)
        conversation_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_conversations(id, owner_id, asset_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
                (conversation_id, owner, _clean(asset_id), _clean(title)[:100] or "连续修改", now, now),
            )
        return self.get_conversation(identity, conversation_id)

    def get_conversation(self, identity: dict[str, object], conversation_id: str) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_conversations WHERE id = ? AND owner_id = ?",
                (_clean(conversation_id), owner),
            ).fetchone()
            if row is None:
                raise ValueError("conversation not found")
            messages = connection.execute(
                "SELECT * FROM creative_messages WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at, rowid",
                (_clean(conversation_id), owner),
            ).fetchall()
        return {
            "id": row["id"],
            "asset_id": row["asset_id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "messages": [
                {key: value for key, value in dict(message).items() if key != "owner_id"}
                for message in messages
            ],
        }

    def list_conversations(self, identity: dict[str, object], asset_id: str) -> list[dict[str, object]]:
        owner = _owner_id(identity)
        self.get_asset(identity, asset_id)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM creative_conversations WHERE asset_id = ? AND owner_id = ? ORDER BY updated_at DESC",
                (_clean(asset_id), owner),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "asset_id": row["asset_id"],
                "title": row["title"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def add_conversation_instruction(
        self,
        identity: dict[str, object],
        conversation_id: str,
        *,
        content: str,
        task_id: str,
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        instruction = _clean(content)
        if not instruction:
            raise ValueError("修改要求不能为空")
        conversation = self.get_conversation(identity, conversation_id)
        now = _now_iso()
        message_id = uuid.uuid4().hex
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_messages(id, conversation_id, owner_id, role, content, task_id, status, created_at) "
                "VALUES(?, ?, ?, 'user', ?, ?, 'running', ?)",
                (message_id, conversation_id, owner, instruction, _clean(task_id), now),
            )
            connection.execute(
                "UPDATE creative_conversations SET updated_at = ? WHERE id = ? AND owner_id = ?",
                (now, conversation_id, owner),
            )
        return {"message_id": message_id, "asset_id": conversation["asset_id"]}

    def conversation_context(self, identity: dict[str, object], conversation_id: str, limit: int = 6) -> dict[str, object]:
        conversation = self.get_conversation(identity, conversation_id)
        asset = self.get_asset(identity, _clean(conversation["asset_id"]))
        versions = asset.get("versions") if isinstance(asset.get("versions"), list) else []
        current = next((version for version in versions if version.get("id") == asset.get("current_version_id")), None)
        messages = [
            message
            for message in conversation["messages"]
            if message.get("role") == "user" and _clean(message.get("content"))
        ][-max(1, min(int(limit), 12)):]
        return {
            "conversation": conversation,
            "asset": asset,
            "current_version": current,
            "instructions": [_clean(message.get("content")) for message in messages],
        }

    def complete_conversation_task(
        self,
        identity: dict[str, object],
        conversation_id: str,
        task_id: str,
        version_id: str,
    ) -> None:
        owner = _owner_id(identity)
        with self._connection() as connection:
            cursor = connection.execute(
                "UPDATE creative_messages SET status = 'success', version_id = ? "
                "WHERE conversation_id = ? AND owner_id = ? AND task_id = ?",
                (_clean(version_id), _clean(conversation_id), owner, _clean(task_id)),
            )
            if cursor.rowcount:
                connection.execute(
                    "INSERT INTO creative_messages(id, conversation_id, owner_id, role, content, task_id, version_id, status, created_at) "
                    "VALUES(?, ?, ?, 'assistant', '已生成新版本', ?, ?, 'success', ?)",
                    (uuid.uuid4().hex, conversation_id, owner, task_id, version_id, _now_iso()),
                )

    def fail_conversation_task(
        self,
        identity: dict[str, object],
        conversation_id: str,
        task_id: str,
        error: str,
    ) -> None:
        owner = _owner_id(identity)
        with self._connection() as connection:
            connection.execute(
                "UPDATE creative_messages SET status = 'error', content = content || ? "
                "WHERE conversation_id = ? AND owner_id = ? AND task_id = ? AND role = 'user'",
                (f"\n\n处理失败：{_clean(error)[:300]}", _clean(conversation_id), owner, _clean(task_id)),
            )
            connection.execute(
                "UPDATE creative_conversations SET updated_at = ? WHERE id = ? AND owner_id = ?",
                (_now_iso(), _clean(conversation_id), owner),
            )

    def health(self) -> dict[str, object]:
        with self._connection() as connection:
            journal_mode = _clean(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            quick_check = _clean(connection.execute("PRAGMA quick_check").fetchone()[0]).lower()
            counts = {
                table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                for table in ("creative_projects", "creative_assets", "creative_versions", "creative_batches")
            }
        return {
            "healthy": journal_mode == "wal" and quick_check == "ok",
            "journal_mode": journal_mode,
            "quick_check": quick_check,
            "counts": counts,
            "path": str(self.path),
        }

    @staticmethod
    def _policy(row: sqlite3.Row | None, subject_id: str, subject_type: str = "user") -> dict[str, object]:
        if row is None:
            return {
                "subject_id": subject_id,
                "subject_type": subject_type,
                "features": {},
                "rate_limit_per_minute": 0,
                "frozen": False,
                "abnormal_reason": "",
                "updated_at": "",
            }
        return {
            "subject_id": row["subject_id"],
            "subject_type": row["subject_type"],
            "features": _json_load(row["features"], {}),
            "rate_limit_per_minute": int(row["rate_limit_per_minute"]),
            "frozen": bool(row["frozen"]),
            "abnormal_reason": row["abnormal_reason"],
            "updated_at": row["updated_at"],
        }

    def get_policy(self, subject_id: str, subject_type: str = "user") -> dict[str, object]:
        normalized = _clean(subject_id)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_policies WHERE subject_id = ? AND subject_type = ?",
                (normalized, _clean(subject_type, "user")),
            ).fetchone()
        return self._policy(row, normalized, _clean(subject_type, "user"))

    def list_policies(self) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM creative_policies ORDER BY subject_type, subject_id"
            ).fetchall()
        return [self._policy(row, _clean(row["subject_id"]), _clean(row["subject_type"])) for row in rows]

    def update_policy(
        self,
        subject_id: str,
        *,
        subject_type: str = "user",
        features: dict[str, object] | None = None,
        rate_limit_per_minute: int = 0,
        frozen: bool = False,
        abnormal_reason: str = "",
    ) -> dict[str, object]:
        normalized = _clean(subject_id)
        normalized_type = _clean(subject_type, "user")
        if not normalized or normalized_type not in {"user", "group"}:
            raise ValueError("invalid policy subject")
        safe_features = {
            _clean(key)[:48]: bool(value)
            for key, value in (features or {}).items()
            if _clean(key)
        }
        safe_rate = max(0, min(int(rate_limit_per_minute), 600))
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_policies(subject_id, subject_type, features, rate_limit_per_minute, frozen, abnormal_reason, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject_id) DO UPDATE SET "
                "subject_type=excluded.subject_type, features=excluded.features, rate_limit_per_minute=excluded.rate_limit_per_minute, "
                "frozen=excluded.frozen, abnormal_reason=excluded.abnormal_reason, updated_at=excluded.updated_at",
                (normalized, normalized_type, _json_dump(safe_features), safe_rate, int(frozen), _clean(abnormal_reason)[:300], now),
            )
            row = connection.execute("SELECT * FROM creative_policies WHERE subject_id = ?", (normalized,)).fetchone()
        return self._policy(row, normalized, normalized_type)

    def enforce_policy(self, identity: dict[str, object], feature: str) -> None:
        if _clean(identity.get("role")) != "user":
            return
        owner = _owner_id(identity)
        group = _clean(identity.get("group"), "default")
        group_policy = self.get_policy(f"group:{group}", "group")
        user_policy = self.get_policy(owner, "user")
        if bool(group_policy.get("frozen")) or bool(user_policy.get("frozen")):
            reason = _clean(user_policy.get("abnormal_reason")) or _clean(group_policy.get("abnormal_reason"))
            raise ValueError(reason or "账号已被管理员暂停使用")
        normalized_feature = _clean(feature)
        group_features = group_policy.get("features") if isinstance(group_policy.get("features"), dict) else {}
        user_features = user_policy.get("features") if isinstance(user_policy.get("features"), dict) else {}
        enabled = user_features.get(normalized_feature, group_features.get(normalized_feature, True))
        if enabled is False:
            raise ValueError("管理员已关闭当前账号的这项功能")
        user_rate = int(user_policy.get("rate_limit_per_minute") or 0)
        group_rate = int(group_policy.get("rate_limit_per_minute") or 0)
        rate_limit = user_rate or group_rate
        if rate_limit <= 0:
            return
        now = time.monotonic()
        key = f"{owner}:{normalized_feature}"
        with self._lock:
            events = self._rate_events.setdefault(key, deque())
            while events and events[0] <= now - 60.0:
                events.popleft()
            if len(events) >= rate_limit:
                raise ValueError(f"操作过于频繁，当前限制为每分钟 {rate_limit} 次")
            events.append(now)


creative_workspace_service = CreativeWorkspaceService()
