from __future__ import annotations

import io
import json
import logging
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageStat

from services.config import DATA_DIR
from services.creative_workspace_service import (
    CreativeWorkspaceService,
    creative_workspace_service,
    portable_image_url,
)
from services.image_storage_service import image_storage_service


module_logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now().astimezone()


def _now_iso() -> str:
    return _now().isoformat(timespec="seconds")


def _clean(value: object, default: str = "") -> str:
    text = str(value if value is not None else default).strip()
    return text or default


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _loads(value: object, default: Any) -> Any:
    try:
        return json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _owner(identity: dict[str, object]) -> str:
    return _clean(identity.get("id"), "anonymous")


def _group(identity: dict[str, object]) -> str:
    return _clean(identity.get("group"), "default")


def _role(identity: dict[str, object]) -> str:
    return _clean(identity.get("role"), "user")


def _tags(value: object) -> list[str]:
    source: Iterable[object]
    if isinstance(value, str):
        source = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        source = value
    else:
        source = []
    result: list[str] = []
    for item in source:
        tag = _clean(item)[:32]
        if tag and tag not in result:
            result.append(tag)
        if len(result) >= 24:
            break
    return result


PROFILE_STRENGTHS = {"strict", "balanced", "creative"}
PROFILE_TYPE_LABELS = {
    "person": "人物",
    "product": "商品",
    "brand": "品牌",
    "style": "画风",
}
PROFILE_STRENGTH_INSTRUCTIONS = {
    "strict": "严格锁定核心识别特征，禁止身份、主体结构、品牌元素、固定色板和关键画风发生漂移。",
    "balanced": "锁定核心识别特征，同时允许场景、动作、视角和次要细节适度变化。",
    "creative": "保留核心识别线索和整体方向，允许更大变化，包括构图、场景和表现方式。",
}


def _profile_strength(value: object, default: str = "balanced") -> str:
    normalized = _clean(value, default).lower()
    if normalized not in PROFILE_STRENGTHS:
        raise ValueError("一致性强度无效")
    return normalized


BUILTIN_RECIPES: tuple[dict[str, object], ...] = (
    {
        "id": "builtin-ecommerce-main",
        "name": "电商主图",
        "category": "ecommerce",
        "description": "干净背景、商品主体清晰，适合电商首图。",
        "settings": {
            "model": "gpt-image-2",
            "size": "1024x1024",
            "quality": "high",
            "prompt": "电商商品主图，主体完整居中，干净高级背景，商业摄影光线，细节清晰",
            "restore_mode": "product",
            "restore_strength": "standard",
        },
    },
    {
        "id": "builtin-portrait",
        "name": "人物写真",
        "category": "portrait",
        "description": "自然肤色和电影感光线的人物写真。",
        "settings": {
            "model": "gpt-image-2",
            "size": "1024x1536",
            "quality": "high",
            "prompt": "高级人物写真，自然肤色，电影感柔光，五官清晰，真实摄影质感",
            "restore_mode": "portrait",
            "restore_strength": "standard",
        },
    },
    {
        "id": "builtin-poster",
        "name": "横版海报",
        "category": "poster",
        "description": "预留标题和信息区域的商业海报构图。",
        "settings": {
            "model": "gpt-image-2",
            "size": "1536x1024",
            "quality": "high",
            "prompt": "现代商业海报，横版构图，清晰视觉焦点，预留标题与文案区域，层次分明",
            "restore_mode": "general",
            "restore_strength": "standard",
        },
    },
    {
        "id": "builtin-id-photo",
        "name": "证件照",
        "category": "id_photo",
        "description": "正面自然人像与规范纯色背景。",
        "settings": {
            "model": "gpt-image-2",
            "size": "1024x1536",
            "quality": "high",
            "prompt": "标准证件照，正面自然表情，五官清晰，均匀柔光，纯色背景",
            "restore_mode": "portrait",
            "restore_strength": "natural",
        },
    },
)


class AdvancedCreativeService:
    """Advanced creation, collaboration, recovery and search on the workspace database."""

    def __init__(self, path: Path = DATA_DIR / "creative_workspace.db"):
        self.path = path
        self.workspace = (
            creative_workspace_service
            if Path(path).resolve() == creative_workspace_service.path.resolve()
            else CreativeWorkspaceService(path)
        )
        self._lock = threading.RLock()
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
            for table in ("creative_projects", "creative_assets", "creative_versions"):
                self._ensure_column(connection, table, "deleted_at", "TEXT NOT NULL DEFAULT ''")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS creative_recipes (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    creator_role TEXT NOT NULL DEFAULT 'user',
                    scope_type TEXT NOT NULL DEFAULT 'private',
                    scope_id TEXT NOT NULL DEFAULT '',
                    name TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'custom',
                    description TEXT NOT NULL DEFAULT '',
                    settings TEXT NOT NULL DEFAULT '{}',
                    builtin INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_creative_recipes_scope
                    ON creative_recipes(scope_type, scope_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_profiles (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    profile_type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    instructions TEXT NOT NULL DEFAULT '',
                    colors TEXT NOT NULL DEFAULT '[]',
                    fonts TEXT NOT NULL DEFAULT '[]',
                    logo_paths TEXT NOT NULL DEFAULT '[]',
                    reference_paths TEXT NOT NULL DEFAULT '[]',
                    default_strength TEXT NOT NULL DEFAULT 'balanced',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_creative_profiles_owner
                    ON creative_profiles(owner_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_shares (
                    token TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    version_id TEXT NOT NULL DEFAULT '',
                    expires_at TEXT NOT NULL DEFAULT '',
                    revoked_at TEXT NOT NULL DEFAULT '',
                    downloads INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(asset_id) REFERENCES creative_assets(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_creative_shares_owner
                    ON creative_shares(owner_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS creative_reviews (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    submitted_by TEXT NOT NULL,
                    submitted_at TEXT NOT NULL,
                    reviewed_by TEXT NOT NULL DEFAULT '',
                    reviewed_at TEXT NOT NULL DEFAULT '',
                    comment TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY(asset_id) REFERENCES creative_assets(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_creative_reviews_status
                    ON creative_reviews(status, submitted_at DESC);

                CREATE TABLE IF NOT EXISTS creative_trash (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    snapshot TEXT NOT NULL DEFAULT '{}',
                    deleted_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    UNIQUE(owner_id, entity_type, entity_id)
                );
                CREATE INDEX IF NOT EXISTS idx_creative_trash_owner
                    ON creative_trash(owner_id, deleted_at DESC);

                CREATE TABLE IF NOT EXISTS creative_audits (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL DEFAULT '',
                    actor_id TEXT NOT NULL DEFAULT '',
                    actor_role TEXT NOT NULL DEFAULT '',
                    action TEXT NOT NULL,
                    entity_type TEXT NOT NULL DEFAULT '',
                    entity_id TEXT NOT NULL DEFAULT '',
                    details TEXT NOT NULL DEFAULT '{}',
                    ip_address TEXT NOT NULL DEFAULT '',
                    user_agent TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_audits_created
                    ON creative_audits(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_creative_audits_actor
                    ON creative_audits(actor_id, created_at DESC);
                """
            )
            self._ensure_column(
                connection,
                "creative_profiles",
                "default_strength",
                "TEXT NOT NULL DEFAULT 'balanced'",
            )
            now = _now_iso()
            for recipe in BUILTIN_RECIPES:
                connection.execute(
                    "INSERT OR IGNORE INTO creative_recipes(id, owner_id, creator_role, scope_type, scope_id, "
                    "name, category, description, settings, builtin, created_at, updated_at) "
                    "VALUES(?, 'system', 'admin', 'global', '', ?, ?, ?, ?, 1, ?, ?)",
                    (
                        recipe["id"], recipe["name"], recipe["category"], recipe["description"],
                        _json(recipe["settings"]), now, now,
                    ),
                )
                connection.execute(
                    "UPDATE creative_recipes SET name = ?, category = ?, description = ?, settings = ?, updated_at = ? "
                    "WHERE id = ? AND builtin = 1",
                    (
                        recipe["name"], recipe["category"], recipe["description"],
                        _json(recipe["settings"]), now, recipe["id"],
                    ),
                )

    @staticmethod
    def _recipe(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"], "name": row["name"], "category": row["category"],
            "description": row["description"], "settings": _loads(row["settings"], {}),
            "scope_type": row["scope_type"], "scope_id": row["scope_id"],
            "builtin": bool(row["builtin"]), "owner_id": row["owner_id"],
            "created_at": row["created_at"], "updated_at": row["updated_at"],
        }

    @staticmethod
    def _profile(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"], "profile_type": row["profile_type"], "name": row["name"],
            "instructions": row["instructions"], "colors": _loads(row["colors"], []),
            "fonts": _loads(row["fonts"], []), "logo_paths": _loads(row["logo_paths"], []),
            "reference_paths": _loads(row["reference_paths"], []),
            "default_strength": _profile_strength(row["default_strength"]),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
        }

    def audit(
        self,
        identity: dict[str, object],
        action: str,
        *,
        entity_type: str = "",
        entity_id: str = "",
        details: dict[str, object] | None = None,
        owner_id: str = "",
        ip_address: str = "",
        user_agent: str = "",
    ) -> None:
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_audits(id, owner_id, actor_id, actor_role, action, entity_type, entity_id, "
                "details, ip_address, user_agent, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex, _clean(owner_id) or _owner(identity), _owner(identity), _role(identity),
                    _clean(action)[:80], _clean(entity_type)[:40], _clean(entity_id)[:96],
                    _json(details or {}), _clean(ip_address)[:80], _clean(user_agent)[:300], _now_iso(),
                ),
            )

    def list_audits(
        self,
        identity: dict[str, object],
        *,
        action: str = "",
        actor_id: str = "",
        limit: int = 200,
    ) -> list[dict[str, object]]:
        clauses = ["1=1"]
        args: list[object] = []
        if _role(identity) != "admin":
            clauses.append("owner_id = ?")
            args.append(_owner(identity))
        if _clean(action):
            clauses.append("action = ?")
            args.append(_clean(action))
        if _clean(actor_id):
            clauses.append("actor_id = ?")
            args.append(_clean(actor_id))
        args.append(max(1, min(int(limit), 1000)))
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM creative_audits WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",
                args,
            ).fetchall()
        return [
            {
                "id": row["id"], "owner_id": row["owner_id"], "actor_id": row["actor_id"],
                "actor_role": row["actor_role"], "action": row["action"],
                "entity_type": row["entity_type"], "entity_id": row["entity_id"],
                "details": _loads(row["details"], {}), "ip_address": row["ip_address"],
                "user_agent": row["user_agent"], "created_at": row["created_at"],
            }
            for row in rows
        ]

    def list_recipes(self, identity: dict[str, object], category: str = "") -> list[dict[str, object]]:
        clauses = ["deleted_at = ''", "(scope_type = 'global' OR (scope_type = 'private' AND owner_id = ?) "
                   "OR (scope_type = 'group' AND scope_id = ?))"]
        args: list[object] = [_owner(identity), _group(identity)]
        if _clean(category):
            clauses.append("category = ?")
            args.append(_clean(category))
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM creative_recipes WHERE {' AND '.join(clauses)} "
                "ORDER BY builtin DESC, scope_type, updated_at DESC",
                args,
            ).fetchall()
        return [self._recipe(row) for row in rows]

    def create_recipe(
        self,
        identity: dict[str, object],
        *,
        name: str,
        category: str,
        description: str,
        settings: dict[str, object],
        scope_type: str = "private",
        scope_id: str = "",
    ) -> dict[str, object]:
        normalized_scope = _clean(scope_type, "private")
        if normalized_scope not in {"private", "group", "global"}:
            raise ValueError("invalid recipe scope")
        if normalized_scope != "private" and _role(identity) != "admin":
            raise ValueError("only administrators can publish shared recipes")
        normalized_name = _clean(name)[:80]
        if not normalized_name:
            raise ValueError("配方名称不能为空")
        item_id = uuid.uuid4().hex
        now = _now_iso()
        target_scope = _clean(scope_id) if normalized_scope == "group" else ""
        if normalized_scope == "group" and not target_scope:
            raise ValueError("请选择用户组")
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_recipes(id, owner_id, creator_role, scope_type, scope_id, name, category, "
                "description, settings, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item_id, _owner(identity), _role(identity), normalized_scope, target_scope, normalized_name,
                    _clean(category, "custom")[:40], _clean(description)[:300], _json(settings), now, now,
                ),
            )
            row = connection.execute("SELECT * FROM creative_recipes WHERE id = ?", (item_id,)).fetchone()
        self.audit(identity, "recipe.create", entity_type="recipe", entity_id=item_id,
                   details={"scope_type": normalized_scope, "scope_id": target_scope})
        return self._recipe(row)

    def delete_recipe(self, identity: dict[str, object], recipe_id: str) -> bool:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM creative_recipes WHERE id = ?", (_clean(recipe_id),)).fetchone()
            if row is None or bool(row["builtin"]):
                return False
            if row["owner_id"] != _owner(identity) and _role(identity) != "admin":
                return False
            cursor = connection.execute(
                "UPDATE creative_recipes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at = ''",
                (_now_iso(), _now_iso(), _clean(recipe_id)),
            )
        if cursor.rowcount:
            self.audit(identity, "recipe.delete", entity_type="recipe", entity_id=recipe_id)
        return cursor.rowcount > 0

    def list_profiles(self, identity: dict[str, object], profile_type: str = "") -> list[dict[str, object]]:
        clauses = ["owner_id = ?", "deleted_at = ''"]
        args: list[object] = [_owner(identity)]
        if _clean(profile_type):
            clauses.append("profile_type = ?")
            args.append(_clean(profile_type))
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM creative_profiles WHERE {' AND '.join(clauses)} ORDER BY updated_at DESC", args
            ).fetchall()
        return [self._profile(row) for row in rows]

    def create_profile(
        self,
        identity: dict[str, object],
        *,
        profile_type: str,
        name: str,
        instructions: str = "",
        colors: object = None,
        fonts: object = None,
        logo_paths: object = None,
        reference_paths: object = None,
        default_strength: str = "balanced",
    ) -> dict[str, object]:
        normalized_type = _clean(profile_type)
        if normalized_type not in {"brand", "person", "product", "style"}:
            raise ValueError("档案类型无效")
        normalized_name = _clean(name)[:80]
        if not normalized_name:
            raise ValueError("档案名称不能为空")
        normalized_strength = _profile_strength(default_strength)
        normalized_instructions = _clean(instructions)[:2000]
        normalized_colors = _tags(colors)
        normalized_fonts = _tags(fonts)
        normalized_logos = _tags(logo_paths)
        normalized_references = _tags(reference_paths)
        if normalized_type in {"person", "product", "style"} and not normalized_references:
            raise ValueError("人物、商品和画风档案至少上传一张参考图")
        if normalized_type == "brand" and not any(
            (normalized_instructions, normalized_colors, normalized_logos, normalized_references)
        ):
            raise ValueError("品牌档案至少填写说明、色板或上传 Logo/参考图")
        item_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_profiles(id, owner_id, profile_type, name, instructions, colors, fonts, "
                "logo_paths, reference_paths, default_strength, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item_id,
                    _owner(identity),
                    normalized_type,
                    normalized_name,
                    normalized_instructions,
                    _json(normalized_colors),
                    _json(normalized_fonts),
                    _json(normalized_logos),
                    _json(normalized_references),
                    normalized_strength,
                    now,
                    now,
                ),
            )
            row = connection.execute("SELECT * FROM creative_profiles WHERE id = ?", (item_id,)).fetchone()
        self.audit(identity, "profile.create", entity_type="profile", entity_id=item_id,
                   details={"profile_type": normalized_type})
        return self._profile(row)

    def delete_profile(self, identity: dict[str, object], profile_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                "UPDATE creative_profiles SET deleted_at = ?, updated_at = ? "
                "WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                (_now_iso(), _now_iso(), _clean(profile_id), _owner(identity)),
            )
        if cursor.rowcount:
            self.audit(identity, "profile.delete", entity_type="profile", entity_id=profile_id)
        return cursor.rowcount > 0

    def profile_prompt(
        self,
        identity: dict[str, object],
        profile_id: str,
        strength: str = "",
    ) -> dict[str, object]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_profiles WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                (_clean(profile_id), _owner(identity)),
            ).fetchone()
        if row is None:
            raise ValueError("consistency profile not found")
        profile = self._profile(row)
        applied_strength = _profile_strength(strength, str(profile["default_strength"]))
        type_label = PROFILE_TYPE_LABELS[str(profile["profile_type"])]
        parts = [
            f"保持{type_label}一致性：{profile['name']}",
            PROFILE_STRENGTH_INSTRUCTIONS[applied_strength],
        ]
        if profile["instructions"]:
            parts.append(str(profile["instructions"]))
        if profile["colors"]:
            parts.append("固定色板：" + "、".join(str(item) for item in profile["colors"]))
        if profile["fonts"]:
            parts.append("字体规范：" + "、".join(str(item) for item in profile["fonts"]))
        return {
            **profile,
            "applied_strength": applied_strength,
            "prompt_suffix": "；".join(parts),
        }

    def create_share(
        self,
        identity: dict[str, object],
        asset_id: str,
        version_id: str = "",
        expires_days: int = 7,
    ) -> dict[str, object]:
        asset = self.workspace.get_asset(identity, asset_id)
        selected_version = _clean(version_id) or _clean(asset.get("current_version_id"))
        if not selected_version or not any(_clean(item.get("id")) == selected_version for item in asset.get("versions", [])):
            raise ValueError("version not found")
        token = secrets.token_urlsafe(32)
        expires_at = (_now() + timedelta(days=max(1, min(int(expires_days), 365)))).isoformat(timespec="seconds")
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_shares(token, owner_id, asset_id, version_id, expires_at, created_at) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                (token, _owner(identity), _clean(asset_id), selected_version, expires_at, _now_iso()),
            )
        self.audit(identity, "share.create", entity_type="asset", entity_id=asset_id,
                   details={"version_id": selected_version, "expires_at": expires_at})
        return {"token": token, "asset_id": asset_id, "version_id": selected_version, "expires_at": expires_at}

    def revoke_share(self, identity: dict[str, object], token: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                "UPDATE creative_shares SET revoked_at = ? WHERE token = ? AND owner_id = ? AND revoked_at = ''",
                (_now_iso(), _clean(token), _owner(identity)),
            )
        if cursor.rowcount:
            self.audit(identity, "share.revoke", entity_type="share", entity_id=token)
        return cursor.rowcount > 0

    def get_public_share(self, token: str, *, count_download: bool = False) -> dict[str, object]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT s.*, a.name, a.asset_type, a.tags, v.image_url, v.image_path, v.prompt, v.params, "
                "v.version_number, v.created_at AS version_created_at FROM creative_shares s "
                "JOIN creative_assets a ON a.id = s.asset_id AND a.deleted_at = '' "
                "JOIN creative_versions v ON v.id = s.version_id AND v.deleted_at = '' WHERE s.token = ?",
                (_clean(token),),
            ).fetchone()
            if row is None or row["revoked_at"]:
                raise ValueError("share not found")
            if row["expires_at"] and datetime.fromisoformat(row["expires_at"]) < _now():
                raise ValueError("share expired")
            if count_download:
                connection.execute("UPDATE creative_shares SET downloads = downloads + 1 WHERE token = ?", (_clean(token),))
        return {
            "token": row["token"], "asset": {"id": row["asset_id"], "name": row["name"],
            "asset_type": row["asset_type"], "tags": _loads(row["tags"], [])},
            "version": {"id": row["version_id"], "version_number": int(row["version_number"]),
            "image_url": portable_image_url(row["image_url"], row["image_path"]),
            "prompt": row["prompt"], "params": _loads(row["params"], {}),
            "created_at": row["version_created_at"]},
            "expires_at": row["expires_at"], "downloads": int(row["downloads"]) + (1 if count_download else 0),
        }

    def submit_review(self, identity: dict[str, object], asset_id: str, version_id: str) -> dict[str, object]:
        asset = self.workspace.get_asset(identity, asset_id)
        if not any(_clean(item.get("id")) == _clean(version_id) for item in asset.get("versions", [])):
            raise ValueError("version not found")
        review_id = uuid.uuid4().hex
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_reviews(id, owner_id, asset_id, version_id, submitted_by, submitted_at) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                (review_id, _owner(identity), _clean(asset_id), _clean(version_id), _owner(identity), _now_iso()),
            )
        self.audit(identity, "review.submit", entity_type="version", entity_id=version_id)
        return self.get_review(identity, review_id)

    def get_review(self, identity: dict[str, object], review_id: str) -> dict[str, object]:
        clauses = ["r.id = ?"]
        args: list[object] = [_clean(review_id)]
        if _role(identity) != "admin":
            clauses.append("r.owner_id = ?")
            args.append(_owner(identity))
        with self._connection() as connection:
            row = connection.execute(
                "SELECT r.*, a.name AS asset_name, v.image_url, v.image_path, v.version_number "
                "FROM creative_reviews r JOIN creative_assets a ON a.id = r.asset_id "
                "JOIN creative_versions v ON v.id = r.version_id "
                f"WHERE {' AND '.join(clauses)}", args,
            ).fetchone()
        if row is None:
            raise ValueError("review not found")
        return {
            "id": row["id"], "owner_id": row["owner_id"], "asset_id": row["asset_id"],
            "asset_name": row["asset_name"], "version_id": row["version_id"],
            "version_number": int(row["version_number"]), "status": row["status"],
            "submitted_by": row["submitted_by"], "submitted_at": row["submitted_at"],
            "reviewed_by": row["reviewed_by"], "reviewed_at": row["reviewed_at"], "comment": row["comment"],
            "image_url": portable_image_url(row["image_url"], row["image_path"]),
        }

    def list_reviews(self, identity: dict[str, object], status: str = "") -> list[dict[str, object]]:
        clauses = ["1=1"]
        args: list[object] = []
        if _role(identity) != "admin":
            clauses.append("r.owner_id = ?")
            args.append(_owner(identity))
        if _clean(status):
            clauses.append("r.status = ?")
            args.append(_clean(status))
        with self._connection() as connection:
            ids = [row[0] for row in connection.execute(
                f"SELECT r.id FROM creative_reviews r WHERE {' AND '.join(clauses)} ORDER BY r.submitted_at DESC", args
            ).fetchall()]
        return [self.get_review(identity, item_id) for item_id in ids]

    def resolve_review(self, identity: dict[str, object], review_id: str, status: str, comment: str = "") -> dict[str, object]:
        if _role(identity) != "admin":
            raise ValueError("administrator required")
        normalized = _clean(status)
        if normalized not in {"approved", "rejected"}:
            raise ValueError("invalid review status")
        with self._connection() as connection:
            cursor = connection.execute(
                "UPDATE creative_reviews SET status = ?, reviewed_by = ?, reviewed_at = ?, comment = ? "
                "WHERE id = ? AND status = 'pending'",
                (normalized, _owner(identity), _now_iso(), _clean(comment)[:1000], _clean(review_id)),
            )
        if cursor.rowcount == 0:
            raise ValueError("pending review not found")
        self.audit(identity, f"review.{normalized}", entity_type="review", entity_id=review_id,
                   details={"comment": _clean(comment)[:300]})
        return self.get_review(identity, review_id)

    def _trash_entity(
        self,
        identity: dict[str, object],
        entity_type: str,
        entity_id: str,
        row: sqlite3.Row,
        extra: dict[str, object] | None = None,
    ) -> None:
        now = _now()
        snapshot = {key: row[key] for key in row.keys()}
        snapshot.update(extra or {})
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_trash(id, owner_id, entity_type, entity_id, snapshot, deleted_at, expires_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, entity_type, entity_id) DO UPDATE SET "
                "snapshot=excluded.snapshot, deleted_at=excluded.deleted_at, expires_at=excluded.expires_at",
                (
                    uuid.uuid4().hex, _owner(identity), entity_type, entity_id, _json(snapshot),
                    now.isoformat(timespec="seconds"), (now + timedelta(days=30)).isoformat(timespec="seconds"),
                ),
            )

    def trash(self, identity: dict[str, object], entity_type: str, entity_id: str) -> bool:
        table_map = {"project": "creative_projects", "asset": "creative_assets", "version": "creative_versions"}
        table = table_map.get(_clean(entity_type))
        if table is None:
            raise ValueError("invalid trash entity")
        with self._connection() as connection:
            row = connection.execute(
                f"SELECT * FROM {table} WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                (_clean(entity_id), _owner(identity)),
            ).fetchone()
        if row is None:
            return False
        extra: dict[str, object] = {}
        if entity_type == "project":
            with self._connection() as connection:
                extra["asset_ids"] = [
                    item[0]
                    for item in connection.execute(
                        "SELECT id FROM creative_assets WHERE project_id = ? AND owner_id = ? AND deleted_at = ''",
                        (_clean(entity_id), _owner(identity)),
                    ).fetchall()
                ]
        self._trash_entity(identity, entity_type, entity_id, row, extra)
        with self._connection() as connection:
            connection.execute(
                f"UPDATE {table} SET deleted_at = ? WHERE id = ? AND owner_id = ?",
                (_now_iso(), _clean(entity_id), _owner(identity)),
            )
            if entity_type == "project":
                connection.execute(
                    "UPDATE creative_assets SET project_id = NULL, updated_at = ? "
                    "WHERE project_id = ? AND owner_id = ? AND deleted_at = ''",
                    (_now_iso(), _clean(entity_id), _owner(identity)),
                )
            if entity_type == "version":
                asset_id = _clean(row["asset_id"])
                current = connection.execute(
                    "SELECT current_version_id FROM creative_assets WHERE id = ? AND owner_id = ?",
                    (asset_id, _owner(identity)),
                ).fetchone()
                if current is not None and current[0] == entity_id:
                    fallback = connection.execute(
                        "SELECT id FROM creative_versions WHERE asset_id = ? AND owner_id = ? AND deleted_at = '' "
                        "ORDER BY version_number DESC LIMIT 1",
                        (asset_id, _owner(identity)),
                    ).fetchone()
                    connection.execute(
                        "UPDATE creative_assets SET current_version_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                        (fallback[0] if fallback else None, _now_iso(), asset_id, _owner(identity)),
                    )
        self.audit(identity, f"{entity_type}.trash", entity_type=entity_type, entity_id=entity_id)
        return True

    def list_trash(self, identity: dict[str, object]) -> list[dict[str, object]]:
        # Access-triggered cleanup keeps the desktop deployment maintenance-free;
        # the explicit administrator endpoint remains available for scheduled jobs.
        self.cleanup_trash()
        clauses = ["owner_id = ?"]
        args: list[object] = [_owner(identity)]
        if _role(identity) == "admin":
            clauses = ["1=1"]
            args = []
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM creative_trash WHERE {' AND '.join(clauses)} ORDER BY deleted_at DESC", args
            ).fetchall()
        return [
            {"id": row["id"], "owner_id": row["owner_id"], "entity_type": row["entity_type"],
             "entity_id": row["entity_id"], "snapshot": _loads(row["snapshot"], {}),
             "deleted_at": row["deleted_at"], "expires_at": row["expires_at"]}
            for row in rows
        ]

    def restore_trash(self, identity: dict[str, object], trash_id: str) -> bool:
        owner_clause = "" if _role(identity) == "admin" else " AND owner_id = ?"
        args: list[object] = [_clean(trash_id)] + ([] if _role(identity) == "admin" else [_owner(identity)])
        with self._connection() as connection:
            row = connection.execute(f"SELECT * FROM creative_trash WHERE id = ?{owner_clause}", args).fetchone()
            if row is None:
                return False
            table = {"project": "creative_projects", "asset": "creative_assets", "version": "creative_versions"}.get(row["entity_type"])
            if table is None:
                return False
            cursor = connection.execute(
                f"UPDATE {table} SET deleted_at = '' WHERE id = ? AND owner_id = ?",
                (row["entity_id"], row["owner_id"]),
            )
            if cursor.rowcount:
                snapshot = _loads(row["snapshot"], {})
                if row["entity_type"] == "project":
                    asset_ids = [str(item) for item in snapshot.get("asset_ids", []) if str(item)]
                    if asset_ids:
                        placeholders = ",".join("?" for _ in asset_ids)
                        connection.execute(
                            f"UPDATE creative_assets SET project_id = ?, updated_at = ? WHERE owner_id = ? "
                            f"AND id IN ({placeholders}) AND deleted_at = ''",
                            [row["entity_id"], _now_iso(), row["owner_id"], *asset_ids],
                        )
                if row["entity_type"] == "version":
                    connection.execute(
                        "UPDATE creative_assets SET current_version_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                        (row["entity_id"], _now_iso(), _clean(snapshot.get("asset_id")), row["owner_id"]),
                    )
                connection.execute("DELETE FROM creative_trash WHERE id = ?", (row["id"],))
        if cursor.rowcount:
            self.audit(identity, f"{row['entity_type']}.restore", entity_type=row["entity_type"], entity_id=row["entity_id"],
                       owner_id=row["owner_id"])
        return cursor.rowcount > 0

    def purge_trash(self, identity: dict[str, object], trash_id: str) -> bool:
        owner_clause = "" if _role(identity) == "admin" else " AND owner_id = ?"
        args: list[object] = [_clean(trash_id)] + ([] if _role(identity) == "admin" else [_owner(identity)])
        with self._connection() as connection:
            row = connection.execute(f"SELECT * FROM creative_trash WHERE id = ?{owner_clause}", args).fetchone()
            if row is None:
                return False
            table = {"project": "creative_projects", "asset": "creative_assets", "version": "creative_versions"}.get(row["entity_type"])
            if table is None:
                return False
            connection.execute(f"DELETE FROM {table} WHERE id = ? AND owner_id = ?", (row["entity_id"], row["owner_id"]))
            connection.execute("DELETE FROM creative_trash WHERE id = ?", (row["id"],))
        self.audit(identity, f"{row['entity_type']}.purge", entity_type=row["entity_type"], entity_id=row["entity_id"],
                   owner_id=row["owner_id"])
        return True

    def cleanup_trash(self) -> int:
        with self._connection() as connection:
            ids = [row[0] for row in connection.execute(
                "SELECT id FROM creative_trash WHERE expires_at <> '' AND expires_at <= ?", (_now_iso(),)
            ).fetchall()]
        system = {"id": "system", "role": "admin", "name": "system"}
        return sum(1 for item_id in ids if self.purge_trash(system, item_id))

    def save_local_version(
        self,
        identity: dict[str, object],
        asset_id: str,
        image_data: bytes,
        *,
        filename: str = "canvas.png",
        prompt: str = "",
        operation: str = "canvas",
        parent_version_id: str = "",
        params: dict[str, object] | None = None,
        base_url: str = "",
    ) -> dict[str, object]:
        asset = self.workspace.get_asset(identity, asset_id)
        extension = Path(filename).suffix.lower().lstrip(".") or "png"
        stored = image_storage_service.save(image_data, base_url=base_url, extension=extension)
        version = self.workspace._insert_version(
            owner=_owner(identity), asset_id=_clean(asset_id), task_id=f"canvas:{uuid.uuid4().hex}",
            image_index=0, operation=_clean(operation, "canvas")[:40], image_path=stored.rel,
            image_url=stored.url, prompt=_clean(prompt)[:4000], params=params or {},
            parent_version_id=_clean(parent_version_id) or _clean(asset.get("current_version_id")), make_current=True,
        )
        self.audit(identity, "version.local_create", entity_type="version", entity_id=_clean(version.get("id")),
                   details={"asset_id": asset_id, "operation": operation})
        self.analyze_asset(identity, asset_id)
        return self.workspace.get_asset(identity, asset_id)

    @staticmethod
    def _image_features(payload: bytes) -> tuple[str, str]:
        with Image.open(io.BytesIO(payload)) as source:
            image = source.convert("RGB")
            sample = image.copy()
            sample.thumbnail((64, 64))
            mean = ImageStat.Stat(sample).mean
            color = "#%02x%02x%02x" % tuple(max(0, min(255, int(value))) for value in mean[:3])
            gray = image.resize((9, 8)).convert("L")
            pixels = list(gray.get_flattened_data())
            bits = [pixels[y * 9 + x] > pixels[y * 9 + x + 1] for y in range(8) for x in range(8)]
            value = sum((1 << index) for index, enabled in enumerate(bits) if enabled)
            return color, f"{value:016x}"

    @staticmethod
    def _smart_tags(text: str) -> list[str]:
        mappings = {
            "人物": ("人物", "人像", "写真", "女孩", "男孩", "模特", "portrait", "person"),
            "商品": ("商品", "产品", "电商", "主图", "包装", "product", "ecommerce"),
            "海报": ("海报", "广告", "宣传", "poster"),
            "证件照": ("证件照", "身份证", "id photo"),
            "写实": ("写实", "真实", "摄影", "photo", "realistic"),
            "插画": ("插画", "漫画", "卡通", "illustration", "anime"),
            "极简": ("极简", "简约", "minimal"),
            "电影感": ("电影感", "cinematic"),
            "夜景": ("夜景", "夜晚", "霓虹", "night"),
            "室内": ("室内", "房间", "家居", "interior"),
            "风景": ("风景", "山", "海", "湖", "森林", "landscape"),
        }
        lowered = text.lower()
        return [tag for tag, keywords in mappings.items() if any(keyword.lower() in lowered for keyword in keywords)]

    @staticmethod
    def _hamming(left: str, right: str) -> int:
        try:
            return (int(left, 16) ^ int(right, 16)).bit_count()
        except (TypeError, ValueError):
            return 65

    def analyze_asset(self, identity: dict[str, object], asset_id: str) -> dict[str, object]:
        owner = _owner(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT a.*, v.prompt, v.image_path FROM creative_assets a "
                "LEFT JOIN creative_versions v ON v.id = a.current_version_id "
                "WHERE a.id = ? AND a.owner_id = ? AND a.deleted_at = ''",
                (_clean(asset_id), owner),
            ).fetchone()
        if row is None:
            raise ValueError("asset not found")
        prompt = _clean(row["prompt"])
        metadata = _loads(row["metadata"], {})
        tags = _tags(_loads(row["tags"], []))
        smart_tags = self._smart_tags(f"{row['name']} {prompt}")
        dominant_color = _clean(metadata.get("dominant_color"))
        perceptual_hash = _clean(metadata.get("perceptual_hash"))
        path = _clean(row["image_path"])
        if path:
            try:
                dominant_color, perceptual_hash = self._image_features(image_storage_service.get_bytes(path))
            except Exception:
                pass
        duplicate_of = ""
        duplicate_distance: int | None = None
        if perceptual_hash:
            with self._connection() as connection:
                candidates = connection.execute(
                    "SELECT id, metadata FROM creative_assets "
                    "WHERE owner_id = ? AND id <> ? AND deleted_at = '' "
                    "AND (created_at < ? OR (created_at = ? AND id < ?))",
                    (owner, _clean(asset_id), row["created_at"], row["created_at"], _clean(asset_id)),
                ).fetchall()
            for candidate in candidates:
                candidate_hash = _clean(_loads(candidate["metadata"], {}).get("perceptual_hash"))
                distance = self._hamming(candidate_hash, perceptual_hash)
                if distance <= 8 and (duplicate_distance is None or distance < duplicate_distance):
                    duplicate_of = candidate["id"]
                    duplicate_distance = distance
        title_source = prompt or _clean(row["name"], "未命名作品")
        smart_title = title_source.replace("\n", " ")[:36]
        metadata.update({
            "smart_title": smart_title,
            "smart_tags": smart_tags,
            "dominant_color": dominant_color,
            "perceptual_hash": perceptual_hash,
            "duplicate_of": duplicate_of,
            "duplicate_distance": duplicate_distance,
            "duplicate_similarity": round((64 - duplicate_distance) / 64 * 100, 1)
            if duplicate_distance is not None
            else None,
            "analyzed_at": _now_iso(),
        })
        merged_tags = _tags([*tags, *smart_tags])
        with self._connection() as connection:
            connection.execute(
                "UPDATE creative_assets SET metadata = ?, tags = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                (_json(metadata), _json(merged_tags), _now_iso(), _clean(asset_id), owner),
            )
        return {"asset_id": asset_id, "metadata": metadata, "tags": merged_tags}

    def detect_duplicate_assets(
        self,
        identity: dict[str, object],
        *,
        threshold: int = 8,
        limit: int = 200,
    ) -> dict[str, object]:
        """Refresh perceptual hashes and persist owner-scoped near-duplicate relationships."""
        owner = _owner(identity)
        safe_threshold = max(0, min(int(threshold), 16))
        safe_limit = max(2, min(int(limit), 500))
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT a.id, a.name, a.metadata, v.image_path FROM creative_assets a "
                "LEFT JOIN creative_versions v ON v.id = a.current_version_id "
                "WHERE a.owner_id = ? AND a.deleted_at = '' AND a.asset_type = 'image' "
                "ORDER BY a.created_at ASC, a.id ASC LIMIT ?",
                (owner, safe_limit),
            ).fetchall()

        analyzed: list[dict[str, object]] = []
        failures: list[dict[str, str]] = []
        for row in rows:
            metadata = _loads(row["metadata"], {})
            path = _clean(row["image_path"])
            perceptual_hash = _clean(metadata.get("perceptual_hash"))
            dominant_color = _clean(metadata.get("dominant_color"))
            if path:
                try:
                    dominant_color, perceptual_hash = self._image_features(
                        image_storage_service.get_bytes(path)
                    )
                except Exception as exc:
                    module_logger.warning(
                        "duplicate scan could not read asset %s: %s",
                        _clean(row["id"]),
                        type(exc).__name__,
                    )
                    failures.append({"asset_id": _clean(row["id"]), "error": "图片读取失败"})
            analyzed.append(
                {
                    "id": _clean(row["id"]),
                    "name": _clean(row["name"]),
                    "metadata": metadata,
                    "perceptual_hash": perceptual_hash,
                    "dominant_color": dominant_color,
                }
            )

        pairs: list[dict[str, object]] = []
        updates: list[tuple[str, str]] = []
        for index, item in enumerate(analyzed):
            item_hash = _clean(item.get("perceptual_hash"))
            nearest: dict[str, object] | None = None
            nearest_distance = 65
            if item_hash:
                for candidate in analyzed[:index]:
                    candidate_hash = _clean(candidate.get("perceptual_hash"))
                    distance = self._hamming(item_hash, candidate_hash)
                    if distance < nearest_distance:
                        nearest = candidate
                        nearest_distance = distance
            duplicate_of = ""
            similarity: float | None = None
            if nearest is not None and nearest_distance <= safe_threshold:
                duplicate_of = _clean(nearest.get("id"))
                similarity = round((64 - nearest_distance) / 64 * 100, 1)
                pairs.append(
                    {
                        "asset_id": _clean(item.get("id")),
                        "asset_name": _clean(item.get("name")),
                        "duplicate_of": duplicate_of,
                        "duplicate_name": _clean(nearest.get("name")),
                        "distance": nearest_distance,
                        "similarity": similarity,
                        "exact": nearest_distance == 0,
                    }
                )
            metadata = dict(item.get("metadata") or {})
            metadata.update(
                {
                    "dominant_color": _clean(item.get("dominant_color")),
                    "perceptual_hash": item_hash,
                    "duplicate_of": duplicate_of,
                    "duplicate_distance": nearest_distance if duplicate_of else None,
                    "duplicate_similarity": similarity,
                    "duplicate_scanned_at": _now_iso(),
                }
            )
            updates.append((_json(metadata), _clean(item.get("id"))))

        if updates:
            with self._connection() as connection:
                connection.executemany(
                    "UPDATE creative_assets SET metadata = ? WHERE id = ? AND owner_id = ?",
                    [(metadata, asset_id, owner) for metadata, asset_id in updates],
                )
        self.audit(
            identity,
            "asset.duplicate_scan",
            entity_type="asset",
            details={"scanned": len(analyzed), "duplicates": len(pairs), "threshold": safe_threshold},
        )
        return {
            "summary": {
                "scanned": len(analyzed),
                "duplicates": len(pairs),
                "exact_duplicates": sum(1 for pair in pairs if pair["exact"]),
                "failures": len(failures),
                "threshold": safe_threshold,
            },
            "pairs": pairs,
            "failures": failures,
            "scanned_at": _now_iso(),
        }

    def search_assets(
        self,
        identity: dict[str, object],
        *,
        query: str = "",
        person: str = "",
        color: str = "",
        style: str = "",
        date_from: str = "",
        date_to: str = "",
        similar_to: str = "",
        limit: int = 100,
    ) -> list[dict[str, object]]:
        clauses = ["a.owner_id = ?", "a.deleted_at = ''"]
        args: list[object] = [_owner(identity)]
        if _clean(date_from):
            clauses.append("a.created_at >= ?")
            args.append(_clean(date_from))
        if _clean(date_to):
            clauses.append("a.created_at <= ?")
            args.append(_clean(date_to) + ("T23:59:59" if "T" not in _clean(date_to) else ""))
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT a.*, v.image_url, v.image_path, v.prompt, v.version_number FROM creative_assets a "
                "LEFT JOIN creative_versions v ON v.id = a.current_version_id "
                f"WHERE {' AND '.join(clauses)} ORDER BY a.updated_at DESC LIMIT ?",
                [*args, max(1, min(int(limit), 500))],
            ).fetchall()
            target_hash = ""
            if _clean(similar_to):
                target = connection.execute(
                    "SELECT metadata FROM creative_assets WHERE id = ? AND owner_id = ? AND deleted_at = ''",
                    (_clean(similar_to), _owner(identity)),
                ).fetchone()
                target_hash = _clean(_loads(target[0], {}).get("perceptual_hash")) if target else ""
        needle = _clean(query).lower()
        person_needle = _clean(person).lower()
        style_needle = _clean(style).lower()
        color_needle = _clean(color).lower()
        result: list[dict[str, object]] = []
        for row in rows:
            metadata = _loads(row["metadata"], {})
            tags = _tags(_loads(row["tags"], []))
            haystack = " ".join([row["name"], _clean(row["prompt"]), " ".join(tags), _clean(metadata.get("smart_title"))]).lower()
            if needle and needle not in haystack:
                continue
            if person_needle and person_needle not in haystack:
                continue
            if style_needle and style_needle not in haystack:
                continue
            if color_needle and color_needle not in _clean(metadata.get("dominant_color")).lower() and color_needle not in haystack:
                continue
            similarity = None
            if target_hash:
                candidate_hash = _clean(metadata.get("perceptual_hash"))
                distance = self._hamming(target_hash, candidate_hash)
                if distance > 12:
                    continue
                similarity = round(100.0 * (64 - distance) / 64, 1)
            result.append({
                "id": row["id"], "project_id": row["project_id"], "name": row["name"],
                "asset_type": row["asset_type"], "favorite": bool(row["favorite"]), "tags": tags,
                "metadata": metadata, "current_version_id": row["current_version_id"],
                "current_image_url": portable_image_url(row["image_url"], row["image_path"]),
                "current_image_path": row["image_path"] or "", "current_version_number": int(row["version_number"] or 0),
                "prompt": row["prompt"] or "", "created_at": row["created_at"], "updated_at": row["updated_at"],
                **({"similarity": similarity} if similarity is not None else {}),
            })
        return result


advanced_creative_service = AdvancedCreativeService()
