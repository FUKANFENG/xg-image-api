from __future__ import annotations

import json
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable


class ImageTaskStore:
    """Durable image-task storage with row-level writes and WAL concurrency."""

    _SCHEMA_VERSION = "1"

    def __init__(self, db_path: Path, *, legacy_json_path: Path | None = None):
        self.db_path = db_path
        self.legacy_json_path = legacy_json_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self._import_legacy_json_once()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0)
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

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS image_tasks (
                    task_key TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    created_ts REAL NOT NULL DEFAULT 0,
                    updated_ts REAL NOT NULL DEFAULT 0,
                    payload TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_image_tasks_owner_updated "
                "ON image_tasks(owner_id, updated_ts DESC)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_image_tasks_status_updated "
                "ON image_tasks(status, updated_ts DESC)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS image_task_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            connection.execute(
                "INSERT OR REPLACE INTO image_task_metadata(key, value) VALUES('schema_version', ?)",
                (self._SCHEMA_VERSION,),
            )

    @staticmethod
    def _task_row(task: dict[str, Any]) -> tuple[object, ...] | None:
        owner_id = str(task.get("owner_id") or "").strip()
        task_id = str(task.get("id") or "").strip()
        if not owner_id or not task_id:
            return None
        created_ts = task.get("created_ts")
        updated_ts = task.get("updated_ts")
        return (
            f"{owner_id}:{task_id}",
            owner_id,
            task_id,
            str(task.get("status") or "error"),
            "edit" if task.get("mode") == "edit" else "generate",
            float(created_ts) if isinstance(created_ts, (int, float)) else 0.0,
            float(updated_ts) if isinstance(updated_ts, (int, float)) else 0.0,
            json.dumps(task, ensure_ascii=False, separators=(",", ":")),
        )

    @staticmethod
    def _upsert_sql() -> str:
        return """
            INSERT INTO image_tasks(
                task_key, owner_id, task_id, status, mode, created_ts, updated_ts, payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_key) DO UPDATE SET
                owner_id=excluded.owner_id,
                task_id=excluded.task_id,
                status=excluded.status,
                mode=excluded.mode,
                created_ts=excluded.created_ts,
                updated_ts=excluded.updated_ts,
                payload=excluded.payload
        """

    def _import_legacy_json_once(self) -> None:
        with self._connection() as connection:
            imported = connection.execute(
                "SELECT value FROM image_task_metadata WHERE key='legacy_json_imported'"
            ).fetchone()
            existing = int(connection.execute("SELECT COUNT(*) FROM image_tasks").fetchone()[0])
        if imported is not None or existing or self.legacy_json_path is None or not self.legacy_json_path.exists():
            return
        try:
            raw = json.loads(self.legacy_json_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"无法读取有效的图片任务存储：{self.legacy_json_path}") from exc
        items = raw.get("tasks") if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            raise RuntimeError(f"图片任务存储结构无效：{self.legacy_json_path}")
        rows = [row for item in items if isinstance(item, dict) and (row := self._task_row(item)) is not None]
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if rows:
                connection.executemany(self._upsert_sql(), rows)
            connection.execute(
                "INSERT OR REPLACE INTO image_task_metadata(key, value) VALUES('legacy_json_imported', '1')"
            )
            connection.commit()

    def load_all(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT payload FROM image_tasks ORDER BY updated_ts DESC, task_key"
            ).fetchall()
        tasks: list[dict[str, Any]] = []
        for row in rows:
            try:
                value = json.loads(row["payload"])
            except (TypeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"图片任务数据库存在无效记录：{self.db_path}") from exc
            if isinstance(value, dict):
                tasks.append(value)
        return tasks

    def upsert(self, task: dict[str, Any]) -> None:
        row = self._task_row(task)
        if row is None:
            raise ValueError("image task requires owner_id and id")
        with self._connection() as connection:
            connection.execute(self._upsert_sql(), row)

    def upsert_many(self, tasks: Iterable[dict[str, Any]]) -> None:
        rows = [row for task in tasks if (row := self._task_row(task)) is not None]
        if not rows:
            return
        with self._connection() as connection:
            connection.executemany(self._upsert_sql(), rows)

    def replace_all(self, tasks: Iterable[dict[str, Any]]) -> None:
        rows = [row for task in tasks if (row := self._task_row(task)) is not None]
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM image_tasks")
            if rows:
                connection.executemany(self._upsert_sql(), rows)
            connection.commit()

    def delete(self, task_key: str) -> None:
        with self._connection() as connection:
            connection.execute("DELETE FROM image_tasks WHERE task_key = ?", (task_key,))

    def delete_many(self, task_keys: Iterable[str]) -> None:
        keys = [(str(key),) for key in task_keys if str(key)]
        if not keys:
            return
        with self._connection() as connection:
            connection.executemany("DELETE FROM image_tasks WHERE task_key = ?", keys)

    def health(self) -> dict[str, object]:
        with self._connection() as connection:
            journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            quick_check = str(connection.execute("PRAGMA quick_check").fetchone()[0]).lower()
            task_count = int(connection.execute("SELECT COUNT(*) FROM image_tasks").fetchone()[0])
        return {
            "healthy": quick_check == "ok" and journal_mode == "wal",
            "journal_mode": journal_mode,
            "quick_check": quick_check,
            "task_count": task_count,
            "path": str(self.db_path),
        }

    def snapshot_bytes(self) -> bytes:
        """Create a transactionally consistent single-file SQLite backup."""
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot_path = Path(temp_dir) / "image_tasks.db"
            with self._connection() as source:
                target = sqlite3.connect(snapshot_path)
                try:
                    source.backup(target)
                finally:
                    target.close()
            return snapshot_path.read_bytes()
