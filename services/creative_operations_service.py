from __future__ import annotations

import hashlib
import itertools
import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from services.config import DATA_DIR


_TEMPLATE_VARIABLE = re.compile(r"{{\s*([^\W\d][\w.-]{0,31})\s*}}", re.UNICODE)
_MAX_TEMPLATE_RESULTS = 50
module_logger = logging.getLogger(__name__)


def _clean(value: object, limit: int = 4_000) -> str:
    return str(value or "").strip()[:limit]


def _owner(identity: dict[str, object]) -> str:
    return _clean(identity.get("id"), 128) or "anonymous"


def _is_admin(identity: dict[str, object]) -> bool:
    return _clean(identity.get("role"), 32).lower() in {"admin", "administrator"}


def _now() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_time(value: object) -> datetime:
    text = _clean(value, 80)
    if not text:
        raise ValueError("执行时间不能为空")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("执行时间格式无效") from exc
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone(UTC)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_load(value: object, default: Any) -> Any:
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed


class CreativeOperationsService:
    """Durable orchestration for reliability, collaboration and delivery operations."""

    def __init__(self, path: Path = DATA_DIR / "creative_operations.db") -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._worker_lock = threading.RLock()
        self._worker_stop = threading.Event()
        self._worker: threading.Thread | None = None
        self._dispatcher: Callable[[dict[str, object]], list[str]] | None = None
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS prompt_templates (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    template TEXT NOT NULL,
                    variables TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_prompt_templates_owner
                    ON prompt_templates(owner_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS scheduled_generations (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    owner_role TEXT NOT NULL,
                    owner_name TEXT NOT NULL DEFAULT '',
                    owner_group TEXT NOT NULL DEFAULT 'default',
                    prompts TEXT NOT NULL,
                    model TEXT NOT NULL,
                    size TEXT NOT NULL DEFAULT '',
                    quality TEXT NOT NULL DEFAULT 'auto',
                    project_id TEXT NOT NULL DEFAULT '',
                    run_at TEXT NOT NULL,
                    low_peak_only INTEGER NOT NULL DEFAULT 0,
                    window_start INTEGER NOT NULL DEFAULT 0,
                    window_end INTEGER NOT NULL DEFAULT 7,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    result_task_ids TEXT NOT NULL DEFAULT '[]',
                    error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_scheduled_generations_due
                    ON scheduled_generations(status, run_at, updated_at);
                CREATE INDEX IF NOT EXISTS idx_scheduled_generations_owner
                    ON scheduled_generations(owner_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS review_comments (
                    id TEXT PRIMARY KEY,
                    review_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    actor_name TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_review_comments_review
                    ON review_comments(owner_id, review_id, created_at);

                CREATE TABLE IF NOT EXISTS review_annotations (
                    id TEXT PRIMARY KEY,
                    review_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    label TEXT NOT NULL,
                    x REAL NOT NULL,
                    y REAL NOT NULL,
                    width REAL NOT NULL,
                    height REAL NOT NULL,
                    body TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_review_annotations_review
                    ON review_annotations(owner_id, review_id, created_at);

                CREATE TABLE IF NOT EXISTS review_confirmations (
                    review_id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    decision TEXT NOT NULL,
                    comment TEXT NOT NULL DEFAULT '',
                    confirmed_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS asset_provenance (
                    version_id TEXT PRIMARY KEY,
                    asset_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    model TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    prompt_sha256 TEXT NOT NULL,
                    reference_files TEXT NOT NULL DEFAULT '[]',
                    operation TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_asset_provenance_asset
                    ON asset_provenance(owner_id, asset_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS disaster_restore_runs (
                    id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL,
                    backup_key TEXT NOT NULL,
                    status TEXT NOT NULL,
                    restore_token_hash TEXT NOT NULL DEFAULT '',
                    token_expires_at TEXT NOT NULL DEFAULT '',
                    detail TEXT NOT NULL DEFAULT '{}',
                    rollback_path TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_disaster_restore_runs_created
                    ON disaster_restore_runs(created_at DESC);
                """
            )

    @staticmethod
    def render_template(template: str, variables: dict[str, object]) -> dict[str, object]:
        source = _clean(template, 12_000)
        if not source:
            raise ValueError("提示词模板不能为空")
        names = list(dict.fromkeys(_TEMPLATE_VARIABLE.findall(source)))
        if not names:
            return {"variables": [], "items": [source], "total": 1}
        normalized: dict[str, list[str]] = {}
        for name in names:
            raw = variables.get(name)
            values = raw if isinstance(raw, list) else [raw]
            cleaned = list(dict.fromkeys(_clean(item, 500) for item in values if _clean(item, 500)))
            if not cleaned:
                raise ValueError(f"变量 {name} 缺少可用值")
            if len(cleaned) > 20:
                raise ValueError(f"变量 {name} 最多 20 个值")
            normalized[name] = cleaned
        total = 1
        for values in normalized.values():
            total *= len(values)
        if total > _MAX_TEMPLATE_RESULTS:
            raise ValueError(f"变量组合最多生成 {_MAX_TEMPLATE_RESULTS} 条提示词，当前为 {total} 条")
        items: list[str] = []
        for combination in itertools.product(*(normalized[name] for name in names)):
            rendered = source
            for name, value in zip(names, combination, strict=True):
                rendered = re.sub(r"{{\s*" + re.escape(name) + r"\s*}}", value, rendered)
            items.append(rendered)
        return {"variables": names, "items": items, "total": len(items)}

    @staticmethod
    def route_model(
        identity: dict[str, object],
        *,
        mode: str,
        prompt: str,
        reference_count: int = 0,
        has_mask: bool = False,
        quality: str = "auto",
        available_models: Iterable[str] = (),
    ) -> dict[str, object]:
        normalized_mode = "edit" if _clean(mode, 20).lower() in {"edit", "restore", "inpaint", "outpaint"} else "generate"
        candidates = list(dict.fromkeys(_clean(model, 100) for model in available_models if "image" in _clean(model, 100).lower()))
        if not _is_admin(identity):
            candidates = [model for model in candidates if "codex" not in model.lower()]
        if not candidates:
            candidates = ["gpt-image-2"]
        preferred = next((model for model in candidates if model.lower() == "gpt-image-2"), candidates[0])
        reasons: list[str] = []
        if normalized_mode == "edit" or reference_count > 0:
            reasons.append("检测到参考图或编辑任务，优先使用支持视觉输入的 Web 生图模型")
        else:
            reasons.append("当前为文生图任务，优先使用账号池稳定性最高的 Web 生图模型")
        text = _clean(prompt, 8_000).lower()
        if any(keyword in text for keyword in ("文字", "海报", "logo", "排版", "标题", "字体")):
            reasons.append("提示词包含文字或版式要求，将提高文字与构图约束")
        if has_mask:
            reasons.append("检测到蒙版，路由为局部重绘模式")
        if _clean(quality, 20).lower() in {"high", "hd", "pro"}:
            reasons.append("高质量目标会保留较长生成时间预算")
        return {
            "model": preferred,
            "mode": normalized_mode,
            "confidence": 0.94 if preferred.lower() == "gpt-image-2" else 0.78,
            "reasons": reasons,
            "available_models": candidates,
            "policy": "explicit_user_choice_wins",
        }

    def save_template(
        self,
        identity: dict[str, object],
        *,
        name: str,
        template: str,
        variables: dict[str, object],
    ) -> dict[str, object]:
        rendered = self.render_template(template, variables)
        template_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO prompt_templates(id, owner_id, name, template, variables, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (template_id, _owner(identity), _clean(name, 120) or "未命名模板", _clean(template, 12_000), _json(variables), now, now),
            )
        return {"id": template_id, "name": _clean(name, 120) or "未命名模板", "template": _clean(template, 12_000), "variables": variables, "preview_total": rendered["total"], "created_at": now, "updated_at": now}

    def list_templates(self, identity: dict[str, object]) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM prompt_templates WHERE owner_id=? ORDER BY updated_at DESC LIMIT 200",
                (_owner(identity),),
            ).fetchall()
        return [
            {"id": row["id"], "name": row["name"], "template": row["template"], "variables": _json_load(row["variables"], {}), "created_at": row["created_at"], "updated_at": row["updated_at"]}
            for row in rows
        ]

    def delete_template(self, identity: dict[str, object], template_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM prompt_templates WHERE id=? AND owner_id=?",
                (_clean(template_id, 64), _owner(identity)),
            )
        return cursor.rowcount > 0

    def create_schedule(
        self,
        identity: dict[str, object],
        *,
        prompts: list[str],
        model: str,
        size: str,
        quality: str,
        project_id: str,
        run_at: str,
        low_peak_only: bool,
        window_start: int,
        window_end: int,
    ) -> dict[str, object]:
        normalized_prompts = [_clean(item, 12_000) for item in prompts if _clean(item, 12_000)]
        if not normalized_prompts or len(normalized_prompts) > _MAX_TEMPLATE_RESULTS:
            raise ValueError(f"定时任务需包含 1 至 {_MAX_TEMPLATE_RESULTS} 条提示词")
        when = _parse_time(run_at)
        if when < _now():
            raise ValueError("执行时间不能早于当前时间")
        start = max(0, min(23, int(window_start)))
        end = max(0, min(23, int(window_end)))
        schedule_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO scheduled_generations(id, owner_id, owner_role, owner_name, owner_group, prompts, model, size, quality, project_id, run_at, low_peak_only, window_start, window_end, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    schedule_id,
                    _owner(identity),
                    _clean(identity.get("role"), 32) or "user",
                    _clean(identity.get("name"), 120),
                    _clean(identity.get("group"), 40) or "default",
                    _json(normalized_prompts),
                    _clean(model, 100) or "gpt-image-2",
                    _clean(size, 40),
                    _clean(quality, 20) or "auto",
                    _clean(project_id, 64),
                    when.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                    int(bool(low_peak_only)),
                    start,
                    end,
                    now,
                    now,
                ),
            )
        return self.get_schedule(identity, schedule_id)

    @staticmethod
    def _schedule(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"], "owner_id": row["owner_id"], "prompts": _json_load(row["prompts"], []),
            "model": row["model"], "size": row["size"], "quality": row["quality"], "project_id": row["project_id"],
            "run_at": row["run_at"], "low_peak_only": bool(row["low_peak_only"]), "window_start": int(row["window_start"]),
            "window_end": int(row["window_end"]), "status": row["status"], "attempts": int(row["attempts"]),
            "result_task_ids": _json_load(row["result_task_ids"], []), "error": row["error"],
            "created_at": row["created_at"], "updated_at": row["updated_at"],
        }

    def get_schedule(self, identity: dict[str, object], schedule_id: str) -> dict[str, object]:
        clauses = ["id=?"]
        args: list[object] = [_clean(schedule_id, 64)]
        if not _is_admin(identity):
            clauses.append("owner_id=?")
            args.append(_owner(identity))
        with self._connection() as connection:
            row = connection.execute(f"SELECT * FROM scheduled_generations WHERE {' AND '.join(clauses)}", args).fetchone()
        if row is None:
            raise ValueError("定时任务不存在")
        return self._schedule(row)

    def list_schedules(self, identity: dict[str, object], *, limit: int = 50, offset: int = 0) -> dict[str, object]:
        clauses: list[str] = []
        args: list[object] = []
        if not _is_admin(identity):
            clauses.append("owner_id=?")
            args.append(_owner(identity))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        page_limit = max(1, min(int(limit), 200))
        page_offset = max(0, int(offset))
        with self._connection() as connection:
            total = int(connection.execute(f"SELECT COUNT(*) FROM scheduled_generations {where}", args).fetchone()[0])
            rows = connection.execute(
                f"SELECT * FROM scheduled_generations {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                [*args, page_limit, page_offset],
            ).fetchall()
        return {"items": [self._schedule(row) for row in rows], "pagination": {"limit": page_limit, "offset": page_offset, "total": total}}

    def cancel_schedule(self, identity: dict[str, object], schedule_id: str) -> bool:
        clauses = ["id=?", "status NOT IN ('completed','cancelled')"]
        args: list[object] = [_clean(schedule_id, 64)]
        if not _is_admin(identity):
            clauses.append("owner_id=?")
            args.append(_owner(identity))
        with self._connection() as connection:
            cursor = connection.execute(
                f"UPDATE scheduled_generations SET status='cancelled', updated_at=? WHERE {' AND '.join(clauses)}",
                [_now_iso(), *args],
            )
        return cursor.rowcount > 0

    @staticmethod
    def _within_low_peak(row: sqlite3.Row, when: datetime) -> bool:
        if not bool(row["low_peak_only"]):
            return True
        local_hour = when.astimezone().hour
        start, end = int(row["window_start"]), int(row["window_end"])
        if start == end:
            return True
        return start <= local_hour < end if start < end else local_hour >= start or local_hour < end

    def run_due(self, dispatcher: Callable[[dict[str, object]], list[str]], *, now: datetime | None = None) -> dict[str, int]:
        current = (now or _now()).astimezone(UTC)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM scheduled_generations WHERE status IN ('pending','retry') AND run_at<=? ORDER BY run_at LIMIT 20",
                (current.replace(microsecond=0).isoformat().replace("+00:00", "Z"),),
            ).fetchall()
        counts = {"claimed": 0, "completed": 0, "retry": 0}
        for row in rows:
            if not self._within_low_peak(row, current):
                continue
            with self._connection() as connection:
                cursor = connection.execute(
                    "UPDATE scheduled_generations SET status='running', attempts=attempts+1, error='', updated_at=? "
                    "WHERE id=? AND status IN ('pending','retry')",
                    (_now_iso(), row["id"]),
                )
            if cursor.rowcount != 1:
                continue
            counts["claimed"] += 1
            schedule = dict(self._schedule(row))
            schedule["identity"] = {
                "id": row["owner_id"], "role": row["owner_role"], "name": row["owner_name"], "group": row["owner_group"]
            }
            try:
                task_ids = list(dict.fromkeys(_clean(item, 128) for item in dispatcher(schedule) if _clean(item, 128)))
                with self._connection() as connection:
                    connection.execute(
                        "UPDATE scheduled_generations SET status='completed', result_task_ids=?, updated_at=? WHERE id=?",
                        (_json(task_ids), _now_iso(), row["id"]),
                    )
                counts["completed"] += 1
            except Exception as exc:
                next_state = "retry" if int(row["attempts"] or 0) + 1 < 3 else "failed"
                with self._connection() as connection:
                    connection.execute(
                        "UPDATE scheduled_generations SET status=?, error=?, updated_at=? WHERE id=?",
                        (next_state, _clean(exc, 500) or exc.__class__.__name__, _now_iso(), row["id"]),
                    )
                counts["retry"] += int(next_state == "retry")
        return counts

    def start(self, dispatcher: Callable[[dict[str, object]], list[str]], *, poll_secs: float = 15.0) -> None:
        with self._worker_lock:
            self._dispatcher = dispatcher
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker_stop.clear()

            def loop() -> None:
                while not self._worker_stop.is_set():
                    try:
                        if self._dispatcher is not None:
                            self.run_due(self._dispatcher)
                    except Exception:
                        module_logger.exception("scheduled generation scan failed")
                    self._worker_stop.wait(max(1.0, float(poll_secs)))

            self._worker = threading.Thread(target=loop, name="creative-schedule-worker", daemon=True)
            self._worker.start()

    def stop(self) -> None:
        with self._worker_lock:
            self._worker_stop.set()
            worker = self._worker
            self._worker = None
        if worker is not None:
            worker.join(timeout=2.0)

    def add_review_comment(self, identity: dict[str, object], review: dict[str, object], body: str) -> dict[str, object]:
        text = _clean(body, 2_000)
        if not text:
            raise ValueError("评论内容不能为空")
        item_id = uuid.uuid4().hex
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO review_comments(id, review_id, owner_id, actor_id, actor_name, body, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (item_id, _clean(review.get("id"), 64), _clean(review.get("owner_id"), 128) or _owner(identity), _owner(identity), _clean(identity.get("name"), 120) or "用户", text, now),
            )
        return {"id": item_id, "review_id": review.get("id"), "actor_id": _owner(identity), "actor_name": _clean(identity.get("name"), 120) or "用户", "body": text, "created_at": now}

    def list_review_comments(self, review: dict[str, object]) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT id, review_id, actor_id, actor_name, body, created_at FROM review_comments WHERE review_id=? AND owner_id=? ORDER BY created_at",
                (_clean(review.get("id"), 64), _clean(review.get("owner_id"), 128)),
            ).fetchall()
        return [dict(row) for row in rows]

    def add_review_annotation(
        self,
        identity: dict[str, object],
        review: dict[str, object],
        *,
        label: str,
        x: float,
        y: float,
        width: float,
        height: float,
        body: str,
    ) -> dict[str, object]:
        values = [float(x), float(y), float(width), float(height)]
        if any(value < 0 or value > 1 for value in values) or values[2] <= 0 or values[3] <= 0 or values[0] + values[2] > 1.001 or values[1] + values[3] > 1.001:
            raise ValueError("标注坐标必须位于图片范围内")
        item_id, now = uuid.uuid4().hex, _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO review_annotations(id, review_id, owner_id, actor_id, label, x, y, width, height, body, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (item_id, _clean(review.get("id"), 64), _clean(review.get("owner_id"), 128) or _owner(identity), _owner(identity), _clean(label, 120) or "修改区域", *values, _clean(body, 1_000), now),
            )
        return {"id": item_id, "review_id": review.get("id"), "label": _clean(label, 120) or "修改区域", "x": values[0], "y": values[1], "width": values[2], "height": values[3], "body": _clean(body, 1_000), "created_at": now}

    def list_review_annotations(self, review: dict[str, object]) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT id, review_id, actor_id, label, x, y, width, height, body, created_at FROM review_annotations WHERE review_id=? AND owner_id=? ORDER BY created_at",
                (_clean(review.get("id"), 64), _clean(review.get("owner_id"), 128)),
            ).fetchall()
        return [dict(row) for row in rows]

    def confirm_review(self, identity: dict[str, object], review: dict[str, object], decision: str, comment: str = "") -> dict[str, object]:
        normalized = _clean(decision, 32).lower()
        if normalized not in {"approved", "changes_requested"}:
            raise ValueError("确认结果必须为 approved 或 changes_requested")
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO review_confirmations(review_id, owner_id, actor_id, decision, comment, confirmed_at) VALUES(?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(review_id) DO UPDATE SET actor_id=excluded.actor_id, decision=excluded.decision, comment=excluded.comment, confirmed_at=excluded.confirmed_at",
                (_clean(review.get("id"), 64), _clean(review.get("owner_id"), 128) or _owner(identity), _owner(identity), normalized, _clean(comment, 1_000), now),
            )
        return {"review_id": review.get("id"), "decision": normalized, "comment": _clean(comment, 1_000), "confirmed_at": now}

    def record_task_provenance(self, task: dict[str, Any], versions: list[dict[str, object]]) -> None:
        workflow = task.get("workflow") if isinstance(task.get("workflow"), dict) else {}
        references = workflow.get("source_paths") if isinstance(workflow.get("source_paths"), list) else []
        references = [*references, *(workflow.get("profile_reference_paths") if isinstance(workflow.get("profile_reference_paths"), list) else [])]
        reference_files = [
            {"name": Path(_clean(path, 500)).name, "sha256": hashlib.sha256(_clean(path, 500).encode("utf-8")).hexdigest()}
            for path in dict.fromkeys(_clean(path, 500) for path in references if _clean(path, 500))
        ]
        prompt = _clean(task.get("prompt"), 12_000)
        for version in versions:
            version_id = _clean(version.get("id"), 64)
            asset_id = _clean(version.get("asset_id"), 64)
            if not version_id or not asset_id:
                continue
            with self._connection() as connection:
                connection.execute(
                    "INSERT INTO asset_provenance(version_id, asset_id, owner_id, task_id, model, prompt, prompt_sha256, reference_files, operation, created_by, created_at, metadata) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(version_id) DO NOTHING",
                    (
                        version_id, asset_id, _clean(task.get("owner_id"), 128), _clean(task.get("id"), 128), _clean(task.get("model"), 100), prompt,
                        hashlib.sha256(prompt.encode("utf-8")).hexdigest(), _json(reference_files), _clean(workflow.get("operation_type"), 64) or _clean(task.get("mode"), 32),
                        _clean(task.get("owner_name"), 120) or _clean(task.get("owner_id"), 128), _clean(task.get("created_at"), 80) or _now_iso(),
                        _json({"size": task.get("size"), "quality": task.get("quality"), "project_id": workflow.get("project_id")}),
                    ),
                )

    def list_provenance(self, identity: dict[str, object], asset_id: str) -> list[dict[str, object]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM asset_provenance WHERE asset_id=? AND owner_id=? ORDER BY created_at DESC",
                (_clean(asset_id, 64), _owner(identity)),
            ).fetchall()
        return [
            {"version_id": row["version_id"], "asset_id": row["asset_id"], "task_id": row["task_id"], "model": row["model"], "prompt": row["prompt"], "prompt_sha256": row["prompt_sha256"], "reference_files": _json_load(row["reference_files"], []), "operation": row["operation"], "created_by": row["created_by"], "created_at": row["created_at"], "metadata": _json_load(row["metadata"], {})}
            for row in rows
        ]

    @staticmethod
    def usability_metrics(quality_items: list[dict[str, object]], consumed_credits: int) -> dict[str, object]:
        ready = [item for item in quality_items if isinstance(item.get("quality"), dict) and item["quality"].get("status") == "ready"]
        usable = [item for item in ready if int((item["quality"].get("scores") or {}).get("overall") or 0) >= 70]
        issues: dict[str, int] = {}
        for item in ready:
            for issue in item["quality"].get("issues") or []:
                text = _clean(issue, 160)
                if text:
                    issues[text] = issues.get(text, 0) + 1
        return {
            "reviewed": len(ready),
            "usable": len(usable),
            "usable_rate": round(len(usable) / len(ready) * 100, 1) if ready else 0.0,
            "consumed_credits": max(0, int(consumed_credits)),
            "credits_per_usable": round(max(0, int(consumed_credits)) / len(usable), 2) if usable else None,
            "top_issues": [{"label": key, "count": count} for key, count in sorted(issues.items(), key=lambda pair: (-pair[1], pair[0]))[:10]],
        }

    def create_restore_verification(self, actor_id: str, backup_key: str, detail: dict[str, object]) -> tuple[dict[str, object], str]:
        run_id, token = uuid.uuid4().hex, uuid.uuid4().hex
        expires = datetime.fromtimestamp(time.time() + 600, UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        now = _now_iso()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO disaster_restore_runs(id, actor_id, backup_key, status, restore_token_hash, token_expires_at, detail, created_at, updated_at) VALUES(?, ?, ?, 'verified', ?, ?, ?, ?, ?)",
                (run_id, _clean(actor_id, 128), _clean(backup_key, 500), hashlib.sha256(token.encode("ascii")).hexdigest(), expires, _json(detail), now, now),
            )
        return {"id": run_id, "backup_key": _clean(backup_key, 500), "status": "verified", "token_expires_at": expires, "detail": detail, "created_at": now}, token

    def validate_restore_token(self, actor_id: str, run_id: str, token: str) -> dict[str, object]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM disaster_restore_runs WHERE id=? AND actor_id=? AND status='verified'",
                (_clean(run_id, 64), _clean(actor_id, 128)),
            ).fetchone()
        if row is None or _parse_time(row["token_expires_at"]) < _now():
            raise ValueError("恢复校验已失效，请重新预演")
        if hashlib.sha256(_clean(token, 128).encode("ascii", errors="ignore")).hexdigest() != row["restore_token_hash"]:
            raise ValueError("恢复校验令牌无效")
        return dict(row)

    def finish_restore(self, run_id: str, *, status: str, rollback_path: str = "", detail: dict[str, object] | None = None) -> None:
        with self._connection() as connection:
            connection.execute(
                "UPDATE disaster_restore_runs SET status=?, rollback_path=?, detail=?, restore_token_hash='', updated_at=? WHERE id=?",
                (_clean(status, 32), _clean(rollback_path, 1_000), _json(detail or {}), _now_iso(), _clean(run_id, 64)),
            )

    def health(self) -> dict[str, object]:
        with self._connection() as connection:
            quick_check = str(connection.execute("PRAGMA quick_check").fetchone()[0]).lower()
            schedules = int(connection.execute("SELECT COUNT(*) FROM scheduled_generations WHERE status IN ('pending','retry','running')").fetchone()[0])
        return {"healthy": quick_check == "ok", "quick_check": quick_check, "pending_schedules": schedules, "worker_running": bool(self._worker and self._worker.is_alive())}


creative_operations_service = CreativeOperationsService()
