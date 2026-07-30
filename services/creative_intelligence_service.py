from __future__ import annotations

import io
import json
import math
import mimetypes
import os
import re
import smtplib
import socket
import sqlite3
import struct
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from PIL import Image, ImageFilter, ImageOps

from services.config import DATA_DIR
from services.creative_workspace_service import creative_workspace_service, portable_image_url
from services.image_storage_service import image_storage_service
from services.protocol.conversation import ConversationRequest, collect_text, text_backend
from utils.log import logger


IMAGE_EMBEDDING_MODEL = "Qdrant/clip-ViT-B-32-vision"
TEXT_EMBEDDING_MODEL = "Qdrant/clip-ViT-B-32-text"
EMBEDDING_DIMENSION = 512
DELIVERY_MAX_BYTES = 2 * 1024 * 1024 * 1024

DERIVATIVE_PRESETS: dict[str, tuple[str, int, int]] = {
    "xiaohongshu": ("小红书竖图", 1080, 1440),
    "ecommerce": ("电商主图", 1200, 1200),
    "wechat": ("公众号封面", 900, 383),
    "poster": ("竖版海报", 1080, 1920),
}

QUALITY_SYSTEM_PROMPT = """你是严格的商业图片质检专家。分析上传图片，只输出一个 JSON 对象，不要 Markdown。
固定字段：overall、text、anatomy、face、brand、composition、issues、strengths、recommendation。
overall/text/anatomy/face/brand/composition 都是 0 到 100 的整数。
text 检查乱码、错字、缺字与排版；anatomy 检查手指、手脚、肢体结构；face 检查五官和表情；
brand 检查 Logo、包装与品牌元素是否清晰变形；composition 检查主体、层次、留白、裁切与视觉焦点。
issues 和 strengths 是简短中文字符串数组，recommendation 是一句可执行的中文改进建议。
看不见的类别给 100 分并在建议中说明无需检查，不猜测人物身份或品牌。"""


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("通知地址不允许重定向")


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean(value: object, limit: int = 4_000) -> str:
    return str(value or "").strip()[:limit]


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id"), 120) or "anonymous"


def _json_dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_load(value: object, default: Any) -> Any:
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed


def _bounded_int(value: object, default: int = 0, minimum: int = 0, maximum: int = 100) -> int:
    try:
        parsed = int(round(float(value)))
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _normalize_string_list(value: object, limit: int = 12) -> list[str]:
    source = value if isinstance(value, list) else []
    result: list[str] = []
    for item in source:
        text = _clean(item, 240)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _normalize_vector(values: Iterable[object]) -> list[float]:
    vector = [float(item) for item in values]
    norm = math.sqrt(sum(item * item for item in vector))
    if not vector or norm <= 0:
        raise ValueError("embedding model returned an empty vector")
    return [item / norm for item in vector]


def _pack_vector(values: Iterable[object]) -> tuple[bytes, int]:
    vector = _normalize_vector(values)
    return struct.pack(f"<{len(vector)}f", *vector), len(vector)


def _unpack_vector(payload: bytes, dimension: int) -> tuple[float, ...]:
    if dimension <= 0 or len(payload) != dimension * 4:
        raise ValueError("invalid embedding payload")
    return struct.unpack(f"<{dimension}f", payload)


def _cosine(left: Iterable[float], right: Iterable[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=False))


def _safe_filename(value: object, fallback: str = "item") -> str:
    text = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "-", _clean(value, 120)).strip(" .-")
    return text or fallback


class CreativeIntelligenceService:
    """Asset intelligence, branching, delivery, notification and budget domain service."""

    def __init__(
        self,
        path: Path = DATA_DIR / "creative_workspace.db",
        *,
        image_model_factory: Callable[[], object] | None = None,
        text_model_factory: Callable[[], object] | None = None,
        workspace_service: object | None = None,
        storage_service: object | None = None,
    ):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.model_cache = DATA_DIR / "model_cache" / "fastembed"
        self._lock = threading.RLock()
        self._model_lock = threading.Lock()
        self._image_model_factory = image_model_factory
        self._text_model_factory = text_model_factory
        self.workspace = workspace_service or creative_workspace_service
        self.storage = storage_service or image_storage_service
        self._image_model: object | None = None
        self._text_model: object | None = None
        self._embedding_background = ThreadPoolExecutor(max_workers=1, thread_name_prefix="creative-embedding")
        self._quality_background = ThreadPoolExecutor(max_workers=1, thread_name_prefix="creative-quality")
        self._notifications = ThreadPoolExecutor(max_workers=2, thread_name_prefix="creative-notification")
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
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
                CREATE TABLE IF NOT EXISTS creative_asset_embeddings (
                    version_id TEXT PRIMARY KEY,
                    asset_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    model TEXT NOT NULL,
                    dimension INTEGER NOT NULL DEFAULT 0,
                    vector BLOB,
                    status TEXT NOT NULL DEFAULT 'pending',
                    error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_embeddings_owner_asset
                    ON creative_asset_embeddings(owner_id, asset_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_quality_reviews (
                    version_id TEXT PRIMARY KEY,
                    asset_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    scores TEXT NOT NULL DEFAULT '{}',
                    issues TEXT NOT NULL DEFAULT '[]',
                    strengths TEXT NOT NULL DEFAULT '[]',
                    recommendation TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT 'auto',
                    error TEXT NOT NULL DEFAULT '',
                    elapsed_ms INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_quality_owner_score
                    ON creative_quality_reviews(owner_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_derivatives (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    source_version_id TEXT NOT NULL,
                    preset TEXT NOT NULL,
                    label TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    mode TEXT NOT NULL,
                    image_path TEXT NOT NULL,
                    image_url TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(owner_id, source_version_id, preset, mode)
                );
                CREATE INDEX IF NOT EXISTS idx_creative_derivatives_asset
                    ON creative_derivatives(owner_id, asset_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS creative_branches (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    root_version_id TEXT NOT NULL,
                    head_version_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(owner_id, asset_id, name)
                );
                CREATE INDEX IF NOT EXISTS idx_creative_branches_asset
                    ON creative_branches(owner_id, asset_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_boards (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    project_id TEXT,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_boards_owner
                    ON creative_boards(owner_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_board_items (
                    id TEXT PRIMARY KEY,
                    board_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    item_type TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    image_path TEXT NOT NULL DEFAULT '',
                    image_url TEXT NOT NULL DEFAULT '',
                    x REAL NOT NULL DEFAULT 0,
                    y REAL NOT NULL DEFAULT 0,
                    width REAL NOT NULL DEFAULT 240,
                    height REAL NOT NULL DEFAULT 180,
                    z_index INTEGER NOT NULL DEFAULT 0,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(board_id) REFERENCES creative_boards(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_creative_board_items_board
                    ON creative_board_items(owner_id, board_id, z_index, created_at);

                CREATE TABLE IF NOT EXISTS creative_notifications (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    payload TEXT NOT NULL DEFAULT '{}',
                    channel_results TEXT NOT NULL DEFAULT '{}',
                    read_at TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_notifications_owner
                    ON creative_notifications(owner_id, read_at, created_at DESC);

                CREATE TABLE IF NOT EXISTS creative_notification_settings (
                    owner_id TEXT PRIMARY KEY,
                    in_app INTEGER NOT NULL DEFAULT 1,
                    browser INTEGER NOT NULL DEFAULT 1,
                    email INTEGER NOT NULL DEFAULT 0,
                    email_to TEXT NOT NULL DEFAULT '',
                    webhook INTEGER NOT NULL DEFAULT 0,
                    webhook_url TEXT NOT NULL DEFAULT '',
                    wecom INTEGER NOT NULL DEFAULT 0,
                    wecom_url TEXT NOT NULL DEFAULT '',
                    events TEXT NOT NULL DEFAULT '["task.success","task.failed","batch.completed","budget.warning","storage.missing"]',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS creative_project_budgets (
                    project_id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    budget_type TEXT NOT NULL DEFAULT 'project',
                    label TEXT NOT NULL DEFAULT '',
                    credit_limit INTEGER NOT NULL,
                    used_credits INTEGER NOT NULL DEFAULT 0,
                    reserved_credits INTEGER NOT NULL DEFAULT 0,
                    unit_cost_cents INTEGER NOT NULL DEFAULT 0,
                    warning_percent INTEGER NOT NULL DEFAULT 80,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_budgets_owner
                    ON creative_project_budgets(owner_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS creative_project_budget_ledger (
                    task_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    amount INTEGER NOT NULL DEFAULT 1,
                    state TEXT NOT NULL,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_creative_budget_ledger_project
                    ON creative_project_budget_ledger(owner_id, project_id, updated_at DESC);
                """
            )
            self._ensure_column(connection, "creative_versions", "branch_id", "TEXT")
            self._ensure_column(connection, "creative_project_budgets", "unit_cost_cents", "INTEGER NOT NULL DEFAULT 0")

    def _owned_version(
        self,
        identity: dict[str, object],
        asset_id: str,
        version_id: str = "",
    ) -> tuple[dict[str, object], dict[str, object]]:
        asset = self.workspace.get_asset(identity, _clean(asset_id, 64))
        versions = asset.get("versions") if isinstance(asset.get("versions"), list) else []
        selected_id = _clean(version_id, 64) or _clean(asset.get("current_version_id"), 64)
        version = next(
            (item for item in versions if isinstance(item, dict) and _clean(item.get("id"), 64) == selected_id),
            None,
        )
        if not isinstance(version, dict):
            raise ValueError("作品缺少可用图片版本")
        return asset, version

    @staticmethod
    def _quality_row(row: sqlite3.Row | None) -> dict[str, object] | None:
        if row is None:
            return None
        return {
            "version_id": row["version_id"],
            "asset_id": row["asset_id"],
            "status": row["status"],
            "scores": _json_load(row["scores"], {}),
            "issues": _json_load(row["issues"], []),
            "strengths": _json_load(row["strengths"], []),
            "recommendation": row["recommendation"],
            "model": row["model"],
            "error": row["error"],
            "elapsed_ms": int(row["elapsed_ms"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _load_image_model(self) -> object:
        with self._model_lock:
            if self._image_model is None:
                if self._image_model_factory is not None:
                    self._image_model = self._image_model_factory()
                else:
                    from fastembed import ImageEmbedding

                    self.model_cache.mkdir(parents=True, exist_ok=True)
                    self._image_model = ImageEmbedding(
                        model_name=IMAGE_EMBEDDING_MODEL,
                        cache_dir=str(self.model_cache),
                        threads=1,
                    )
            return self._image_model

    def _load_text_model(self) -> object:
        with self._model_lock:
            if self._text_model is None:
                if self._text_model_factory is not None:
                    self._text_model = self._text_model_factory()
                else:
                    from fastembed import TextEmbedding

                    self.model_cache.mkdir(parents=True, exist_ok=True)
                    self._text_model = TextEmbedding(
                        model_name=TEXT_EMBEDDING_MODEL,
                        cache_dir=str(self.model_cache),
                        threads=1,
                    )
            return self._text_model

    def index_version(self, identity: dict[str, object], asset_id: str, version_id: str = "") -> dict[str, object]:
        owner = _owner_id(identity)
        _, version = self._owned_version(identity, asset_id, version_id)
        normalized_version_id = _clean(version.get("id"), 64)
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_asset_embeddings(version_id, asset_id, owner_id, model, status, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, 'running', ?, ?) "
                "ON CONFLICT(version_id) DO UPDATE SET status='running', error='', updated_at=excluded.updated_at",
                (normalized_version_id, _clean(asset_id, 64), owner, IMAGE_EMBEDDING_MODEL, now, now),
            )
        try:
            path = _clean(version.get("image_path"), 500)
            if not path:
                raise ValueError("图片尚未保存到本地")
            payload = self.storage.get_bytes(path)
            model = self._load_image_model()
            image = Image.open(io.BytesIO(payload)).convert("RGB")
            vectors = list(model.embed([image]))
            if not vectors:
                raise ValueError("embedding model returned no result")
            packed, dimension = _pack_vector(vectors[0])
            with self._connection() as connection:
                connection.execute(
                    "UPDATE creative_asset_embeddings SET dimension=?, vector=?, status='ready', error='', updated_at=? "
                    "WHERE version_id=? AND owner_id=?",
                    (dimension, packed, _now_iso(), normalized_version_id, owner),
                )
            return {"version_id": normalized_version_id, "asset_id": asset_id, "status": "ready", "dimension": dimension}
        except Exception as exc:
            message = _clean(exc, 500) or exc.__class__.__name__
            with self._connection() as connection:
                connection.execute(
                    "UPDATE creative_asset_embeddings SET status='failed', error=?, updated_at=? "
                    "WHERE version_id=? AND owner_id=?",
                    (message, _now_iso(), normalized_version_id, owner),
                )
            raise

    def index_owner_assets(self, identity: dict[str, object], limit: int = 500) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT v.asset_id, v.id FROM creative_versions v "
                "LEFT JOIN creative_asset_embeddings e ON e.version_id=v.id "
                "WHERE v.owner_id=? AND v.deleted_at='' AND v.image_path<>'' AND (e.version_id IS NULL OR e.status<>'ready') "
                "ORDER BY v.created_at DESC LIMIT ?",
                (owner, max(1, min(int(limit), 2_000))),
            ).fetchall()
        indexed: list[str] = []
        failed: list[dict[str, str]] = []
        for row in rows:
            try:
                self.index_version(identity, row["asset_id"], row["id"])
                indexed.append(str(row["id"]))
            except Exception as exc:
                failed.append({"version_id": str(row["id"]), "error": _clean(exc, 300)})
        return {"indexed": indexed, "failed": failed, "total": len(rows)}

    def semantic_search(
        self,
        identity: dict[str, object],
        query: str,
        *,
        project_id: str = "",
        asset_type: str = "",
        minimum_score: float = 0.0,
        limit: int = 40,
    ) -> list[dict[str, object]]:
        normalized_query = _clean(query, 500)
        if not normalized_query:
            raise ValueError("请输入图片语义描述")
        model = self._load_text_model()
        vectors = list(model.embed([normalized_query]))
        if not vectors:
            raise RuntimeError("text embedding model returned no result")
        query_vector = _normalize_vector(vectors[0])
        owner = _owner_id(identity)
        clauses = ["e.owner_id=?", "e.status='ready'", "a.deleted_at=''", "v.deleted_at=''", "e.vector IS NOT NULL"]
        args: list[object] = [owner]
        if _clean(project_id, 64):
            clauses.append("a.project_id=?")
            args.append(_clean(project_id, 64))
        if _clean(asset_type, 40):
            clauses.append("a.asset_type=?")
            args.append(_clean(asset_type, 40))
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT e.vector, e.dimension, e.version_id, e.asset_id, a.name, a.project_id, a.asset_type, "
                "a.tags, a.favorite, v.image_path, v.image_url, v.prompt, v.created_at "
                "FROM creative_asset_embeddings e JOIN creative_assets a ON a.id=e.asset_id AND a.owner_id=e.owner_id "
                "JOIN creative_versions v ON v.id=e.version_id AND v.owner_id=e.owner_id "
                f"WHERE {' AND '.join(clauses)}",
                args,
            ).fetchall()
        query_terms = {item for item in re.split(r"\s+", normalized_query.lower()) if item}
        best: dict[str, dict[str, object]] = {}
        for row in rows:
            try:
                vector = _unpack_vector(bytes(row["vector"]), int(row["dimension"]))
            except (TypeError, ValueError, struct.error):
                continue
            semantic_score = _cosine(query_vector, vector)
            searchable = " ".join(
                (_clean(row["name"]), _clean(row["prompt"]), " ".join(_json_load(row["tags"], [])))
            ).lower()
            keyword_bonus = 0.08 if query_terms and any(term in searchable for term in query_terms) else 0.0
            score = min(1.0, max(-1.0, semantic_score + keyword_bonus))
            if score < float(minimum_score):
                continue
            item = {
                "asset_id": row["asset_id"],
                "version_id": row["version_id"],
                "name": row["name"],
                "project_id": row["project_id"],
                "asset_type": row["asset_type"],
                "tags": _json_load(row["tags"], []),
                "favorite": bool(row["favorite"]),
                "image_path": row["image_path"],
                "image_url": portable_image_url(row["image_url"], row["image_path"]),
                "prompt": row["prompt"],
                "created_at": row["created_at"],
                "semantic_score": round(float(score), 4),
            }
            existing = best.get(str(row["asset_id"]))
            if existing is None or float(item["semantic_score"]) > float(existing["semantic_score"]):
                best[str(row["asset_id"])] = item
        return sorted(best.values(), key=lambda item: float(item["semantic_score"]), reverse=True)[: max(1, min(limit, 200))]

    @staticmethod
    def _parse_quality_response(value: object) -> dict[str, object]:
        text = re.sub(r"<think\b[^>]*>.*?</think\s*>", "", str(value or ""), flags=re.I | re.S).strip()
        fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.I | re.S)
        candidate = fenced.group(1) if fenced else text[text.find("{") : text.rfind("}") + 1]
        try:
            data = json.loads(candidate)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("图片质检服务未返回有效 JSON") from exc
        if not isinstance(data, dict):
            raise ValueError("图片质检结果格式无效")
        scores = {
            key: _bounded_int(data.get(key), 50)
            for key in ("overall", "text", "anatomy", "face", "brand", "composition")
        }
        return {
            "scores": scores,
            "issues": _normalize_string_list(data.get("issues")),
            "strengths": _normalize_string_list(data.get("strengths")),
            "recommendation": _clean(data.get("recommendation"), 600),
        }

    def score_version(self, identity: dict[str, object], asset_id: str, version_id: str = "") -> dict[str, object]:
        owner = _owner_id(identity)
        _, version = self._owned_version(identity, asset_id, version_id)
        normalized_version_id = _clean(version.get("id"), 64)
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_quality_reviews(version_id, asset_id, owner_id, status, created_at, updated_at) "
                "VALUES(?, ?, ?, 'running', ?, ?) ON CONFLICT(version_id) DO UPDATE SET "
                "status='running', error='', updated_at=excluded.updated_at",
                (normalized_version_id, _clean(asset_id, 64), owner, now, now),
            )
        started = time.monotonic()
        try:
            path = _clean(version.get("image_path"), 500)
            if not path:
                raise ValueError("图片尚未保存到本地")
            payload = self.storage.get_bytes(path)
            mime_type = mimetypes.guess_type(path)[0] or "image/png"
            content = collect_text(
                text_backend(),
                ConversationRequest(
                    model="auto",
                    messages=[
                        {"role": "system", "content": QUALITY_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "请对这张候选图片进行商业成片质检并严格按 JSON 返回。"},
                                {"type": "image", "data": payload, "mime": mime_type},
                            ],
                        },
                    ],
                ),
            )
            result = self._parse_quality_response(content)
            elapsed_ms = max(0, round((time.monotonic() - started) * 1_000))
            with self._connection() as connection:
                connection.execute(
                    "UPDATE creative_quality_reviews SET status='ready', scores=?, issues=?, strengths=?, "
                    "recommendation=?, model='auto', error='', elapsed_ms=?, updated_at=? "
                    "WHERE version_id=? AND owner_id=?",
                    (
                        _json_dump(result["scores"]),
                        _json_dump(result["issues"]),
                        _json_dump(result["strengths"]),
                        result["recommendation"],
                        elapsed_ms,
                        _now_iso(),
                        normalized_version_id,
                        owner,
                    ),
                )
        except Exception as exc:
            elapsed_ms = max(0, round((time.monotonic() - started) * 1_000))
            message = _clean(exc, 500) or "图片质检暂时不可用"
            with self._connection() as connection:
                connection.execute(
                    "UPDATE creative_quality_reviews SET status='retryable_failed', error=?, elapsed_ms=?, updated_at=? "
                    "WHERE version_id=? AND owner_id=?",
                    (message, elapsed_ms, _now_iso(), normalized_version_id, owner),
                )
            logger.warning({"event": "creative_quality_failed", "version_id": normalized_version_id, "error_type": exc.__class__.__name__})
        return self.get_quality(identity, asset_id, normalized_version_id)

    def get_quality(self, identity: dict[str, object], asset_id: str, version_id: str = "") -> dict[str, object]:
        _, version = self._owned_version(identity, asset_id, version_id)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_quality_reviews WHERE version_id=? AND owner_id=?",
                (_clean(version.get("id"), 64), _owner_id(identity)),
            ).fetchone()
        return self._quality_row(row) or {
            "version_id": version["id"],
            "asset_id": asset_id,
            "status": "not_started",
            "scores": {},
            "issues": [],
            "strengths": [],
            "recommendation": "",
            "model": "auto",
            "error": "",
            "elapsed_ms": 0,
        }

    def rank_assets(self, identity: dict[str, object], asset_ids: list[str]) -> list[dict[str, object]]:
        owner = _owner_id(identity)
        normalized_ids = list(dict.fromkeys(_clean(item, 64) for item in asset_ids if _clean(item, 64)))[:200]
        if not normalized_ids:
            return []
        placeholders = ",".join("?" for _ in normalized_ids)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT a.id AS asset_id, a.name, a.current_version_id, v.image_path, v.image_url, q.* "
                "FROM creative_assets a LEFT JOIN creative_versions v ON v.id=a.current_version_id "
                "LEFT JOIN creative_quality_reviews q ON q.version_id=a.current_version_id AND q.owner_id=a.owner_id "
                f"WHERE a.owner_id=? AND a.deleted_at='' AND a.id IN ({placeholders})",
                [owner, *normalized_ids],
            ).fetchall()
        items: list[dict[str, object]] = []
        for row in rows:
            scores = _json_load(row["scores"], {}) if row["status"] else {}
            items.append(
                {
                    "asset_id": row["asset_id"],
                    "name": row["name"],
                    "version_id": row["current_version_id"],
                    "image_path": row["image_path"],
                    "image_url": portable_image_url(row["image_url"], row["image_path"]),
                    "quality": self._quality_row(row) if row["status"] else None,
                    "overall": _bounded_int(scores.get("overall"), -1, -1, 100),
                }
            )
        return sorted(items, key=lambda item: int(item["overall"]), reverse=True)

    def queue_quality_ranking(self, identity: dict[str, object], asset_ids: list[str]) -> dict[str, object]:
        normalized_ids = list(dict.fromkeys(_clean(item, 64) for item in asset_ids if _clean(item, 64)))[:200]
        queued: list[str] = []
        skipped: list[str] = []
        failed: list[dict[str, str]] = []
        for asset_id in normalized_ids:
            try:
                asset, version = self._owned_version(identity, asset_id)
            except ValueError as exc:
                failed.append({"asset_id": asset_id, "error": _clean(exc, 240)})
                continue
            version_id = _clean(version.get("id"), 64)
            with self._connection() as connection:
                row = connection.execute(
                    "SELECT status FROM creative_quality_reviews WHERE version_id=? AND owner_id=?",
                    (version_id, _owner_id(identity)),
                ).fetchone()
            if row is not None and row["status"] in {"ready", "running", "pending"}:
                skipped.append(asset_id)
                continue
            now = _now_iso()
            with self._connection() as connection:
                connection.execute(
                    "INSERT INTO creative_quality_reviews(version_id, asset_id, owner_id, status, created_at, updated_at) "
                    "VALUES(?, ?, ?, 'pending', ?, ?) ON CONFLICT(version_id) DO UPDATE SET "
                    "status='pending', error='', updated_at=excluded.updated_at",
                    (version_id, asset["id"], _owner_id(identity), now, now),
                )
            self._quality_background.submit(self.score_version, dict(identity), asset_id, version_id)
            queued.append(asset_id)
        return {"queued": queued, "skipped": skipped, "failed": failed, "total": len(normalized_ids)}

    def generate_derivatives(
        self,
        identity: dict[str, object],
        asset_id: str,
        *,
        version_id: str = "",
        presets: list[str] | None = None,
        mode: str = "contain",
        base_url: str | None = None,
    ) -> list[dict[str, object]]:
        owner = _owner_id(identity)
        _, version = self._owned_version(identity, asset_id, version_id)
        path = _clean(version.get("image_path"), 500)
        if not path:
            raise ValueError("图片尚未保存到本地")
        selected = list(dict.fromkeys(presets or list(DERIVATIVE_PRESETS)))
        invalid = [item for item in selected if item not in DERIVATIVE_PRESETS]
        if invalid:
            raise ValueError(f"不支持的尺寸规格：{', '.join(invalid)}")
        normalized_mode = mode if mode in {"cover", "contain"} else "contain"
        source = ImageOps.exif_transpose(Image.open(io.BytesIO(self.storage.get_bytes(path)))).convert("RGB")
        results: list[dict[str, object]] = []
        for preset in selected:
            label, width, height = DERIVATIVE_PRESETS[preset]
            if normalized_mode == "cover":
                output = ImageOps.fit(source, (width, height), method=Image.Resampling.LANCZOS)
            else:
                background = ImageOps.fit(source, (width, height), method=Image.Resampling.LANCZOS).filter(
                    ImageFilter.GaussianBlur(radius=max(12, min(width, height) // 35))
                )
                foreground = ImageOps.contain(source, (width, height), method=Image.Resampling.LANCZOS)
                x = (width - foreground.width) // 2
                y = (height - foreground.height) // 2
                output = background
                output.paste(foreground, (x, y))
            buffer = io.BytesIO()
            output.save(buffer, format="JPEG", quality=93, optimize=True)
            stored = self.storage.save(buffer.getvalue(), base_url=base_url, extension="jpg")
            derivative_id = uuid.uuid4().hex
            created_at = _now_iso()
            with self._connection() as connection:
                connection.execute(
                    "INSERT INTO creative_derivatives(id, owner_id, asset_id, source_version_id, preset, label, width, "
                    "height, mode, image_path, image_url, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(owner_id, source_version_id, preset, mode) DO UPDATE SET image_path=excluded.image_path, "
                    "image_url=excluded.image_url, created_at=excluded.created_at",
                    (
                        derivative_id,
                        owner,
                        _clean(asset_id, 64),
                        _clean(version.get("id"), 64),
                        preset,
                        label,
                        width,
                        height,
                        normalized_mode,
                        stored.rel,
                        stored.url,
                        created_at,
                    ),
                )
                row = connection.execute(
                    "SELECT * FROM creative_derivatives WHERE owner_id=? AND source_version_id=? AND preset=? AND mode=?",
                    (owner, _clean(version.get("id"), 64), preset, normalized_mode),
                ).fetchone()
            results.append(self._derivative_row(row))
        return results

    @staticmethod
    def _derivative_row(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "asset_id": row["asset_id"],
            "source_version_id": row["source_version_id"],
            "preset": row["preset"],
            "label": row["label"],
            "width": int(row["width"]),
            "height": int(row["height"]),
            "mode": row["mode"],
            "image_path": row["image_path"],
            "image_url": portable_image_url(row["image_url"], row["image_path"]),
            "created_at": row["created_at"],
        }

    def list_derivatives(self, identity: dict[str, object], asset_id: str) -> list[dict[str, object]]:
        self.workspace.get_asset(identity, asset_id)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM creative_derivatives WHERE owner_id=? AND asset_id=? ORDER BY created_at DESC",
                (_owner_id(identity), _clean(asset_id, 64)),
            ).fetchall()
        return [self._derivative_row(row) for row in rows]

    def create_branch(
        self,
        identity: dict[str, object],
        asset_id: str,
        *,
        name: str,
        root_version_id: str = "",
        metadata: dict[str, object] | None = None,
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        _, version = self._owned_version(identity, asset_id, root_version_id)
        normalized_name = _clean(name, 80)
        if not normalized_name:
            raise ValueError("分支名称不能为空")
        branch_id = uuid.uuid4().hex
        now = _now_iso()
        try:
            with self._connection() as connection:
                connection.execute(
                    "INSERT INTO creative_branches(id, owner_id, asset_id, name, root_version_id, head_version_id, "
                    "metadata, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        branch_id,
                        owner,
                        _clean(asset_id, 64),
                        normalized_name,
                        _clean(version.get("id"), 64),
                        _clean(version.get("id"), 64),
                        _json_dump(metadata or {}),
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError("该作品已存在同名分支") from exc
        return self.get_branch(identity, branch_id)

    def get_branch(self, identity: dict[str, object], branch_id: str) -> dict[str, object]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_branches WHERE id=? AND owner_id=?",
                (_clean(branch_id, 64), _owner_id(identity)),
            ).fetchone()
        if row is None:
            raise ValueError("branch not found")
        return self._branch_row(row)

    @staticmethod
    def _branch_row(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "asset_id": row["asset_id"],
            "name": row["name"],
            "root_version_id": row["root_version_id"],
            "head_version_id": row["head_version_id"],
            "status": row["status"],
            "metadata": _json_load(row["metadata"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def version_tree(self, identity: dict[str, object], asset_id: str) -> dict[str, object]:
        asset = self.workspace.get_asset(identity, asset_id)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM creative_branches WHERE owner_id=? AND asset_id=? ORDER BY created_at",
                (_owner_id(identity), _clean(asset_id, 64)),
            ).fetchall()
        versions = list(asset.get("versions") or [])
        return {
            "asset_id": asset_id,
            "current_version_id": asset.get("current_version_id"),
            "branches": [self._branch_row(row) for row in rows],
            "nodes": versions,
            "edges": [
                {"from": item.get("parent_version_id"), "to": item.get("id")}
                for item in versions
                if item.get("parent_version_id")
            ],
        }

    def create_board(
        self,
        identity: dict[str, object],
        *,
        name: str,
        description: str = "",
        project_id: str = "",
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        normalized_project_id = _clean(project_id, 64)
        if normalized_project_id:
            projects = self.workspace.list_projects(identity)
            if not any(_clean(item.get("id"), 64) == normalized_project_id for item in projects):
                raise ValueError("project not found")
        board_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_boards(id, owner_id, project_id, name, description, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (board_id, owner, normalized_project_id or None, _clean(name, 80) or "未命名画板", _clean(description, 500), now, now),
            )
        return self.get_board(identity, board_id)

    def list_boards(self, identity: dict[str, object]) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT b.*, COUNT(i.id) AS item_count FROM creative_boards b LEFT JOIN creative_board_items i "
                "ON i.board_id=b.id AND i.owner_id=b.owner_id WHERE b.owner_id=? GROUP BY b.id ORDER BY b.updated_at DESC",
                (_owner_id(identity),),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "project_id": row["project_id"],
                "name": row["name"],
                "description": row["description"],
                "item_count": int(row["item_count"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def get_board(self, identity: dict[str, object], board_id: str) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_boards WHERE id=? AND owner_id=?",
                (_clean(board_id, 64), owner),
            ).fetchone()
            if row is None:
                raise ValueError("board not found")
            items = connection.execute(
                "SELECT * FROM creative_board_items WHERE board_id=? AND owner_id=? ORDER BY z_index, created_at",
                (_clean(board_id, 64), owner),
            ).fetchall()
        return {
            "id": row["id"],
            "project_id": row["project_id"],
            "name": row["name"],
            "description": row["description"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "items": [self._board_item(item) for item in items],
        }

    def update_board(self, identity: dict[str, object], board_id: str, updates: dict[str, object]) -> dict[str, object]:
        owner = _owner_id(identity)
        current = self.get_board(identity, board_id)
        name = _clean(updates.get("name", current["name"]), 80) or "未命名画板"
        description = _clean(updates.get("description", current["description"]), 500)
        project_id = _clean(updates.get("project_id", current.get("project_id")), 64)
        if project_id:
            projects = self.workspace.list_projects(identity)
            if not any(_clean(item.get("id"), 64) == project_id for item in projects):
                raise ValueError("project not found")
        with self._connection() as connection:
            connection.execute(
                "UPDATE creative_boards SET name=?, description=?, project_id=?, updated_at=? WHERE id=? AND owner_id=?",
                (name, description, project_id or None, _now_iso(), _clean(board_id, 64), owner),
            )
        return self.get_board(identity, board_id)

    def delete_board(self, identity: dict[str, object], board_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM creative_boards WHERE id=? AND owner_id=?",
                (_clean(board_id, 64), _owner_id(identity)),
            )
        return bool(cursor.rowcount)

    @staticmethod
    def _board_item(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "board_id": row["board_id"],
            "item_type": row["item_type"],
            "content": row["content"],
            "image_path": row["image_path"],
            "image_url": portable_image_url(row["image_url"], row["image_path"]),
            "x": float(row["x"]),
            "y": float(row["y"]),
            "width": float(row["width"]),
            "height": float(row["height"]),
            "z_index": int(row["z_index"]),
            "metadata": _json_load(row["metadata"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def add_board_item(
        self,
        identity: dict[str, object],
        board_id: str,
        *,
        item_type: str,
        content: str = "",
        image_path: str = "",
        image_url: str = "",
        x: float = 40,
        y: float = 40,
        width: float = 240,
        height: float = 180,
        z_index: int = 0,
        metadata: dict[str, object] | None = None,
    ) -> dict[str, object]:
        self.get_board(identity, board_id)
        normalized_type = item_type if item_type in {"image", "reference", "text", "color"} else "text"
        normalized_path = _clean(image_path, 500)
        if normalized_path and not self.storage.exists(normalized_path):
            raise ValueError("image not found")
        item_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_board_items(id, board_id, owner_id, item_type, content, image_path, image_url, "
                "x, y, width, height, z_index, metadata, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item_id,
                    _clean(board_id, 64),
                    _owner_id(identity),
                    normalized_type,
                    _clean(content, 4_000),
                    normalized_path,
                    portable_image_url(image_url, normalized_path),
                    float(x),
                    float(y),
                    max(80.0, min(float(width), 1_600.0)),
                    max(60.0, min(float(height), 1_200.0)),
                    int(z_index),
                    _json_dump(metadata or {}),
                    now,
                    now,
                ),
            )
            connection.execute("UPDATE creative_boards SET updated_at=? WHERE id=?", (now, board_id))
            row = connection.execute("SELECT * FROM creative_board_items WHERE id=?", (item_id,)).fetchone()
        return self._board_item(row)

    def update_board_item(
        self,
        identity: dict[str, object],
        board_id: str,
        item_id: str,
        updates: dict[str, object],
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        self.get_board(identity, board_id)
        allowed = {"content", "x", "y", "width", "height", "z_index", "metadata"}
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_board_items WHERE id=? AND board_id=? AND owner_id=?",
                (_clean(item_id, 64), _clean(board_id, 64), owner),
            ).fetchone()
            if row is None:
                raise ValueError("board item not found")
            values = {
                "content": _clean(updates.get("content", row["content"]), 4_000),
                "x": float(updates.get("x", row["x"])),
                "y": float(updates.get("y", row["y"])),
                "width": max(80.0, min(float(updates.get("width", row["width"])), 1_600.0)),
                "height": max(60.0, min(float(updates.get("height", row["height"])), 1_200.0)),
                "z_index": int(updates.get("z_index", row["z_index"])),
                "metadata": _json_dump(updates.get("metadata", _json_load(row["metadata"], {}))),
            }
            if not any(key in allowed for key in updates):
                return self._board_item(row)
            now = _now_iso()
            connection.execute(
                "UPDATE creative_board_items SET content=?, x=?, y=?, width=?, height=?, z_index=?, metadata=?, "
                "updated_at=? WHERE id=? AND board_id=? AND owner_id=?",
                (*values.values(), now, item_id, board_id, owner),
            )
            connection.execute("UPDATE creative_boards SET updated_at=? WHERE id=?", (now, board_id))
            updated = connection.execute("SELECT * FROM creative_board_items WHERE id=?", (item_id,)).fetchone()
        return self._board_item(updated)

    def delete_board_item(self, identity: dict[str, object], board_id: str, item_id: str) -> bool:
        owner = _owner_id(identity)
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM creative_board_items WHERE id=? AND board_id=? AND owner_id=?",
                (_clean(item_id, 64), _clean(board_id, 64), owner),
            )
            if cursor.rowcount:
                connection.execute("UPDATE creative_boards SET updated_at=? WHERE id=?", (_now_iso(), board_id))
        return bool(cursor.rowcount)

    def board_creation_draft(self, identity: dict[str, object], board_id: str) -> dict[str, object]:
        board = self.get_board(identity, board_id)
        text_parts = [_clean(item.get("content"), 1_000) for item in board["items"] if item.get("item_type") in {"text", "color"}]
        references = [
            {"path": item.get("image_path"), "url": item.get("image_url")}
            for item in board["items"]
            if item.get("item_type") in {"image", "reference"} and (item.get("image_path") or item.get("image_url"))
        ]
        return {
            "board_id": board_id,
            "project_id": board.get("project_id"),
            "prompt": "；".join(item for item in text_parts if item),
            "references": references[:4],
        }

    def set_budget(
        self,
        *,
        owner_id: str,
        project_id: str,
        credit_limit: int,
        budget_type: str = "project",
        label: str = "",
        warning_percent: int = 80,
        unit_cost: float = 0,
        enabled: bool = True,
    ) -> dict[str, object]:
        normalized_owner = _clean(owner_id, 120)
        normalized_project = _clean(project_id, 64)
        if not normalized_owner or not normalized_project:
            raise ValueError("owner_id and project_id are required")
        with self._connection() as connection:
            project = connection.execute(
                "SELECT 1 FROM creative_projects WHERE id=? AND owner_id=? AND deleted_at=''",
                (normalized_project, normalized_owner),
            ).fetchone()
            if project is None:
                raise ValueError("project not found")
            existing = connection.execute(
                "SELECT used_credits, reserved_credits, created_at FROM creative_project_budgets WHERE project_id=?",
                (normalized_project,),
            ).fetchone()
            used = int(existing["used_credits"]) if existing else 0
            reserved = int(existing["reserved_credits"]) if existing else 0
            if int(credit_limit) < used + reserved:
                raise ValueError("新预算不能低于已使用与已预留额度")
            now = _now_iso()
            connection.execute(
                "INSERT INTO creative_project_budgets(project_id, owner_id, budget_type, label, credit_limit, "
                "used_credits, reserved_credits, unit_cost_cents, warning_percent, enabled, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET "
                "owner_id=excluded.owner_id, budget_type=excluded.budget_type, label=excluded.label, "
                "credit_limit=excluded.credit_limit, unit_cost_cents=excluded.unit_cost_cents, "
                "warning_percent=excluded.warning_percent, enabled=excluded.enabled, "
                "updated_at=excluded.updated_at",
                (
                    normalized_project,
                    normalized_owner,
                    budget_type if budget_type in {"project", "department", "client"} else "project",
                    _clean(label, 120),
                    max(0, min(int(credit_limit), 10_000_000)),
                    used,
                    reserved,
                    max(0, min(round(float(unit_cost) * 100), 100_000_000)),
                    max(1, min(int(warning_percent), 100)),
                    int(bool(enabled)),
                    existing["created_at"] if existing else now,
                    now,
                ),
            )
        return self.get_budget(normalized_owner, normalized_project)

    def get_budget(self, owner_id: str, project_id: str) -> dict[str, object]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_project_budgets WHERE owner_id=? AND project_id=?",
                (_clean(owner_id, 120), _clean(project_id, 64)),
            ).fetchone()
            if row is None:
                raise ValueError("budget not found")
            stats = connection.execute(
                "SELECT COUNT(*) AS total, SUM(CASE WHEN state='consumed' THEN 1 ELSE 0 END) AS success, "
                "AVG(CASE WHEN state='consumed' AND duration_ms>0 THEN duration_ms END) AS average_ms "
                "FROM creative_project_budget_ledger WHERE owner_id=? AND project_id=?",
                (_clean(owner_id, 120), _clean(project_id, 64)),
            ).fetchone()
        limit = int(row["credit_limit"])
        used = int(row["used_credits"])
        reserved = int(row["reserved_credits"])
        settled_total = int(stats["total"] or 0)
        success = int(stats["success"] or 0)
        return {
            "project_id": row["project_id"],
            "owner_id": row["owner_id"],
            "budget_type": row["budget_type"],
            "label": row["label"],
            "credit_limit": limit,
            "used_credits": used,
            "reserved_credits": reserved,
            "remaining_credits": max(0, limit - used - reserved),
            "unit_cost": round(int(row["unit_cost_cents"]) / 100, 2),
            "estimated_cost": round(used * int(row["unit_cost_cents"]) / 100, 2),
            "warning_percent": int(row["warning_percent"]),
            "warning": limit > 0 and (used + reserved) * 100 >= limit * int(row["warning_percent"]),
            "enabled": bool(row["enabled"]),
            "success_rate": round(success / settled_total, 4) if settled_total else None,
            "average_duration_ms": round(float(stats["average_ms"] or 0)),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_budgets(self, identity: dict[str, object] | None = None) -> list[dict[str, object]]:
        owner = _owner_id(identity or {}) if identity else ""
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT owner_id, project_id FROM creative_project_budgets "
                + ("WHERE owner_id=? " if owner else "")
                + "ORDER BY updated_at DESC",
                (owner,) if owner else (),
            ).fetchall()
        return [self.get_budget(str(row["owner_id"]), str(row["project_id"])) for row in rows]

    def list_budget_projects(self) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT p.id, p.owner_id, p.name, p.description, p.updated_at, COUNT(a.id) AS asset_count "
                "FROM creative_projects p LEFT JOIN creative_assets a ON a.project_id=p.id AND a.deleted_at='' "
                "WHERE p.deleted_at='' GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 1000"
            ).fetchall()
        return [
            {
                "id": row["id"],
                "owner_id": row["owner_id"],
                "name": row["name"],
                "description": row["description"],
                "asset_count": int(row["asset_count"]),
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def reserve_project_budget(
        self,
        identity: dict[str, object],
        project_id: str,
        task_id: str,
        amount: int = 1,
    ) -> bool | None:
        normalized_project = _clean(project_id, 64)
        if not normalized_project:
            return None
        owner = _owner_id(identity)
        normalized_task = _clean(task_id, 120)
        normalized_amount = max(1, min(int(amount), 1_000))
        with self._lock, self._connection() as connection:
            project = connection.execute(
                "SELECT 1 FROM creative_projects WHERE id=? AND owner_id=? AND deleted_at=''",
                (normalized_project, owner),
            ).fetchone()
            if project is None:
                raise ValueError("project not found")
            budget = connection.execute(
                "SELECT * FROM creative_project_budgets WHERE project_id=? AND owner_id=?",
                (normalized_project, owner),
            ).fetchone()
            if budget is None or not bool(budget["enabled"]):
                return None
            ledger = connection.execute(
                "SELECT * FROM creative_project_budget_ledger WHERE task_id=?",
                (normalized_task,),
            ).fetchone()
            if ledger is not None and ledger["owner_id"] != owner:
                raise ValueError("task budget ownership mismatch")
            if ledger is not None and ledger["state"] in {"reserved", "consumed"}:
                return True
            available = int(budget["credit_limit"]) - int(budget["used_credits"]) - int(budget["reserved_credits"])
            if available < normalized_amount:
                return False
            now = _now_iso()
            connection.execute(
                "INSERT INTO creative_project_budget_ledger(task_id, project_id, owner_id, amount, state, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, 'reserved', ?, ?) ON CONFLICT(task_id) DO UPDATE SET project_id=excluded.project_id, "
                "amount=excluded.amount, state='reserved', updated_at=excluded.updated_at",
                (normalized_task, normalized_project, owner, normalized_amount, now, now),
            )
            connection.execute(
                "UPDATE creative_project_budgets SET reserved_credits=reserved_credits+?, updated_at=? "
                "WHERE project_id=? AND owner_id=?",
                (normalized_amount, now, normalized_project, owner),
            )
        return True

    def consume_project_budget(self, identity: dict[str, object], task_id: str, duration_ms: int = 0) -> bool:
        owner = _owner_id(identity)
        with self._lock, self._connection() as connection:
            ledger = connection.execute(
                "SELECT * FROM creative_project_budget_ledger WHERE task_id=? AND owner_id=?",
                (_clean(task_id, 120), owner),
            ).fetchone()
            if ledger is None or ledger["state"] == "consumed":
                return ledger is not None
            if ledger["state"] != "reserved":
                return False
            amount = int(ledger["amount"])
            now = _now_iso()
            connection.execute(
                "UPDATE creative_project_budgets SET reserved_credits=MAX(0,reserved_credits-?), "
                "used_credits=used_credits+?, updated_at=? WHERE project_id=? AND owner_id=?",
                (amount, amount, now, ledger["project_id"], owner),
            )
            connection.execute(
                "UPDATE creative_project_budget_ledger SET state='consumed', duration_ms=?, updated_at=? WHERE task_id=?",
                (max(0, int(duration_ms)), now, _clean(task_id, 120)),
            )
        self._notify_budget_warning(owner, str(ledger["project_id"]))
        return True

    def refund_project_budget(self, identity: dict[str, object], task_id: str) -> bool:
        owner = _owner_id(identity)
        with self._lock, self._connection() as connection:
            ledger = connection.execute(
                "SELECT * FROM creative_project_budget_ledger WHERE task_id=? AND owner_id=?",
                (_clean(task_id, 120), owner),
            ).fetchone()
            if ledger is None or ledger["state"] == "refunded":
                return ledger is not None
            if ledger["state"] != "reserved":
                return False
            amount = int(ledger["amount"])
            now = _now_iso()
            connection.execute(
                "UPDATE creative_project_budgets SET reserved_credits=MAX(0,reserved_credits-?), updated_at=? "
                "WHERE project_id=? AND owner_id=?",
                (amount, now, ledger["project_id"], owner),
            )
            connection.execute(
                "UPDATE creative_project_budget_ledger SET state='refunded', updated_at=? WHERE task_id=?",
                (now, _clean(task_id, 120)),
            )
        return True

    def _notify_budget_warning(self, owner: str, project_id: str) -> None:
        try:
            budget = self.get_budget(owner, project_id)
        except ValueError:
            return
        if budget["warning"]:
            self.create_notification(
                {"id": owner},
                event="budget.warning",
                title="项目额度即将用尽",
                message=f"项目预算已使用 {budget['used_credits']} / {budget['credit_limit']} 张。",
                payload={"project_id": project_id, "remaining": budget["remaining_credits"]},
            )

    @staticmethod
    def _masked_url(value: str) -> str:
        if not value:
            return ""
        try:
            parts = urlsplit(value)
        except ValueError:
            return "***"
        return f"{parts.scheme}://{parts.hostname or '***'}/***"

    def get_notification_settings(self, identity: dict[str, object], *, reveal: bool = False) -> dict[str, object]:
        owner = _owner_id(identity)
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_notification_settings WHERE owner_id=?",
                (owner,),
            ).fetchone()
        if row is None:
            return {
                "in_app": True,
                "browser": True,
                "email": False,
                "email_to": "",
                "webhook": False,
                "webhook_url": "",
                "wecom": False,
                "wecom_url": "",
                "events": ["task.success", "task.failed", "batch.completed", "budget.warning", "storage.missing"],
            }
        return {
            "in_app": bool(row["in_app"]),
            "browser": bool(row["browser"]),
            "email": bool(row["email"]),
            "email_to": row["email_to"],
            "webhook": bool(row["webhook"]),
            "webhook_url": row["webhook_url"] if reveal else self._masked_url(row["webhook_url"]),
            "wecom": bool(row["wecom"]),
            "wecom_url": row["wecom_url"] if reveal else self._masked_url(row["wecom_url"]),
            "events": _json_load(row["events"], []),
            "updated_at": row["updated_at"],
        }

    def update_notification_settings(self, identity: dict[str, object], updates: dict[str, object]) -> dict[str, object]:
        owner = _owner_id(identity)
        current = self.get_notification_settings(identity, reveal=True)
        allowed_events = {"task.success", "task.failed", "batch.completed", "budget.warning", "storage.missing"}
        events = [item for item in updates.get("events", current["events"]) if item in allowed_events]
        webhook_url = _clean(updates.get("webhook_url", current["webhook_url"]), 1_000)
        wecom_url = _clean(updates.get("wecom_url", current["wecom_url"]), 1_000)
        if webhook_url.endswith("/***"):
            webhook_url = _clean(current["webhook_url"], 1_000)
        if wecom_url.endswith("/***"):
            wecom_url = _clean(current["wecom_url"], 1_000)
        for enabled_key, url in (("webhook", webhook_url), ("wecom", wecom_url)):
            if bool(updates.get(enabled_key, current[enabled_key])) and url:
                self._validate_webhook_url(url)
        now = _now_iso()
        values = {
            "in_app": bool(updates.get("in_app", current["in_app"])),
            "browser": bool(updates.get("browser", current["browser"])),
            "email": bool(updates.get("email", current["email"])),
            "email_to": _clean(updates.get("email_to", current["email_to"]), 320),
            "webhook": bool(updates.get("webhook", current["webhook"])),
            "webhook_url": webhook_url,
            "wecom": bool(updates.get("wecom", current["wecom"])),
            "wecom_url": wecom_url,
            "events": events,
        }
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_notification_settings(owner_id, in_app, browser, email, email_to, webhook, "
                "webhook_url, wecom, wecom_url, events, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(owner_id) DO UPDATE SET in_app=excluded.in_app, browser=excluded.browser, "
                "email=excluded.email, email_to=excluded.email_to, webhook=excluded.webhook, "
                "webhook_url=excluded.webhook_url, wecom=excluded.wecom, wecom_url=excluded.wecom_url, "
                "events=excluded.events, updated_at=excluded.updated_at",
                (
                    owner,
                    int(values["in_app"]),
                    int(values["browser"]),
                    int(values["email"]),
                    values["email_to"],
                    int(values["webhook"]),
                    values["webhook_url"],
                    int(values["wecom"]),
                    values["wecom_url"],
                    _json_dump(values["events"]),
                    now,
                ),
            )
        return self.get_notification_settings(identity)

    @staticmethod
    def _validate_webhook_url(value: str) -> None:
        parts = urlsplit(value)
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
            raise ValueError("通知地址必须是无内嵌凭据的 HTTPS URL")
        if os.getenv("ALLOW_PRIVATE_NOTIFICATION_WEBHOOKS", "0") == "1":
            return
        try:
            addresses = socket.getaddrinfo(parts.hostname, parts.port or 443, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise ValueError("通知地址无法解析") from exc
        import ipaddress

        for address in addresses:
            ip = ipaddress.ip_address(address[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified:
                raise ValueError("通知地址不能指向本机或私有网络")

    def create_notification(
        self,
        identity: dict[str, object],
        *,
        event: str,
        title: str,
        message: str,
        payload: dict[str, object] | None = None,
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        settings = self.get_notification_settings(identity, reveal=True)
        if event not in settings["events"]:
            return {"skipped": True, "event": event}
        item_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO creative_notifications(id, owner_id, event, title, message, payload, created_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (item_id, owner, event, _clean(title, 160), _clean(message, 1_000), _json_dump(payload or {}), now),
            )
        if settings["email"] or settings["webhook"] or settings["wecom"]:
            self._notifications.submit(self._dispatch_notification, owner, item_id, settings)
        return {
            "id": item_id,
            "event": event,
            "title": _clean(title, 160),
            "message": _clean(message, 1_000),
            "payload": payload or {},
            "read": False,
            "created_at": now,
        }

    def _dispatch_notification(self, owner: str, item_id: str, settings: dict[str, object]) -> None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM creative_notifications WHERE id=? AND owner_id=?",
                (item_id, owner),
            ).fetchone()
        if row is None:
            return
        payload = {"event": row["event"], "title": row["title"], "message": row["message"], "data": _json_load(row["payload"], {})}
        results: dict[str, object] = {}
        if settings.get("email") and settings.get("email_to"):
            try:
                self._send_email(str(settings["email_to"]), str(row["title"]), str(row["message"]))
                results["email"] = {"ok": True}
            except Exception as exc:
                results["email"] = {"ok": False, "error": _clean(exc, 300)}
        for channel, key in (("webhook", "webhook_url"), ("wecom", "wecom_url")):
            if not settings.get(channel) or not settings.get(key):
                continue
            try:
                body = payload if channel == "webhook" else {"msgtype": "text", "text": {"content": f"{row['title']}\n{row['message']}"}}
                self._post_json(str(settings[key]), body)
                results[channel] = {"ok": True}
            except Exception as exc:
                results[channel] = {"ok": False, "error": _clean(exc, 300)}
        with self._connection() as connection:
            connection.execute(
                "UPDATE creative_notifications SET channel_results=? WHERE id=? AND owner_id=?",
                (_json_dump(results), item_id, owner),
            )

    @staticmethod
    def _post_json(url: str, payload: dict[str, object]) -> None:
        CreativeIntelligenceService._validate_webhook_url(url)
        request = Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": "XG-Creative-Notifier/1.0"},
            method="POST",
        )
        with build_opener(_RejectRedirects()).open(request, timeout=8) as response:
            if not 200 <= int(response.status) < 300:
                raise RuntimeError(f"notification endpoint returned {response.status}")

    @staticmethod
    def _send_email(recipient: str, subject: str, message: str) -> None:
        host = _clean(os.getenv("XG_SMTP_HOST"), 320)
        sender = _clean(os.getenv("XG_SMTP_FROM") or os.getenv("XG_SMTP_USER"), 320)
        if not host or not sender:
            raise RuntimeError("SMTP 未配置")
        port = _bounded_int(os.getenv("XG_SMTP_PORT", "465"), 465, 1, 65535)
        email = EmailMessage()
        email["From"] = sender
        email["To"] = recipient
        email["Subject"] = subject
        email.set_content(message)
        username = _clean(os.getenv("XG_SMTP_USER"), 320)
        password = str(os.getenv("XG_SMTP_PASSWORD") or "")
        use_ssl = os.getenv("XG_SMTP_SSL", "").strip().lower() in {"1", "true", "yes"} or port == 465
        smtp_factory = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
        with smtp_factory(host, port, timeout=8) as smtp:
            if not use_ssl:
                smtp.starttls()
            if username:
                smtp.login(username, password)
            smtp.send_message(email)

    def list_notifications(self, identity: dict[str, object], limit: int = 50) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM creative_notifications WHERE owner_id=? ORDER BY created_at DESC LIMIT ?",
                (_owner_id(identity), max(1, min(int(limit), 200))),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "event": row["event"],
                "title": row["title"],
                "message": row["message"],
                "payload": _json_load(row["payload"], {}),
                "channel_results": _json_load(row["channel_results"], {}),
                "read": bool(row["read_at"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def mark_notification_read(self, identity: dict[str, object], notification_id: str = "") -> int:
        owner = _owner_id(identity)
        with self._connection() as connection:
            if notification_id:
                cursor = connection.execute(
                    "UPDATE creative_notifications SET read_at=? WHERE id=? AND owner_id=? AND read_at=''",
                    (_now_iso(), _clean(notification_id, 64), owner),
                )
            else:
                cursor = connection.execute(
                    "UPDATE creative_notifications SET read_at=? WHERE owner_id=? AND read_at=''",
                    (_now_iso(), owner),
                )
        return max(0, int(cursor.rowcount))

    def notify_task(self, task: dict[str, Any], *, success: bool) -> dict[str, object]:
        owner = _clean(task.get("owner_id"), 120)
        if not owner:
            return {"skipped": True}
        event = "task.success" if success else "task.failed"
        title = "图片生成完成" if success else "图片生成失败"
        message = (
            f"任务 {_clean(task.get('id'), 24)} 已完成，用时 {max(0, int(task.get('duration_ms') or 0)) / 1000:.1f} 秒。"
            if success
            else f"任务 {_clean(task.get('id'), 24)} 失败：{_clean(task.get('error'), 300) or '未知错误'}"
        )
        workflow = task.get("workflow") if isinstance(task.get("workflow"), dict) else {}
        return self.create_notification(
            {"id": owner},
            event=event,
            title=title,
            message=message,
            payload={
                "task_id": task.get("id"),
                "asset_id": workflow.get("asset_id"),
                "version_id": workflow.get("version_id"),
                "project_id": workflow.get("project_id"),
                "status": task.get("status"),
            },
        )

    def notify_batch_completed(
        self,
        identity: dict[str, object],
        batch_id: str,
        counts: dict[str, int],
    ) -> dict[str, object]:
        owner = _owner_id(identity)
        normalized_batch = _clean(batch_id, 64)
        if not normalized_batch:
            return {"skipped": True}
        with self._lock:
            with self._connection() as connection:
                rows = connection.execute(
                    "SELECT payload FROM creative_notifications WHERE owner_id=? AND event='batch.completed' "
                    "ORDER BY created_at DESC LIMIT 200",
                    (owner,),
                ).fetchall()
            if any(_clean(_json_load(row["payload"], {}).get("batch_id"), 64) == normalized_batch for row in rows):
                return {"skipped": True, "duplicate": True}
            total = int(counts.get("total") or 0)
            success = int(counts.get("success") or 0)
            failed = int(counts.get("error") or 0)
            return self.create_notification(
                identity,
                event="batch.completed",
                title="批量任务已完成",
                message=f"本批次共 {total} 项，成功 {success} 项，失败 {failed} 项。",
                payload={"batch_id": normalized_batch, "counts": counts},
            )

    def schedule_asset_intelligence(self, identity: dict[str, object], versions: list[dict[str, object]]) -> None:
        for version in versions:
            asset_id = _clean(version.get("asset_id"), 64)
            version_id = _clean(version.get("id"), 64)
            if not asset_id or not version_id:
                continue
            self._embedding_background.submit(self._index_version_background, dict(identity), asset_id, version_id)
            self._quality_background.submit(self._score_version_background, dict(identity), asset_id, version_id)

    def _index_version_background(self, identity: dict[str, object], asset_id: str, version_id: str) -> None:
        try:
            self.index_version(identity, asset_id, version_id)
        except Exception:
            logger.exception("failed to index creative version %s", version_id)

    def _score_version_background(self, identity: dict[str, object], asset_id: str, version_id: str) -> None:
        try:
            self.score_version(identity, asset_id, version_id)
        except Exception:
            logger.exception("failed to score creative version %s", version_id)

    def build_delivery_package(
        self,
        identity: dict[str, object],
        *,
        project_id: str = "",
        asset_id: str = "",
    ) -> tuple[io.BytesIO, str]:
        owner = _owner_id(identity)
        normalized_project = _clean(project_id, 64)
        normalized_asset = _clean(asset_id, 64)
        if not normalized_project and not normalized_asset:
            raise ValueError("project_id or asset_id is required")
        clauses = ["owner_id=?", "deleted_at='' "]
        args: list[object] = [owner]
        if normalized_project:
            clauses.append("project_id=?")
            args.append(normalized_project)
        if normalized_asset:
            clauses.append("id=?")
            args.append(normalized_asset)
        with self._connection() as connection:
            assets = connection.execute(
                f"SELECT * FROM creative_assets WHERE {' AND '.join(clauses)} ORDER BY updated_at",
                args,
            ).fetchall()
            if not assets:
                raise ValueError("没有可交付的作品")
        archive = io.BytesIO()
        manifest: dict[str, object] = {"generated_at": _now_iso(), "project_id": normalized_project, "assets": [], "missing": []}
        total_bytes = 0
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as output:
            for asset_row in assets:
                asset = self.workspace.get_asset(identity, str(asset_row["id"]))
                asset_dir = f"assets/{_safe_filename(asset['name'], str(asset['id'])[:8])}-{str(asset['id'])[:8]}"
                with self._connection() as connection:
                    derivatives = connection.execute(
                        "SELECT * FROM creative_derivatives WHERE owner_id=? AND asset_id=? ORDER BY created_at",
                        (owner, asset["id"]),
                    ).fetchall()
                    reviews = connection.execute(
                        "SELECT * FROM creative_quality_reviews WHERE owner_id=? AND asset_id=? ORDER BY created_at",
                        (owner, asset["id"]),
                    ).fetchall()
                    branches = connection.execute(
                        "SELECT * FROM creative_branches WHERE owner_id=? AND asset_id=? ORDER BY created_at",
                        (owner, asset["id"]),
                    ).fetchall()
                asset_manifest = {
                    "id": asset["id"],
                    "name": asset["name"],
                    "metadata": asset.get("metadata") or {},
                    "versions": asset.get("versions") or [],
                    "derivatives": [self._derivative_row(row) for row in derivatives],
                    "quality": [self._quality_row(row) for row in reviews],
                    "branches": [self._branch_row(row) for row in branches],
                    "editable_files": [],
                }
                if asset.get("asset_type") in {"ppt", "psd"}:
                    from services.editable_file_task_service import editable_file_task_service

                    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
                    for label, raw_url in (("primary", metadata.get("primary_url")), ("package", metadata.get("zip_url"))):
                        url_path = unquote(urlsplit(_clean(raw_url, 2_000)).path)
                        marker = "/files/"
                        if marker not in url_path:
                            continue
                        relative_path = url_path.split(marker, 1)[1]
                        try:
                            editable_path = editable_file_task_service.owned_file_path(identity, relative_path)
                            editable_payload = editable_path.read_bytes()
                        except (FileNotFoundError, PermissionError, ValueError, OSError):
                            manifest["missing"].append(
                                {"asset_id": asset["id"], "editable_file": label, "path": relative_path}
                            )
                            continue
                        total_bytes += len(editable_payload)
                        if total_bytes > DELIVERY_MAX_BYTES:
                            raise ValueError("交付包超过 2 GB，请按项目拆分导出")
                        file_name = _safe_filename(editable_path.name, f"{label}-{asset['asset_type']}")
                        archive_path = f"{asset_dir}/editable/{file_name}"
                        output.writestr(archive_path, editable_payload)
                        asset_manifest["editable_files"].append(
                            {"kind": asset["asset_type"], "role": label, "file": archive_path}
                        )
                manifest["assets"].append(asset_manifest)
                for version in asset.get("versions") or []:
                    path = _clean(version.get("image_path"), 500)
                    if not path:
                        continue
                    folder = "originals" if version.get("operation") == "original" else "versions"
                    try:
                        payload = self.storage.get_bytes(path)
                    except Exception:
                        manifest["missing"].append({"asset_id": asset["id"], "version_id": version.get("id"), "path": path})
                        continue
                    total_bytes += len(payload)
                    if total_bytes > DELIVERY_MAX_BYTES:
                        raise ValueError("交付包超过 2 GB，请按项目拆分导出")
                    suffix = Path(path).suffix or ".png"
                    output.writestr(f"{asset_dir}/{folder}/v{version.get('version_number')}{suffix}", payload)
                    if _clean(version.get("id"), 64) == _clean(asset.get("current_version_id"), 64):
                        preview_source = ImageOps.exif_transpose(Image.open(io.BytesIO(payload))).convert("RGB")
                        preview = ImageOps.contain(preview_source, (1280, 1280), method=Image.Resampling.LANCZOS)
                        preview_output = io.BytesIO()
                        preview.save(preview_output, format="JPEG", quality=88, optimize=True)
                        output.writestr(f"{asset_dir}/previews/current.jpg", preview_output.getvalue())
                for derivative in derivatives:
                    path = _clean(derivative["image_path"], 500)
                    try:
                        payload = self.storage.get_bytes(path)
                    except Exception:
                        manifest["missing"].append({"asset_id": asset["id"], "derivative_id": derivative["id"], "path": path})
                        continue
                    total_bytes += len(payload)
                    if total_bytes > DELIVERY_MAX_BYTES:
                        raise ValueError("交付包超过 2 GB，请按项目拆分导出")
                    suffix = Path(path).suffix or ".jpg"
                    output.writestr(f"{asset_dir}/derivatives/{derivative['preset']}-{derivative['width']}x{derivative['height']}{suffix}", payload)
                prompts = "\n\n".join(
                    f"版本 {item.get('version_number')}\n{_clean(item.get('prompt'))}"
                    for item in asset.get("versions") or []
                    if _clean(item.get("prompt"))
                )
                output.writestr(f"{asset_dir}/prompts/prompts.txt", prompts.encode("utf-8"))
                output.writestr(
                    f"{asset_dir}/manifest.json",
                    json.dumps(asset_manifest, ensure_ascii=False, indent=2).encode("utf-8"),
                )
            output.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
            output.writestr(
                "README.md",
                "# XG 生图智能交付包\n\n包含作品版本、衍生尺寸、提示词、质量报告与版本分支说明。\n".encode("utf-8"),
            )
        archive.seek(0)
        scope = normalized_project or normalized_asset
        return archive, f"xg-delivery-{scope[:12]}.zip"

    def health(self) -> dict[str, object]:
        with self._connection() as connection:
            counts = {
                "embeddings": int(connection.execute("SELECT COUNT(*) FROM creative_asset_embeddings WHERE status='ready'").fetchone()[0]),
                "quality_reviews": int(connection.execute("SELECT COUNT(*) FROM creative_quality_reviews WHERE status='ready'").fetchone()[0]),
                "derivatives": int(connection.execute("SELECT COUNT(*) FROM creative_derivatives").fetchone()[0]),
                "branches": int(connection.execute("SELECT COUNT(*) FROM creative_branches").fetchone()[0]),
                "boards": int(connection.execute("SELECT COUNT(*) FROM creative_boards").fetchone()[0]),
                "notifications": int(connection.execute("SELECT COUNT(*) FROM creative_notifications").fetchone()[0]),
                "budgets": int(connection.execute("SELECT COUNT(*) FROM creative_project_budgets").fetchone()[0]),
            }
        return {
            "ok": True,
            "image_model": IMAGE_EMBEDDING_MODEL,
            "text_model": TEXT_EMBEDDING_MODEL,
            "model_cache": str(self.model_cache),
            "models_loaded": {"image": self._image_model is not None, "text": self._text_model is not None},
            **counts,
        }


creative_intelligence_service = CreativeIntelligenceService()
