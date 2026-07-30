from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from services.account_service import account_service
from services.auth_service import auth_service
from services.config import DATA_DIR, config
from services.content_filter import request_text
from services.creative_intelligence_service import creative_intelligence_service
from services.creative_operations_service import creative_operations_service
from services.image_storage_service import image_storage_service
from services.image_task_store import ImageTaskStore
from services.log_service import LOG_TYPE_CALL, log_service
from services.protocol import openai_v1_image_edit, openai_v1_image_generations
from services.protocol.conversation import public_image_error_message

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_PAUSED = "paused"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_PAUSED, TASK_STATUS_RUNNING}
NON_RETRYABLE_ERROR_CODES = {"content_policy_violation"}
RECOVERABLE_POLL_ERROR_CODES = {
    "image_timeout",
    "service_restarted",
    "upstream_connection_error",
    "no_image_result",
    "upstream_error",
}
_PROGRESS_STAGES = {
    "getting_account": "account_selection",
    "starting_generation": "upstream_generation",
    "image_stream_resolve_start": "upstream_submitted",
    "receiving_image": "result_download",
    "resume_poll": "resume_polling",
    "paused": "paused",
}
module_logger = logging.getLogger(__name__)


class ImageQueueFullError(ValueError):
    """The bounded global image queue cannot accept more work."""


@dataclass(slots=True)
class _QueuedImageWork:
    key: str
    owner_id: str
    task_id: str
    attempt: threading.Event
    runner: Callable[..., None]
    args: tuple[Any, ...]
    identity: dict[str, object]
    credit_reserved: bool
    priority: int = 0
    start_failure_restore: dict[str, Any] | None = None


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:26], fmt).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _priority(value: object) -> int:
    try:
        return max(-10, min(10, int(value or 0)))
    except (TypeError, ValueError):
        return 0


def _nonnegative_int(value: object, *, maximum: int = 100_000) -> int:
    try:
        return min(maximum, max(0, int(value or 0)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _classify_image_error(error: BaseException | None, message: str) -> str:
    explicit = _clean(getattr(error, "code", "")) if error is not None else ""
    if explicit:
        return explicit
    text = _clean(message).lower()
    if "cancel" in text or "手动停止" in text:
        return "cancelled_by_user"
    if "服务已重启" in text:
        return "service_restarted"
    if "content_policy" in text or "safety policy" in text or "安全策略" in text:
        return "content_policy_violation"
    if "precheck" in text or "account check" in text or "账号预检" in text:
        return "account_precheck_failed"
    if "no available" in text or "quota" in text or "没有可用账号" in text or "额度不足" in text:
        return "account_pool_exhausted"
    if "no image result" in text or "without generating images" in text or "未生成图片" in text:
        return "no_image_result"
    if "tiktoken" in text or "token encoding" in text:
        return "tokenization_error"
    if "timeout" in text or "timed out" in text or "超时" in text:
        return "image_timeout"
    if "tls" in text or "ssl" in text or "connection" in text or "连接" in text:
        return "upstream_connection_error"
    return "upstream_error"


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _collect_image_urls(data: list[Any]) -> list[str]:
    urls: list[str] = []
    for item in data:
        if isinstance(item, dict):
            url = item.get("url")
            if isinstance(url, str) and url:
                urls.append(url)
    return urls


def _portable_image_url(value: object) -> str:
    """Return local image endpoints without the host that created the task."""
    source = _clean(value)
    if not source:
        return ""
    try:
        parsed = urlsplit(source)
    except ValueError:
        return source
    if parsed.scheme in {"http", "https"} and parsed.path.startswith("/images/"):
        return parsed.path + (f"?{parsed.query}" if parsed.query else "")
    return source


def _public_image_data(value: object) -> object:
    if not isinstance(value, list):
        return value
    public_items: list[Any] = []
    for item in value:
        if not isinstance(item, dict):
            public_items.append(item)
            continue
        public_item = dict(item)
        if public_item.get("url"):
            public_item["url"] = _portable_image_url(public_item.get("url"))
        public_items.append(public_item)
    return public_items


def _stored_image_path(value: object) -> str:
    source = _clean(value)
    if not source:
        return ""
    try:
        path = urlsplit(source).path
    except ValueError:
        return ""
    marker = "/images/"
    if marker not in path:
        return ""
    return unquote(path.split(marker, 1)[1]).lstrip("/")


def _tracked_image_data(value: object) -> list[dict[str, object]]:
    """Keep task-safe result metadata without persisting large base64 payloads."""
    if not isinstance(value, list):
        return []
    tracked: list[dict[str, object]] = []
    relative_paths: list[str] = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        url = _clean(raw.get("url"))
        path = _stored_image_path(url)
        item: dict[str, object] = {}
        if url:
            item["url"] = _portable_image_url(url)
        if path:
            item["path"] = path
            relative_paths.append(path)
        revised_prompt = _clean(raw.get("revised_prompt"))
        if revised_prompt:
            item["revised_prompt"] = revised_prompt
        for key in ("width", "height", "size_bytes"):
            numeric = _nonnegative_int(raw.get(key))
            if numeric:
                item[key] = numeric
        storage = _clean(raw.get("storage"))
        if storage:
            item["storage"] = storage
        if item:
            tracked.append(item)
    if not relative_paths:
        return tracked
    try:
        metadata = {
            _clean(item.get("path")): item
            for item in image_storage_service.inspect_paths(relative_paths)
            if isinstance(item, dict) and _clean(item.get("path"))
        }
    except Exception:
        module_logger.exception("failed to resolve image metadata for task result")
        return tracked
    for item in tracked:
        record = metadata.get(_clean(item.get("path")), {})
        for source_key, target_key in (
            ("size_bytes", "size_bytes"),
            ("width", "width"),
            ("height", "height"),
            ("storage", "storage"),
        ):
            value = record.get(source_key)
            if value not in (None, "", 0):
                item[target_key] = value
    return tracked


def _task_created_timestamp(task: dict[str, Any]) -> float:
    created_ts = task.get("created_ts")
    if isinstance(created_ts, (int, float)) and not isinstance(created_ts, bool):
        return float(created_ts)
    return _timestamp(task.get("created_at"))


def _timeline_stage(task: dict[str, Any]) -> str:
    checkpoint = _clean(task.get("last_checkpoint"))
    progress = _clean(task.get("progress"))
    status = _clean(task.get("status"))
    if checkpoint in {"completed", "failed", "recoverable_error", "resume_failed"}:
        return "completed" if checkpoint == "completed" else "failed"
    if checkpoint.startswith("auto_resume") or checkpoint.startswith("resume_"):
        return "resume_polling" if "poll" in checkpoint else "recovery_queued"
    if progress in _PROGRESS_STAGES:
        return _PROGRESS_STAGES[progress]
    if checkpoint == "upstream_running":
        return "upstream_generation"
    if checkpoint == "recovered_queued":
        return "recovery_queued"
    return {
        TASK_STATUS_QUEUED: "queued",
        TASK_STATUS_PAUSED: "paused",
        TASK_STATUS_RUNNING: "running",
        TASK_STATUS_SUCCESS: "completed",
        TASK_STATUS_ERROR: "failed",
    }.get(status, status or "unknown")


def _public_timeline(task: dict[str, Any]) -> list[dict[str, Any]]:
    source = task.get("timeline") if isinstance(task.get("timeline"), list) else []
    entries: list[dict[str, Any]] = []
    for raw in source[-100:]:
        if not isinstance(raw, dict):
            continue
        created_ts = raw.get("created_ts")
        entries.append(
            {
                "stage": _clean(raw.get("stage"), "unknown"),
                "status": _clean(raw.get("status")),
                "created_at": _clean(raw.get("created_at")),
                "created_ts": float(created_ts) if isinstance(created_ts, (int, float)) else 0.0,
                **({"detail": _clean(raw.get("detail"), "")[:300]} if _clean(raw.get("detail")) else {}),
            }
        )
    for index, entry in enumerate(entries):
        next_ts = entries[index + 1]["created_ts"] if index + 1 < len(entries) else 0.0
        if next_ts and entry["created_ts"]:
            entry["duration_ms"] = max(0, int((next_ts - entry["created_ts"]) * 1_000))
        elif index == len(entries) - 1 and task.get("status") in TERMINAL_STATUSES and task.get("duration_ms") is not None:
            entry["duration_ms"] = 0
    return entries


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "model": task.get("model"),
        "size": task.get("size"),
        "quality": task.get("quality"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
        "source": _clean(task.get("source"), "queue"),
        "endpoint": _clean(
            task.get("endpoint"),
            "/api/image-tasks/edits" if task.get("mode") == "edit" else "/api/image-tasks/generations",
        ),
    }
    if task.get("request_n") is not None:
        item["request_n"] = _nonnegative_int(task.get("request_n"), maximum=4) or 1
    if task.get("response_format"):
        item["response_format"] = _clean(task.get("response_format"))
    if task.get("caller_key_id"):
        item["caller_key_id"] = _clean(task.get("caller_key_id"))
    if task.get("caller_key_name"):
        item["caller_key_name"] = _clean(task.get("caller_key_name"))
    if task.get("conversation_id"):
        item["conversation_id"] = task.get("conversation_id")
    if isinstance(task.get("workflow"), dict):
        item["workflow"] = dict(task["workflow"])
    if task.get("data") is not None:
        item["data"] = _public_image_data(task.get("data"))
        item["result_count"] = (
            _nonnegative_int(task.get("result_count"), maximum=100)
            if task.get("result_count") is not None
            else len(task.get("data"))
            if isinstance(task.get("data"), list)
            else 0
        )
    if task.get("usage") is not None:
        item["usage"] = task.get("usage")
    if task.get("error"):
        item["error"] = public_image_error_message(_clean(task.get("error")))
    error_code = _clean(task.get("error_code"))
    if error_code:
        item["error_code"] = error_code
    if task.get("progress"):
        item["progress"] = task.get("progress")
    if task.get("duration_ms") is not None:
        item["duration_ms"] = task.get("duration_ms")
    if task.get("resume_count") is not None:
        item["resume_count"] = int(task.get("resume_count") or 0)
    if task.get("last_checkpoint"):
        item["last_checkpoint"] = _clean(task.get("last_checkpoint"))
    timeline = _public_timeline(task)
    if timeline:
        item["timeline"] = timeline
        item["current_stage"] = timeline[-1]["stage"]
    item["priority"] = int(task.get("priority") or 0)
    prompt = _clean(task.get("prompt"))
    if prompt:
        item["prompt"] = prompt
    if task.get("status") == TASK_STATUS_ERROR:
        workflow = task.get("workflow") if isinstance(task.get("workflow"), dict) else {}
        has_retry_source = task.get("mode") == "edit" and bool(_clean(workflow.get("source_path")))
        can_resume_poll = (
            error_code in RECOVERABLE_POLL_ERROR_CODES
            and bool(_clean(task.get("conversation_id")))
            and bool(_clean(task.get("account_ref")))
        )
        item["retryable"] = (
            (can_resume_poll or bool(_clean(task.get("retry_prompt"))) or has_retry_source)
            and error_code not in NON_RETRYABLE_ERROR_CODES
        )
        item["recovery_mode"] = "resume_poll" if can_resume_poll else "retry"
    if task.get("status") in (TASK_STATUS_RUNNING, TASK_STATUS_QUEUED, TASK_STATUS_PAUSED):
        # Keep one monotonic elapsed clock from submission to completion so a task
        # never appears to jump backwards when it changes from queued to running.
        base_ts = _task_created_timestamp(task)
        if base_ts:
            item["elapsed_secs"] = round(max(0.0, time.time() - base_ts), 1)
        else:
            item["elapsed_secs"] = 0.0
    return item


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_generations.handle,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_edit.handle,
        retention_days_getter: Callable[[], int] | None = None,
        credit_manager: Any | None = None,
        global_concurrency_getter: Callable[[], int] | None = None,
        user_concurrency_getter: Callable[[], int] | None = None,
        queue_capacity_getter: Callable[[], int] | None = None,
        creative_intelligence_manager: Any | None = None,
        creative_operations_manager: Any | None = None,
        account_capacity_getter: Callable[[], int | dict[str, object]] | None = None,
    ):
        self.path = path
        db_path = path if path.suffix.lower() in {".db", ".sqlite", ".sqlite3"} else path.with_suffix(".db")
        legacy_path = path if path.suffix.lower() == ".json" else None
        self.store = ImageTaskStore(db_path, legacy_json_path=legacy_path)
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self.credit_manager = credit_manager or auth_service
        self.global_concurrency_getter = global_concurrency_getter or (lambda: config.image_global_concurrency)
        self.user_concurrency_getter = user_concurrency_getter or (lambda: config.image_user_concurrency)
        self.queue_capacity_getter = queue_capacity_getter or (lambda: config.image_queue_capacity)
        self.account_capacity_getter = account_capacity_getter
        self.creative_intelligence_manager = creative_intelligence_manager
        self.creative_operations_manager = creative_operations_manager
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self._active_attempts: dict[str, threading.Event] = {}
        self._project_budget_settlements: set[str] = set()
        self._pending_by_owner: dict[str, deque[_QueuedImageWork]] = {}
        self._paused_work: dict[str, _QueuedImageWork] = {}
        self._owner_cycle: deque[str] = deque()
        self._last_dispatched_owner = ""
        self._running_by_owner: dict[str, int] = defaultdict(int)
        self._running_keys: set[str] = set()
        self._running_total = 0
        self._queue_rejected_total = 0
        self._recent_durations_secs: deque[float] = deque(maxlen=100)
        self._storage_health_cache: dict[str, object] = {}
        self._storage_health_checked_at = 0.0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            for task in self._tasks.values():
                duration_ms = task.get("duration_ms")
                if task.get("status") == TASK_STATUS_SUCCESS and isinstance(duration_ms, (int, float)):
                    self._recent_durations_secs.append(max(0.1, float(duration_ms) / 1000.0))
            changed = self._recover_unfinished_locked()
            changed = self._reconcile_terminal_credits_locked() or changed
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()

    def _resolve_task_locked(
        self, identity: dict[str, object], task_id: str
    ) -> tuple[str, dict[str, Any]]:
        """Resolve an owned task, or any task for an administrator."""
        normalized_task_id = _clean(task_id)
        owned_key = _task_key(_owner_id(identity), normalized_task_id)
        owned_task = self._tasks.get(owned_key)
        if owned_task is not None:
            return owned_key, owned_task
        if _clean(identity.get("role")).lower() not in {"admin", "administrator"}:
            raise ValueError("task not found")
        matches = [
            (key, task)
            for key, task in self._tasks.items()
            if _clean(task.get("id")) == normalized_task_id
        ]
        if len(matches) != 1:
            raise ValueError("task not found" if not matches else "task id is ambiguous")
        return matches[0]

    @staticmethod
    def _task_identity(task: dict[str, Any]) -> dict[str, object]:
        return {
            "id": _clean(task.get("owner_id")),
            "role": _clean(task.get("owner_role"), "user"),
            "name": _clean(task.get("owner_name")),
            "group": _clean(task.get("owner_group"), "default"),
        }

    def _queue_limits(self) -> tuple[int, int, int]:
        try:
            global_limit = max(1, min(12, int(self.global_concurrency_getter())))
        except Exception:
            global_limit = 8
        try:
            user_limit = max(1, min(global_limit, int(self.user_concurrency_getter())))
        except Exception:
            user_limit = min(2, global_limit)
        try:
            queue_capacity = max(1, min(10_000, int(self.queue_capacity_getter())))
        except Exception:
            queue_capacity = 100
        return global_limit, user_limit, queue_capacity

    def _account_slot_capacity(self) -> int | None:
        getter = self.account_capacity_getter
        if getter is None:
            return None
        try:
            raw = getter()
            if isinstance(raw, dict):
                raw = raw.get("total_slots")
            return max(0, min(10_000, int(raw)))
        except Exception as exc:
            module_logger.warning("failed to read image account capacity: %s", type(exc).__name__)
            return None

    def _dispatch_limits(self) -> tuple[int, int, int, int | None, int]:
        global_limit, user_limit, queue_capacity = self._queue_limits()
        account_capacity = self._account_slot_capacity()
        effective_global_limit = global_limit
        if account_capacity is not None:
            effective_global_limit = max(1, min(global_limit, account_capacity))
        return global_limit, user_limit, queue_capacity, account_capacity, effective_global_limit

    def _pending_count_locked(self) -> int:
        return sum(len(items) for items in self._pending_by_owner.values())

    def _enqueue_work_locked(self, work: _QueuedImageWork) -> None:
        queue = self._pending_by_owner.get(work.owner_id)
        if queue is None:
            queue = deque()
            self._pending_by_owner[work.owner_id] = queue
            self._owner_cycle.append(work.owner_id)
        insert_at = len(queue)
        for index, queued in enumerate(queue):
            if work.priority > queued.priority:
                insert_at = index
                break
        queue.insert(insert_at, work)

    def _take_pending_work_locked(self, key: str) -> _QueuedImageWork | None:
        found: _QueuedImageWork | None = None
        empty_owners: list[str] = []
        for owner_id, queue in self._pending_by_owner.items():
            retained: deque[_QueuedImageWork] = deque()
            for work in queue:
                if found is None and work.key == key:
                    found = work
                else:
                    retained.append(work)
            if retained:
                self._pending_by_owner[owner_id] = retained
            else:
                empty_owners.append(owner_id)
        for owner_id in empty_owners:
            self._pending_by_owner.pop(owner_id, None)
        if empty_owners:
            removed = set(empty_owners)
            self._owner_cycle = deque(owner for owner in self._owner_cycle if owner not in removed)
        return found

    def _remove_pending_work_locked(self, key: str) -> bool:
        return self._take_pending_work_locked(key) is not None

    def _next_owner_work_locked(self, owner_limit: int | None) -> _QueuedImageWork | None:
        if self._last_dispatched_owner and self._last_dispatched_owner in self._owner_cycle:
            owner_index = list(self._owner_cycle).index(self._last_dispatched_owner)
            self._owner_cycle.rotate(-(owner_index + 1))
        for _ in range(len(self._owner_cycle)):
            owner_id = self._owner_cycle.popleft()
            queue = self._pending_by_owner.get(owner_id)
            if not queue:
                self._pending_by_owner.pop(owner_id, None)
                continue
            if owner_limit is not None and self._running_by_owner.get(owner_id, 0) >= owner_limit:
                self._owner_cycle.append(owner_id)
                continue
            work = queue.popleft()
            if queue:
                self._owner_cycle.append(owner_id)
            else:
                self._pending_by_owner.pop(owner_id, None)
            self._last_dispatched_owner = owner_id
            return work
        return None

    def _next_work_locked(self, user_limit: int) -> _QueuedImageWork | None:
        # First protect every waiting owner's base share. Only then borrow otherwise-idle slots.
        work = self._next_owner_work_locked(user_limit)
        if work is not None:
            return work
        return self._next_owner_work_locked(None)

    def _handle_worker_start_failure_locked(self, work: _QueuedImageWork, error: BaseException) -> None:
        self._active_attempts.pop(work.key, None)
        task = self._tasks.get(work.key) or work.start_failure_restore or {}
        credit_settled = not work.credit_reserved or self._refund_credit(work.identity, work.task_id)
        project_settled = not task.get("project_budget_reserved") or self._refund_project_budget(
            work.identity,
            work.task_id,
        )
        settled = credit_settled and project_settled
        if work.start_failure_restore is not None:
            restored = dict(work.start_failure_restore)
            if not credit_settled:
                restored["credit_reserved"] = True
            if not project_settled:
                restored["project_budget_reserved"] = True
            self._tasks[work.key] = restored
            self.store.upsert(restored)
            return
        if settled:
            self._tasks.pop(work.key, None)
            self.store.delete(work.key)
            return
        task = self._tasks.get(work.key)
        if task is not None:
            task.update({
                "status": TASK_STATUS_ERROR,
                "error": "图片任务工作线程启动失败，请稍后重试",
                "error_code": "task_worker_start_failed",
                "credit_reserved": True,
                "updated_at": _now_iso(),
                "updated_ts": time.time(),
            })
            self.store.upsert(task)
        module_logger.error("failed to start image worker: %s", type(error).__name__)

    def _dispatch_locked(self, trigger_key: str = "") -> BaseException | None:
        _, user_limit, _, _, effective_global_limit = self._dispatch_limits()
        trigger_error: BaseException | None = None
        while self._running_total < effective_global_limit:
            work = self._next_work_locked(user_limit)
            if work is None:
                break
            self._running_total += 1
            self._running_by_owner[work.owner_id] += 1
            self._running_keys.add(work.key)
            thread = threading.Thread(
                target=self._execute_work,
                args=(work,),
                name=f"image-task-{work.task_id[:16]}",
                daemon=True,
            )
            try:
                thread.start()
            except BaseException as exc:
                self._running_total = max(0, self._running_total - 1)
                self._running_keys.discard(work.key)
                next_count = max(0, self._running_by_owner.get(work.owner_id, 0) - 1)
                if next_count:
                    self._running_by_owner[work.owner_id] = next_count
                else:
                    self._running_by_owner.pop(work.owner_id, None)
                self._handle_worker_start_failure_locked(work, exc)
                if work.key == trigger_key:
                    trigger_error = exc
        return trigger_error

    def _execute_work(self, work: _QueuedImageWork) -> None:
        try:
            work.runner(*work.args)
        finally:
            with self._lock:
                if work.key in self._running_keys:
                    self._running_keys.discard(work.key)
                    self._running_total = max(0, self._running_total - 1)
                    next_count = max(0, self._running_by_owner.get(work.owner_id, 0) - 1)
                    if next_count:
                        self._running_by_owner[work.owner_id] = next_count
                    else:
                        self._running_by_owner.pop(work.owner_id, None)
                self._dispatch_locked()

    def _queued_keys_locked(self) -> list[str]:
        queues = {owner: deque(items) for owner, items in self._pending_by_owner.items()}
        cycle = deque(owner for owner in self._owner_cycle if owner in queues)
        if self._last_dispatched_owner and self._last_dispatched_owner in cycle:
            owner_index = list(cycle).index(self._last_dispatched_owner)
            cycle.rotate(-(owner_index + 1))
        ordered: list[str] = []
        while cycle:
            owner_id = cycle.popleft()
            queue = queues.get(owner_id)
            if not queue:
                continue
            ordered.append(queue.popleft().key)
            if queue:
                cycle.append(owner_id)
        return ordered

    def _estimated_duration_secs_locked(self) -> float:
        if not self._recent_durations_secs:
            return 30.0
        samples = sorted(self._recent_durations_secs)
        return samples[len(samples) // 2]

    def _public_task_locked(self, task: dict[str, Any]) -> dict[str, Any]:
        item = _public_task(task)
        key = _task_key(_clean(task.get("owner_id")), _clean(task.get("id")))
        if task.get("status") == TASK_STATUS_QUEUED:
            queued_keys = self._queued_keys_locked()
        else:
            queued_keys = []
        if key in queued_keys:
            position = queued_keys.index(key) + 1
            _, _, _, _, global_limit = self._dispatch_limits()
            item["queue_position"] = position
            item["queue_total"] = len(queued_keys)
            item["estimated_wait_secs"] = int(
                max(1.0, ((position + global_limit - 1) // global_limit) * self._estimated_duration_secs_locked())
            )
        return item

    def submit_generation(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        quality: str = "auto",
        base_url: str = "",
        workflow: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "model": model,
            "n": 1,
            "size": size,
            "quality": quality,
            "response_format": "url",
            "base_url": base_url,
        }
        return self._submit(
            identity,
            client_task_id=client_task_id,
            mode="generate",
            payload=payload,
            workflow=workflow,
        )

    def retry_generation(
        self,
        identity: dict[str, object],
        task_id: str,
        *,
        base_url: str = "",
    ) -> dict[str, Any]:
        """Requeue one accessible failed generation task without changing its public task ID."""
        normalized_task_id = _clean(task_id)
        with self._lock:
            key, task = self._resolve_task_locked(identity, normalized_task_id)
            retry_identity = self._task_identity(task)
            if task.get("status") != TASK_STATUS_ERROR:
                raise ValueError("task is not in error state")
            if task.get("mode") != "generate":
                raise ValueError("only generation tasks can be retried")
            if _clean(task.get("error_code")) in NON_RETRYABLE_ERROR_CODES:
                raise ValueError("该提示词被安全策略拒绝，请修改提示词后重新生成")
            if task.get("credit_reserved"):
                if not self._refund_credit(retry_identity, _clean(task.get("id"))):
                    raise ValueError("任务额度仍在结算中，请稍后重试")
                task["credit_reserved"] = False
                self.store.upsert(task)
            if task.get("project_budget_reserved"):
                if not self._refund_project_budget(retry_identity, _clean(task.get("id"))):
                    raise ValueError("项目额度仍在结算中，请稍后重试")
                task["project_budget_reserved"] = False
                self.store.upsert(task)

            prompt = _clean(task.get("retry_prompt"))
            if not prompt:
                raise ValueError("历史任务未保存原始提示词，请重新填写后生成")

            legacy_retry_task_id = _clean(task.get("retry_task_id"))
            # _submit owns the quota reservation, persistence, and worker startup
            # transaction. Removing the failed record only in memory lets it create
            # a clean attempt using the same public ID; on any submission failure the
            # original failed record is restored for another retry.
            failed_task = dict(task)
            self._tasks.pop(key)
            self.store.delete(key)
            try:
                retried_task = self.submit_generation(
                    retry_identity,
                    client_task_id=normalized_task_id,
                    prompt=prompt,
                    model=_clean(task.get("model"), "gpt-image-2"),
                    size=_clean(task.get("size")) or None,
                    quality=_clean(task.get("quality"), "auto"),
                    base_url=base_url,
                    workflow=dict(task.get("workflow")) if isinstance(task.get("workflow"), dict) else None,
                )
                if legacy_retry_task_id:
                    replacement = self._tasks.get(key)
                    if replacement is not None:
                        replacement["retry_task_id"] = legacy_retry_task_id
                        self.store.upsert(replacement)
                        return self._public_task_locked(replacement)
                return retried_task
            except Exception:
                self._tasks[key] = failed_task
                self.store.upsert(failed_task)
                raise

    def submit_edit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        quality: str = "auto",
        base_url: str = "",
        images: list[tuple[bytes, str, str]] | None = None,
        masks: list[tuple[bytes, str, str]] | None = None,
        workflow: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "images": images or [],
            "mask": masks or [],
            "model": model,
            "n": 1,
            "size": size,
            "quality": quality,
            "response_format": "url",
            "base_url": base_url,
        }
        return self._submit(
            identity,
            client_task_id=client_task_id,
            mode="edit",
            payload=payload,
            workflow=workflow,
        )

    def retry_edit(
        self,
        identity: dict[str, object],
        task_id: str,
        *,
        base_url: str,
        images: list[tuple[bytes, str, str]],
        masks: list[tuple[bytes, str, str]] | None = None,
    ) -> dict[str, Any]:
        """Retry an accessible persisted workflow edit using its stored source image."""
        normalized_task_id = _clean(task_id)
        with self._lock:
            key, task = self._resolve_task_locked(identity, normalized_task_id)
            retry_identity = self._task_identity(task)
            if task.get("status") != TASK_STATUS_ERROR or task.get("mode") != "edit":
                raise ValueError("task is not a failed edit")
            if _clean(task.get("error_code")) in NON_RETRYABLE_ERROR_CODES:
                raise ValueError("该提示词被安全策略拒绝，请修改后重试")
            if task.get("credit_reserved"):
                if not self._refund_credit(retry_identity, normalized_task_id):
                    raise ValueError("任务额度仍在结算中，请稍后重试")
                task["credit_reserved"] = False
                self.store.upsert(task)
            if task.get("project_budget_reserved"):
                if not self._refund_project_budget(retry_identity, normalized_task_id):
                    raise ValueError("项目额度仍在结算中，请稍后重试")
                task["project_budget_reserved"] = False
                self.store.upsert(task)
            failed_task = dict(task)
            self._tasks.pop(key)
            self.store.delete(key)
            try:
                return self.submit_edit(
                    retry_identity,
                    client_task_id=normalized_task_id,
                    prompt=_clean(task.get("prompt")),
                    model=_clean(task.get("model"), "gpt-image-2"),
                    size=_clean(task.get("size")) or None,
                    quality=_clean(task.get("quality"), "auto"),
                    base_url=base_url,
                    images=images,
                    masks=masks,
                    workflow=dict(task.get("workflow")) if isinstance(task.get("workflow"), dict) else None,
                )
            except Exception:
                self._tasks[key] = failed_task
                self.store.upsert(failed_task)
                raise

    def list_tasks(
        self,
        identity: dict[str, object],
        task_ids: list[str],
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        page_limit = max(1, min(int(limit), 200))
        page_offset = max(0, int(offset))
        with self._lock:
            changed = self._reconcile_terminal_credits_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                else:
                    items.append(self._public_task_locked(task))
            if not requested_ids:
                hidden_legacy_retry_task_ids = self._hidden_legacy_retry_task_ids_locked(owner)
                items = [
                    self._public_task_locked(task)
                    for task in self._tasks.values()
                    if task.get("owner_id") == owner and _clean(task.get("id")) not in hidden_legacy_retry_task_ids
                ]
                items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
                total = len(items)
                items = items[page_offset:page_offset + page_limit]
                missing_ids = []
            else:
                return {"items": items, "missing_ids": missing_ids}
            next_offset = page_offset + len(items)
            return {
                "items": items,
                "missing_ids": missing_ids,
                "total": total,
                "has_more": not requested_ids and next_offset < total,
                "next_offset": next_offset if not requested_ids and next_offset < total else None,
            }

    def get_task(self, identity: dict[str, object], task_id: str) -> dict[str, Any]:
        with self._lock:
            _, task = self._resolve_task_locked(identity, task_id)
            return self._public_task_locked(task)

    def task_timeline(self, identity: dict[str, object], task_id: str) -> dict[str, object]:
        with self._lock:
            _, task = self._resolve_task_locked(identity, task_id)
            timeline = _public_timeline(task)
            return {
                "task_id": _clean(task.get("id")),
                "status": _clean(task.get("status")),
                "current_stage": timeline[-1]["stage"] if timeline else _timeline_stage(task),
                "total_duration_ms": int(task.get("duration_ms") or 0),
                "items": timeline,
            }

    def estimate(self, identity: dict[str, object]) -> dict[str, object]:
        """Estimate a new task without reserving quota or mutating the queue."""
        owner = _owner_id(identity)
        with self._lock:
            global_limit, user_limit, queue_capacity, account_capacity, effective_global_limit = (
                self._dispatch_limits()
            )
            queued = self._pending_count_locked()
            owner_queued = len(self._pending_by_owner.get(owner) or ())
            running = self._running_total
            owner_running = self._running_by_owner.get(owner, 0)
            duration = max(1.0, self._estimated_duration_secs_locked())
            contending_owners = {
                owner_id for owner_id, items in self._pending_by_owner.items() if items
            } | {
                owner_id for owner_id, count in self._running_by_owner.items() if count > 0
            }
            owner_dispatch_limit = (
                effective_global_limit
                if not contending_owners or contending_owners == {owner}
                else user_limit
            )
            global_waves_ahead = max(0, (running + queued) // effective_global_limit)
            owner_waves_ahead = max(0, (owner_running + owner_queued) // owner_dispatch_limit)
            waves_ahead = max(global_waves_ahead, owner_waves_ahead)
            wait_secs = round(waves_ahead * duration)
            generation_secs = round(duration)
            total_secs = wait_secs + generation_secs
            sample_count = len(self._recent_durations_secs)
            confidence = "high" if sample_count >= 20 else "medium" if sample_count >= 5 else "low"
            return {
                "accepting": queued < queue_capacity,
                "queue_position": queued + 1,
                "queued": queued,
                "running": running,
                "capacity": queue_capacity,
                "global_concurrency": global_limit,
                "effective_global_concurrency": effective_global_limit,
                "user_concurrency": user_limit,
                "effective_user_concurrency": owner_dispatch_limit,
                "account_slot_capacity": account_capacity,
                "work_conserving": True,
                "estimated_wait_secs": wait_secs,
                "estimated_generation_secs": generation_secs,
                "estimated_total_secs": total_secs,
                "estimated_range_secs": {
                    "low": max(1, round(total_secs * 0.75)),
                    "high": max(1, round(total_secs * 1.5)),
                },
                "sample_count": sample_count,
                "confidence": confidence,
            }

    def metrics(self) -> dict[str, object]:
        now = time.time()
        with self._lock:
            global_limit, user_limit, queue_capacity, account_capacity, effective_global_limit = (
                self._dispatch_limits()
            )
            queued = self._pending_count_locked()
            borrowed_user_slots = sum(
                max(0, int(count) - user_limit) for count in self._running_by_owner.values()
            )
            recent_successes = sorted(
                (
                    task
                    for task in self._tasks.values()
                    if task.get("status") == TASK_STATUS_SUCCESS
                    and isinstance(task.get("duration_ms"), (int, float))
                ),
                key=lambda task: float(task.get("updated_ts") or 0.0),
            )[-500:]
            durations = sorted(
                float(task.get("duration_ms")) / 1000.0
                for task in recent_successes
            )
            if now - self._storage_health_checked_at >= 30.0 or not self._storage_health_cache:
                self._storage_health_cache = self.store.health()
                self._storage_health_checked_at = now

            def percentile(fraction: float) -> float:
                if not durations:
                    return 0.0
                rank = max(0, min(len(durations) - 1, int((len(durations) - 1) * fraction + 0.999999)))
                return round(durations[rank], 1)

            completed_last_minute = sum(
                1
                for task in self._tasks.values()
                if task.get("status") == TASK_STATUS_SUCCESS
                and isinstance(task.get("updated_ts"), (int, float))
                and float(task["updated_ts"]) >= now - 60.0
            )
            error_counts: dict[str, int] = {}
            for task in self._tasks.values():
                if task.get("status") != TASK_STATUS_ERROR:
                    continue
                error_code = _clean(task.get("error_code"), "upstream_error")
                error_counts[error_code] = error_counts.get(error_code, 0) + 1
            status_counts = {
                status: sum(1 for task in self._tasks.values() if task.get("status") == status)
                for status in (
                    TASK_STATUS_QUEUED,
                    TASK_STATUS_PAUSED,
                    TASK_STATUS_RUNNING,
                    TASK_STATUS_SUCCESS,
                    TASK_STATUS_ERROR,
                )
            }
            daily: dict[str, dict[str, object]] = {}
            models: dict[str, int] = {}
            operations: dict[str, int] = {}
            owners: dict[str, dict[str, object]] = {}
            total_duration_ms = 0.0
            duration_count = 0
            for task in self._tasks.values():
                day = _clean(task.get("created_at"))[:10] or "unknown"
                daily_item = daily.setdefault(day, {"date": day, "total": 0, "success": 0, "error": 0})
                daily_item["total"] = int(daily_item["total"]) + 1
                status = _clean(task.get("status"))
                if status in {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}:
                    daily_item[status] = int(daily_item[status]) + 1
                model_name = _clean(task.get("model"), "unknown")
                models[model_name] = models.get(model_name, 0) + 1
                workflow = task.get("workflow") if isinstance(task.get("workflow"), dict) else {}
                operation = _clean(workflow.get("operation_type"), _clean(task.get("mode"), "generate"))
                operations[operation] = operations.get(operation, 0) + 1
                owner_id = _clean(task.get("owner_id"), "anonymous")
                owner_item = owners.setdefault(
                    owner_id,
                    {"owner_id": owner_id, "total": 0, "success": 0, "error": 0},
                )
                owner_item["total"] = int(owner_item["total"]) + 1
                if status in {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}:
                    owner_item[status] = int(owner_item[status]) + 1
                duration_ms = task.get("duration_ms")
                if status == TASK_STATUS_SUCCESS and isinstance(duration_ms, (int, float)):
                    total_duration_ms += float(duration_ms)
                    duration_count += 1
            terminal_count = status_counts[TASK_STATUS_SUCCESS] + status_counts[TASK_STATUS_ERROR]
            return {
                "queue": {
                    "queued": queued,
                    "paused": status_counts[TASK_STATUS_PAUSED],
                    "running": self._running_total,
                    "capacity": queue_capacity,
                    "global_concurrency": global_limit,
                    "effective_global_concurrency": effective_global_limit,
                    "per_user_concurrency": user_limit,
                    "account_slot_capacity": account_capacity,
                    "available_dispatch_slots": max(0, effective_global_limit - self._running_total),
                    "borrowed_user_slots": borrowed_user_slots,
                    "work_conserving": True,
                    "slot_utilization_percent": round(
                        100.0 * self._running_total / effective_global_limit,
                        1,
                    ),
                    "active_users": len(self._running_by_owner),
                    "rejected_total": self._queue_rejected_total,
                    "saturation_percent": round(100.0 * queued / queue_capacity, 1),
                },
                "performance": {
                    "p50_secs": percentile(0.50),
                    "p95_secs": percentile(0.95),
                    "throughput_per_minute": completed_last_minute,
                    "estimated_task_secs": round(self._estimated_duration_secs_locked(), 1),
                },
                "tasks": {"total": len(self._tasks), **status_counts},
                "analytics": {
                    "summary": {
                        "success_rate": round(100.0 * status_counts[TASK_STATUS_SUCCESS] / terminal_count, 1) if terminal_count else 0.0,
                        "average_duration_secs": round(total_duration_ms / duration_count / 1000.0, 1) if duration_count else 0.0,
                    },
                    "daily": sorted(daily.values(), key=lambda item: str(item["date"]))[-14:],
                    "models": [
                        {"name": name, "count": count}
                        for name, count in sorted(models.items(), key=lambda item: (-item[1], item[0]))
                    ],
                    "features": [
                        {"name": name, "count": count}
                        for name, count in sorted(operations.items(), key=lambda item: (-item[1], item[0]))
                    ],
                },
                "user_activity": sorted(owners.values(), key=lambda item: (-int(item["total"]), str(item["owner_id"])))[:50],
                "errors": dict(sorted(error_counts.items(), key=lambda item: (-item[1], item[0]))),
                "storage": dict(self._storage_health_cache),
                "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            }

    def list_admin_inspiration_candidates(self, limit: int = 24) -> list[dict[str, object]]:
        """Return the first completed user text-to-image outputs for legacy callers."""
        safe_limit = max(1, min(int(limit), 100))
        with self._lock:
            return self._prepare_admin_inspiration_candidates_locked()[:safe_limit]

    def list_admin_inspiration_candidate_page(self, page: int = 1, page_size: int = 24) -> dict[str, object]:
        """Return one stable page of completed user text-to-image outputs for curation."""
        safe_page_size = max(1, min(int(page_size), 100))
        safe_requested_page = max(1, int(page))
        with self._lock:
            candidates = self._prepare_admin_inspiration_candidates_locked()

        total = len(candidates)
        total_pages = max(1, (total + safe_page_size - 1) // safe_page_size)
        normalized_page = min(safe_requested_page, total_pages)
        start = (normalized_page - 1) * safe_page_size
        return {
            "items": candidates[start:start + safe_page_size],
            "page": normalized_page,
            "page_size": safe_page_size,
            "total": total,
            "total_pages": total_pages,
        }

    def _prepare_admin_inspiration_candidates_locked(self) -> list[dict[str, object]]:
        """Build curatable candidates while holding the task lock.

        Image edits are deliberately excluded: their reference uploads can contain private
        user material and must never be surfaced in the shared inspiration workflow.
        """
        changed = self._reconcile_terminal_credits_locked()
        changed = self._cleanup_locked() or changed
        if changed:
            self._save_locked()

        tasks = sorted(self._tasks.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        candidates: list[dict[str, object]] = []
        for task in tasks:
            if (
                task.get("status") != TASK_STATUS_SUCCESS
                or task.get("mode") != "generate"
                or _clean(task.get("owner_role"), "user") != "user"
            ):
                continue
            owner_id = _clean(task.get("owner_id"))
            task_id = _clean(task.get("id"))
            prompt = _clean(task.get("prompt"))
            data = task.get("data")
            if not owner_id or not task_id or not prompt or not isinstance(data, list):
                continue
            for image_index, item in enumerate(data):
                if not isinstance(item, dict):
                    continue
                preview_url = _portable_image_url(item.get("url"))
                if not preview_url.startswith("/images/"):
                    continue
                candidates.append({
                    "owner_id": owner_id,
                    "task_id": task_id,
                    "image_index": image_index,
                    "prompt": prompt,
                    "preview_url": preview_url,
                    "size": _clean(task.get("size"), "1024x1024"),
                    "quality": _clean(task.get("quality"), "auto"),
                    "created_at": _clean(task.get("created_at")),
                })
        return candidates

    def get_admin_inspiration_source(self, owner_id: str, task_id: str, image_index: int) -> dict[str, object]:
        """Load one curatable source strictly by its private owner/task key."""
        normalized_owner = _clean(owner_id)
        normalized_task_id = _clean(task_id)
        if not normalized_owner or not normalized_task_id:
            raise LookupError("未找到对应的用户生成任务")
        if not isinstance(image_index, int) or isinstance(image_index, bool) or image_index < 0:
            raise ValueError("图片序号无效")

        with self._lock:
            changed = self._reconcile_terminal_credits_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()
            task = self._tasks.get(_task_key(normalized_owner, normalized_task_id))
            if task is None:
                raise LookupError("未找到对应的用户生成任务")
            if task.get("status") != TASK_STATUS_SUCCESS or task.get("mode") != "generate":
                raise ValueError("仅可收录已完成的用户文生图任务")
            if _clean(task.get("owner_role"), "user") != "user":
                raise ValueError("仅可收录普通用户的生成作品")
            prompt = _clean(task.get("prompt"))
            data = task.get("data")
            if not prompt or not isinstance(data, list) or image_index >= len(data):
                raise LookupError("未找到可收录的图片结果")
            image = data[image_index]
            if not isinstance(image, dict):
                raise LookupError("未找到可收录的图片结果")
            preview_url = _portable_image_url(image.get("url"))
            if not preview_url.startswith("/images/"):
                raise ValueError("该任务图片未保存在本地，暂时无法收录到灵感库")
            return {
                "owner_id": normalized_owner,
                "task_id": normalized_task_id,
                "image_index": image_index,
                "prompt": prompt,
                "preview_url": preview_url,
                "size": _clean(task.get("size"), "1024x1024"),
                "quality": _clean(task.get("quality"), "auto"),
            }

    def _hidden_legacy_retry_task_ids_locked(self, owner: str) -> set[str]:
        """Return obsolete task IDs that should not duplicate a legacy retry in the task feed."""
        hidden_task_ids: set[str] = set()
        for source_task in self._tasks.values():
            if _clean(source_task.get("owner_id")) != owner:
                continue
            retry_task_id = _clean(source_task.get("retry_task_id"))
            source_task_id = _clean(source_task.get("id"))
            if not retry_task_id or retry_task_id == source_task_id:
                continue
            retry_task = self._tasks.get(_task_key(owner, retry_task_id))
            if retry_task is None:
                continue
            if retry_task.get("status") == TASK_STATUS_ERROR:
                hidden_task_ids.add(retry_task_id)
            else:
                hidden_task_ids.add(source_task_id)
        return hidden_task_ids

    def delete_failed_task(self, identity: dict[str, object], task_id: str) -> dict[str, Any]:
        """Delete one owned failed task without allowing other task states to be removed."""
        owner = _owner_id(identity)
        normalized_task_id = _clean(task_id)
        key = _task_key(owner, normalized_task_id)
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                raise ValueError("task not found")
            if task.get("status") != TASK_STATUS_ERROR:
                raise ValueError("only failed tasks can be deleted")

            # Failed tasks normally refund their reservation before reaching this state.
            # Keep deletion safe for records left inconsistent by an interrupted transition.
            if task.get("credit_reserved"):
                if not self._refund_credit(identity, normalized_task_id):
                    raise ValueError("任务额度仍在结算中，请稍后再删除")
            if task.get("project_budget_reserved"):
                if not self._refund_project_budget(identity, normalized_task_id):
                    raise ValueError("项目额度仍在结算中，请稍后再删除")

            removed_task = self._tasks.pop(key)
            try:
                self.store.delete(key)
            except Exception:
                self._tasks[key] = removed_task
                raise
        return {"ok": True, "id": normalized_task_id}

    def cancel_task(self, identity: dict[str, object], task_id: str) -> dict[str, Any]:
        """Stop an accessible unfinished task and make any late worker result inert."""
        normalized_task_id = _clean(task_id)
        with self._lock:
            key, task = self._resolve_task_locked(identity, normalized_task_id)
            if task.get("status") not in UNFINISHED_STATUSES:
                return self._public_task_locked(task)

            self._remove_pending_work_locked(key)
            self._paused_work.pop(key, None)
            cancel_event = self._active_attempts.pop(key, None)
            if cancel_event is not None:
                cancel_event.set()
            duration_ms = int(max(0.0, time.time() - _task_created_timestamp(task)) * 1000)
            credit_reserved = bool(task.get("credit_reserved"))
            self._update_task(
                key,
                status=TASK_STATUS_ERROR,
                error="已由用户手动停止",
                error_code="cancelled_by_user",
                progress="cancelled",
                data=[],
                duration_ms=duration_ms,
                credit_reserved=credit_reserved,
            )
            if credit_reserved and self._refund_credit(self._task_identity(task), normalized_task_id):
                self._clear_credit_reserved_flag(key)
            if task.get("project_budget_reserved") and self._refund_project_budget(
                self._task_identity(task), normalized_task_id
            ):
                self._clear_project_budget_reserved_flag(key)
            self._dispatch_locked()
            return self._public_task_locked(self._tasks[key])

    def pause_task(self, identity: dict[str, object], task_id: str) -> dict[str, Any]:
        """Pause an accessible queued task without releasing its reserved credit."""
        normalized_task_id = _clean(task_id)
        with self._lock:
            key, task = self._resolve_task_locked(identity, normalized_task_id)
            if task.get("status") == TASK_STATUS_PAUSED:
                return self._public_task_locked(task)
            if task.get("status") != TASK_STATUS_QUEUED or key in self._running_keys:
                raise ValueError("only queued tasks can be paused")
            work = self._take_pending_work_locked(key)
            if work is None:
                raise ValueError("task is already starting")
            self._paused_work[key] = work
            self._update_task(key, status=TASK_STATUS_PAUSED, progress="paused")
            self._dispatch_locked()
            return self._public_task_locked(self._tasks[key])

    @staticmethod
    def _stored_image_tuple(path: str) -> tuple[bytes, str, str]:
        from services.image_storage_service import image_storage_service

        normalized = _clean(path)
        payload = image_storage_service.get_bytes(normalized)
        suffix = Path(normalized).suffix.lower()
        content_type = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(
            suffix, "image/png"
        )
        return payload, Path(normalized).name or "source.png", content_type

    def _rebuild_paused_work(self, task: dict[str, Any]) -> _QueuedImageWork:
        workflow = task.get("workflow") if isinstance(task.get("workflow"), dict) else {}
        payload: dict[str, Any] = {
            "prompt": _clean(task.get("prompt")),
            "model": _clean(task.get("model"), "gpt-image-2"),
            "n": 1,
            "size": _clean(task.get("size")) or None,
            "quality": _clean(task.get("quality"), "auto"),
            "response_format": "url",
            "base_url": "",
        }
        mode = _clean(task.get("mode"), "generate")
        if not payload["prompt"]:
            raise ValueError("task has no durable prompt snapshot")
        if mode == "edit":
            source_paths = workflow.get("source_paths")
            if not isinstance(source_paths, list):
                source_paths = [_clean(workflow.get("source_path"))]
            images = [self._stored_image_tuple(path) for path in source_paths if _clean(path)]
            if not images:
                raise ValueError("paused edit source is unavailable")
            mask_paths = workflow.get("mask_paths")
            if not isinstance(mask_paths, list):
                mask_paths = [_clean(workflow.get("mask_path"))]
            payload["images"] = images
            payload["mask"] = [self._stored_image_tuple(path) for path in mask_paths if _clean(path)]
        attempt = threading.Event()
        owner = _clean(task.get("owner_id"))
        task_id = _clean(task.get("id"))
        identity = {
            "id": owner,
            "role": _clean(task.get("owner_role"), "user"),
            "name": _clean(task.get("owner_name")),
            "group": _clean(task.get("owner_group"), "default"),
        }
        key = _task_key(owner, task_id)
        return _QueuedImageWork(
            key=key,
            owner_id=owner,
            task_id=task_id,
            attempt=attempt,
            runner=self._run_task,
            args=(
                key,
                task_id,
                mode,
                payload,
                identity,
                _clean(task.get("model"), "gpt-image-2"),
                bool(task.get("credit_reserved")),
                attempt,
            ),
            identity=identity,
            credit_reserved=bool(task.get("credit_reserved")),
            priority=_priority(task.get("priority")),
        )

    def _rebuild_resume_work(self, task: dict[str, Any], *, timeout_secs: float = 45.0) -> _QueuedImageWork:
        conversation_id = _clean(task.get("conversation_id"))
        account_ref = _clean(task.get("account_ref"))
        if not conversation_id or not account_ref:
            raise ValueError("task has no durable upstream checkpoint")
        if not account_service.resolve_image_access_token(account_ref):
            raise ValueError("checkpoint account is unavailable")
        owner = _clean(task.get("owner_id"))
        task_id = _clean(task.get("id"))
        key = _task_key(owner, task_id)
        attempt = threading.Event()
        identity = self._task_identity(task)
        return _QueuedImageWork(
            key=key,
            owner_id=owner,
            task_id=task_id,
            attempt=attempt,
            runner=self._run_resume_poll,
            args=(
                key,
                task_id,
                conversation_id,
                account_ref,
                max(5.0, min(120.0, float(timeout_secs))),
                identity,
                _clean(task.get("mode"), "generate"),
                _clean(task.get("model"), "gpt-image-2"),
                bool(task.get("credit_reserved")),
                attempt,
            ),
            identity=identity,
            credit_reserved=bool(task.get("credit_reserved")),
            priority=_priority(task.get("priority")),
            start_failure_restore=dict(task),
        )

    def resume_task(self, identity: dict[str, object], task_id: str) -> dict[str, Any]:
        normalized_task_id = _clean(task_id)
        with self._lock:
            key, task = self._resolve_task_locked(identity, normalized_task_id)
            if task.get("status") == TASK_STATUS_QUEUED:
                return self._public_task_locked(task)
            if task.get("status") != TASK_STATUS_PAUSED:
                raise ValueError("only paused tasks can be resumed")
            work = self._paused_work.pop(key, None)
            task_snapshot = dict(task)
        if work is None:
            work = self._rebuild_paused_work(task_snapshot)
        with self._lock:
            task = self._tasks.get(key)
            if task is None or task.get("status") != TASK_STATUS_PAUSED:
                raise ValueError("task state changed while resuming")
            self._active_attempts[key] = work.attempt
            self._enqueue_work_locked(work)
            self._update_task(key, status=TASK_STATUS_QUEUED, progress="queued")
            start_error = self._dispatch_locked(trigger_key=key)
            if start_error is not None:
                raise start_error
            return self._public_task_locked(self._tasks[key])

    def set_task_priority(self, identity: dict[str, object], task_id: str, priority: int) -> dict[str, Any]:
        normalized_task_id = _clean(task_id)
        normalized_priority = _priority(priority)
        with self._lock:
            key, task = self._resolve_task_locked(identity, normalized_task_id)
            if task.get("status") not in {TASK_STATUS_QUEUED, TASK_STATUS_PAUSED}:
                raise ValueError("only queued or paused tasks can change priority")
            task["priority"] = normalized_priority
            workflow = dict(task.get("workflow") or {})
            workflow["priority"] = normalized_priority
            task["workflow"] = workflow
            if task.get("status") == TASK_STATUS_PAUSED:
                work = self._paused_work.get(key)
                if work is not None:
                    work.priority = normalized_priority
            else:
                work = self._take_pending_work_locked(key)
                if work is not None:
                    work.priority = normalized_priority
                    self._enqueue_work_locked(work)
            self._update_task(key, priority=normalized_priority, workflow=workflow)
            return self._public_task_locked(self._tasks[key])

    def list_admin_tasks(self, limit: int = 300) -> list[dict[str, Any]]:
        with self._lock:
            items = [
                self._public_task_locked(task) | {"owner_id": _clean(task.get("owner_id"))}
                for task in self._tasks.values()
                if _clean(task.get("source"), "queue") == "queue"
            ]
        items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return items[: max(1, min(int(limit), 2000))]

    def list_admin_task_page(
        self,
        *,
        limit: int = 40,
        offset: int = 0,
        status: str = "",
        source: str = "",
        mode: str = "",
        query: str = "",
    ) -> dict[str, Any]:
        page_limit = max(1, min(int(limit), 200))
        page_offset = max(0, int(offset))
        normalized_status = _clean(status).lower()
        normalized_source = _clean(source).lower()
        normalized_mode = _clean(mode).lower()
        normalized_query = _clean(query).lower()
        with self._lock:
            changed = self._cleanup_locked()
            if changed:
                self._save_locked()
            self._enrich_legacy_image_metadata_locked()
            all_items = [
                self._public_task_locked(task) | {"owner_id": _clean(task.get("owner_id"))}
                for task in self._tasks.values()
            ]
        all_items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        summary = {
            "total": len(all_items),
            "queued": sum(item.get("status") == TASK_STATUS_QUEUED for item in all_items),
            "paused": sum(item.get("status") == TASK_STATUS_PAUSED for item in all_items),
            "running": sum(item.get("status") == TASK_STATUS_RUNNING for item in all_items),
            "success": sum(item.get("status") == TASK_STATUS_SUCCESS for item in all_items),
            "error": sum(item.get("status") == TASK_STATUS_ERROR for item in all_items),
            "api": sum(item.get("source") == "api" for item in all_items),
            "queue": sum(item.get("source") == "queue" for item in all_items),
        }
        items = [
            item
            for item in all_items
            if (not normalized_status or _clean(item.get("status")).lower() == normalized_status)
            and (not normalized_source or _clean(item.get("source")).lower() == normalized_source)
            and (not normalized_mode or _clean(item.get("mode")).lower() == normalized_mode)
            and (
                not normalized_query
                or normalized_query
                in " ".join(
                    _clean(item.get(key)).lower()
                    for key in ("id", "prompt", "model", "endpoint", "caller_key_name", "owner_id")
                )
            )
        ]
        total = len(items)
        page_items = items[page_offset:page_offset + page_limit]
        return {
            "items": page_items,
            "summary": summary,
            "pagination": {
                "limit": page_limit,
                "offset": page_offset,
                "total": total,
                "has_more": page_offset + len(page_items) < total,
                "next_offset": page_offset + len(page_items)
                if page_offset + len(page_items) < total
                else None,
            },
        }

    def _enrich_legacy_image_metadata_locked(self) -> None:
        """Backfill pre-feature local image records once when the overview is used."""
        for key, task in self._tasks.items():
            data = task.get("data")
            if not isinstance(data, list):
                continue
            needs_enrichment = any(
                isinstance(item, dict)
                and not _clean(item.get("path"))
                and bool(_stored_image_path(item.get("url")))
                for item in data
            )
            if not needs_enrichment:
                continue
            previous = list(data)
            previous_result_count = task.get("result_count")
            task["data"] = _tracked_image_data(data)
            if task.get("result_count") is None:
                task["result_count"] = len(
                    [item for item in previous if isinstance(item, dict)]
                )
            try:
                self.store.upsert(task)
            except Exception:
                task["data"] = previous
                if previous_result_count is None:
                    task.pop("result_count", None)
                else:
                    task["result_count"] = previous_result_count
                module_logger.exception(
                    "failed to persist legacy image metadata for task %s",
                    key,
                )

    def begin_api_call(
        self,
        identity: dict[str, object],
        *,
        mode: str,
        endpoint: str,
        prompt: str,
        model: str,
        size: str | None,
        quality: str,
        request_n: int,
        response_format: str,
    ) -> dict[str, Any]:
        owner = _owner_id(identity)
        task_id = f"api-{uuid4().hex}"
        key = _task_key(owner, task_id)
        now = _now_iso()
        now_ts = time.time()
        task = {
            "id": task_id,
            "owner_id": owner,
            "owner_role": _clean(identity.get("role"), "admin"),
            "owner_name": _clean(identity.get("name")),
            "owner_group": _clean(identity.get("group"), "default"),
            "status": TASK_STATUS_RUNNING,
            "mode": "edit" if mode == "edit" else "generate",
            "source": "api",
            "endpoint": _clean(endpoint),
            "model": _clean(model, "gpt-image-2"),
            "size": _clean(size),
            "quality": _clean(quality, "auto"),
            "prompt": _clean(prompt)[:10_000],
            "request_n": max(1, min(4, int(request_n or 1))),
            "response_format": _clean(response_format, "b64_json"),
            "caller_key_id": _clean(identity.get("id")),
            "caller_key_name": _clean(identity.get("name")) or _clean(identity.get("id")),
            "created_at": now,
            "updated_at": now,
            "created_ts": now_ts,
            "updated_ts": now_ts,
            "started_ts": now_ts,
            "priority": 0,
            "resume_count": 0,
            "progress": "starting_generation",
            "last_checkpoint": "upstream_running",
            "timeline": [
                {
                    "stage": "api_received",
                    "status": TASK_STATUS_RUNNING,
                    "created_at": now,
                    "created_ts": now_ts,
                    "detail": "已接收 OpenAI 兼容图片请求",
                }
            ],
        }
        with self._lock:
            changed = self._cleanup_locked()
            self._tasks[key] = task
            try:
                self.store.upsert(task)
            except Exception:
                self._tasks.pop(key, None)
                raise
            if changed:
                self._save_locked()
            return self._public_task_locked(task) | {"owner_id": owner}

    def complete_api_call(
        self,
        identity: dict[str, object],
        task_id: str,
        result: object,
    ) -> dict[str, Any]:
        payload = result if isinstance(result, dict) else {}
        raw_data = payload.get("data")
        result_count = (
            len([item for item in raw_data if isinstance(item, dict)])
            if isinstance(raw_data, list)
            else 0
        )
        data = _tracked_image_data(raw_data)
        if not result_count:
            return self.fail_api_call(
                identity,
                task_id,
                RuntimeError(_clean(payload.get("message"), "上游未返回有效图片")),
            )
        owner = _owner_id(identity)
        key = _task_key(owner, _clean(task_id))
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                raise ValueError("task not found")
            if task.get("status") in TERMINAL_STATUSES:
                return self._public_task_locked(task)
            duration_ms = int(max(0.0, time.time() - _task_created_timestamp(task)) * 1_000)
            usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
            self._update_task(
                key,
                status=TASK_STATUS_SUCCESS,
                data=data,
                result_count=result_count,
                usage=usage,
                error="",
                error_code="",
                duration_ms=duration_ms,
                progress="receiving_image",
                last_checkpoint="completed",
            )
            return self._public_task_locked(self._tasks[key])

    def fail_api_call(
        self,
        identity: dict[str, object],
        task_id: str,
        error: BaseException,
    ) -> dict[str, Any]:
        owner = _owner_id(identity)
        key = _task_key(owner, _clean(task_id))
        message = str(error) or "图片调用失败"
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                raise ValueError("task not found")
            if task.get("status") in TERMINAL_STATUSES:
                return self._public_task_locked(task)
            duration_ms = int(max(0.0, time.time() - _task_created_timestamp(task)) * 1_000)
            self._update_task(
                key,
                status=TASK_STATUS_ERROR,
                data=[],
                error=message,
                error_code=_classify_image_error(error, message),
                duration_ms=duration_ms,
                progress="",
                last_checkpoint="failed",
            )
            return self._public_task_locked(self._tasks[key])

    def _submit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        mode: str,
        payload: dict[str, Any],
        workflow: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        task_id = _clean(client_task_id)
        if not task_id:
            raise ValueError("client_task_id is required")
        normalized_workflow = dict(workflow or {})
        workflow_branch_id = _clean(normalized_workflow.get("branch_id"))
        if workflow_branch_id and self.creative_intelligence_manager is not None:
            branch = self.creative_intelligence_manager.get_branch(identity, workflow_branch_id)
            requested_asset_id = _clean(normalized_workflow.get("asset_id"))
            if requested_asset_id and requested_asset_id != _clean(branch.get("asset_id")):
                raise ValueError("版本分支与作品不匹配")
            normalized_workflow["asset_id"] = _clean(branch.get("asset_id"))
            if not _clean(normalized_workflow.get("parent_version_id")):
                normalized_workflow["parent_version_id"] = _clean(branch.get("head_version_id"))
        workflow_asset_id = _clean(normalized_workflow.get("asset_id"))
        if workflow_asset_id:
            from services.creative_workspace_service import creative_workspace_service

            asset = creative_workspace_service.get_asset(identity, workflow_asset_id)
            if not _clean(normalized_workflow.get("project_id")):
                normalized_workflow["project_id"] = _clean(asset.get("project_id"))
        workflow = normalized_workflow or None
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        now = _now_iso()
        credit_reserved = False
        project_budget_reserved = False
        attempt = threading.Event()
        with self._lock:
            cleaned = self._cleanup_locked()
            task = self._tasks.get(key)
            if task is not None:
                if cleaned:
                    self._save_locked()
                return self._public_task_locked(task)
            _, _, queue_capacity = self._queue_limits()
            if self._pending_count_locked() >= queue_capacity:
                self._queue_rejected_total += 1
                raise ImageQueueFullError(f"图片任务队列已满（上限 {queue_capacity}），请稍后重试")
            reservation = self.credit_manager.reserve_image_credit(identity, task_id)
            if reservation is False:
                raise ValueError("用户图片额度不足，请联系管理员分配额度")
            credit_reserved = reservation is True
            project_id = _clean((workflow or {}).get("project_id"))
            try:
                project_reservation = self._reserve_project_budget(identity, project_id, task_id)
            except Exception:
                if credit_reserved:
                    self._refund_credit(identity, task_id)
                raise
            if project_reservation is False:
                if credit_reserved:
                    self._refund_credit(identity, task_id)
                raise ValueError("项目图片额度不足，请联系管理员调整项目预算")
            project_budget_reserved = project_reservation is True
            prompt = _clean(payload.get("prompt"))
            task = {
                "id": task_id,
                "owner_id": owner,
                "owner_role": _clean(identity.get("role"), "user"),
                "owner_name": _clean(identity.get("name")),
                "owner_group": _clean(identity.get("group"), "default"),
                "credit_reserved": credit_reserved,
                "project_budget_reserved": project_budget_reserved,
                "status": TASK_STATUS_QUEUED,
                "mode": mode,
                "source": "queue",
                "endpoint": "/api/image-tasks/edits" if mode == "edit" else "/api/image-tasks/generations",
                "model": _clean(payload.get("model"), "gpt-image-2"),
                "size": _clean(payload.get("size")),
                "quality": _clean(payload.get("quality"), "auto"),
                "prompt": prompt,
                "retry_prompt": prompt if mode == "generate" else "",
                "created_at": now,
                "updated_at": now,
                "created_ts": time.time(),
                "priority": _priority((workflow or {}).get("priority")),
                "resume_count": 0,
                "last_checkpoint": "queued",
                "timeline": [
                    {
                        "stage": "input_prepared" if mode == "edit" else "queued",
                        "status": TASK_STATUS_QUEUED,
                        "created_at": now,
                        "created_ts": time.time(),
                        "detail": "参考图与蒙版已持久化" if mode == "edit" else "任务已进入等待队列",
                    }
                ],
            }
            if mode == "edit":
                task["timeline"].append(
                    {
                        "stage": "queued",
                        "status": TASK_STATUS_QUEUED,
                        "created_at": now,
                        "created_ts": time.time(),
                        "detail": "任务已进入等待队列",
                    }
                )
            if workflow:
                task["workflow"] = dict(workflow)
            self._tasks[key] = task
            try:
                self.store.upsert(task)
            except Exception:
                self._tasks.pop(key, None)
                if credit_reserved:
                    self._refund_credit(identity, task_id)
                if project_budget_reserved:
                    self._refund_project_budget(identity, task_id)
                raise
            self._active_attempts[key] = attempt
            work = _QueuedImageWork(
                key=key,
                owner_id=owner,
                task_id=task_id,
                attempt=attempt,
                runner=self._run_task,
                args=(
                    key,
                    task_id,
                    mode,
                    payload,
                    dict(identity),
                    _clean(payload.get("model"), "gpt-image-2"),
                    credit_reserved,
                    attempt,
                ),
                identity=dict(identity),
                credit_reserved=credit_reserved,
                priority=int(task["priority"]),
            )
            self._enqueue_work_locked(work)
            start_error = self._dispatch_locked(trigger_key=key)
            if start_error is not None:
                raise start_error
            current = self._tasks.get(key, task)
            return self._public_task_locked(current)

    def _run_task(
        self,
        key: str,
        task_id: str,
        mode: str,
        payload: dict[str, Any],
        identity: dict[str, object],
        model: str,
        credit_reserved: bool,
        attempt: threading.Event,
    ) -> None:
        started = time.time()
        # 创建进度回调，每个步骤完成后更新任务状态
        def progress_callback(step: str) -> None:
            updates: dict[str, Any] = {"progress": step}
            if step == "image_stream_resolve_start":
                updates["started_ts"] = time.time()
            self._update_active_attempt(key, attempt, **updates)
        # 将进度回调添加到 payload 中（handler 会提取并传递给 ConversationRequest）
        payload_with_progress = {
            **payload,
            "progress_callback": progress_callback,
            "cancel_event": attempt,
        }
        try:
            if not self._update_active_attempt(
                key,
                attempt,
                status=TASK_STATUS_RUNNING,
                error="",
                last_checkpoint="upstream_running",
            ):
                return
            handler = self.edit_handler if mode == "edit" else self.generation_handler
            result = handler(payload_with_progress)
            if not isinstance(result, dict):
                raise RuntimeError("image task returned streaming result unexpectedly")
            data = result.get("data")
            account_email = _clean(result.get("_account_email") or result.get("account_email"))
            if not isinstance(data, list) or not data:
                upstream = _clean(result.get("message"))
                if upstream:
                    message = upstream
                else:
                    message = "号池中没有可用账号或所有账号均被限流，请检查号池状态（账号额度、是否被封禁、是否到达生图上限）"
                error = RuntimeError(message)
                if account_email:
                    setattr(error, "account_email", account_email)
                raise error
            result_count = len(data)
            data = _tracked_image_data(data)
            usage = result.get("usage")
            duration_ms = int((time.time() - started) * 1000)
            with self._lock:
                if not self._is_active_attempt_locked(key, attempt):
                    return
                self._update_task(
                    key,
                    status=TASK_STATUS_SUCCESS,
                    data=data,
                    result_count=result_count,
                    usage=usage,
                    error="",
                    duration_ms=duration_ms,
                    credit_reserved=credit_reserved,
                    retry_prompt="",
                    last_checkpoint="completed",
                )
                completed_task = dict(self._tasks.get(key) or {})
                if credit_reserved and self._consume_credit(identity, task_id):
                    self._clear_credit_reserved_flag(key)
            if completed_task:
                self._settle_project_budget_once(
                    key,
                    identity,
                    task_id,
                    success=True,
                    duration_ms=duration_ms,
                )
                try:
                    from services.creative_workspace_service import creative_workspace_service

                    versions = creative_workspace_service.record_task_success(completed_task)
                    if versions:
                        with self._lock:
                            current_task = self._tasks.get(key)
                            if current_task is not None:
                                workflow = dict(current_task.get("workflow") or {})
                                workflow["asset_id"] = versions[0].get("asset_id")
                                workflow["version_id"] = versions[0].get("id")
                                current_task["workflow"] = workflow
                                completed_task["workflow"] = dict(workflow)
                                self.store.upsert(current_task)
                        try:
                            if self.creative_operations_manager is not None:
                                self.creative_operations_manager.record_task_provenance(completed_task, versions)
                        except Exception:
                            module_logger.exception("failed to record task provenance for %s", task_id)
                        try:
                            from services.advanced_creative_service import advanced_creative_service

                            for asset_id in {_clean(item.get("asset_id")) for item in versions if _clean(item.get("asset_id"))}:
                                advanced_creative_service.analyze_asset(identity, asset_id)
                        except Exception:
                            module_logger.exception("failed to analyze creative assets for task %s", task_id)
                        try:
                            if self.creative_intelligence_manager is not None:
                                self.creative_intelligence_manager.schedule_asset_intelligence(identity, versions)
                        except Exception:
                            module_logger.exception("failed to schedule creative intelligence for task %s", task_id)
                except Exception:
                    module_logger.exception("failed to record creative workspace version for task %s", task_id)
                try:
                    if self.creative_intelligence_manager is not None:
                        self.creative_intelligence_manager.notify_task(completed_task, success=True)
                except Exception:
                    module_logger.exception("failed to notify creative task success for task %s", task_id)
                self._notify_batch_completion(completed_task)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成",
                request_preview=request_text(payload.get("prompt")),
                urls=_collect_image_urls(data),
                account_email=account_email,
            )
        except Exception as exc:
            error_message = str(exc) or "image task failed"
            error_code = _classify_image_error(exc, error_message)
            account_email = _clean(getattr(exc, "account_email", ""))
            account_ref = _clean(getattr(exc, "account_ref", ""))
            conversation_id = _clean(getattr(exc, "conversation_id", ""))
            duration_ms = int((time.time() - started) * 1000)
            failed_task: dict[str, Any] = {}
            with self._lock:
                if not self._is_active_attempt_locked(key, attempt):
                    return
                self._update_task(
                    key,
                    status=TASK_STATUS_ERROR,
                    error=error_message,
                    error_code=error_code,
                    data=[],
                    duration_ms=duration_ms,
                    credit_reserved=credit_reserved,
                    last_checkpoint="recoverable_error" if conversation_id and account_ref else "failed",
                    **({"conversation_id": conversation_id} if conversation_id else {}),
                    **({"account_ref": account_ref} if conversation_id and account_ref else {}),
                )
                if credit_reserved and self._refund_credit(identity, task_id):
                    self._clear_credit_reserved_flag(key)
                failed_task = dict(self._tasks.get(key) or {})
            self._settle_project_budget_once(key, identity, task_id, success=False)
            workflow = failed_task.get("workflow") if isinstance(failed_task.get("workflow"), dict) else {}
            workspace_conversation_id = _clean(workflow.get("conversation_id")) if isinstance(workflow, dict) else ""
            if workspace_conversation_id:
                try:
                    from services.creative_workspace_service import creative_workspace_service

                    creative_workspace_service.fail_conversation_task(
                        identity,
                        workspace_conversation_id,
                        task_id,
                        public_image_error_message(error_message),
                    )
                except Exception:
                    module_logger.exception("failed to mark creative conversation error for task %s", task_id)
            try:
                if self.creative_intelligence_manager is not None:
                    self.creative_intelligence_manager.notify_task(failed_task, success=False)
            except Exception:
                module_logger.exception("failed to notify creative task failure for task %s", task_id)
            self._notify_batch_completion(failed_task)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败",
                request_preview=request_text(payload.get("prompt")),
                status="failed",
                error=error_message,
                account_email=account_email,
            )
        finally:
            with self._lock:
                if self._active_attempts.get(key) is attempt:
                    self._active_attempts.pop(key, None)

    def _log_call(
        self,
        identity: dict[str, object],
        mode: str,
        model: str,
        started: float,
        suffix: str,
        *,
        request_preview: str = "",
        status: str = "success",
        error: str = "",
        urls: list[str] | None = None,
        account_email: str = "",
    ) -> None:
        endpoint = "/v1/images/edits" if mode == "edit" else "/v1/images/generations"
        summary_prefix = "图生图" if mode == "edit" else "文生图"
        detail = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name"),
            "role": identity.get("role"),
            "endpoint": endpoint,
            "model": model,
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if error:
            detail["error"] = error
        if account_email:
            detail["account_email"] = account_email
        if urls:
            detail["urls"] = list(dict.fromkeys(urls))
        try:
            log_service.add(LOG_TYPE_CALL, f"{summary_prefix}{suffix}", detail)
        except Exception:
            pass

    def _is_active_attempt_locked(self, key: str, attempt: threading.Event) -> bool:
        task = self._tasks.get(key)
        return (
            self._active_attempts.get(key) is attempt
            and not attempt.is_set()
            and task is not None
            and task.get("status") in UNFINISHED_STATUSES
        )

    def _update_active_attempt(self, key: str, attempt: threading.Event, **updates: Any) -> bool:
        with self._lock:
            if not self._is_active_attempt_locked(key, attempt):
                return False
            self._update_task(key, **updates)
            return True

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            previous = dict(task)
            previous_stage = _timeline_stage(task)
            previous_status = _clean(task.get("status"))
            task.update(updates)
            now_iso = _now_iso()
            now_ts = time.time()
            task["updated_at"] = now_iso
            task["updated_ts"] = now_ts
            next_stage = _timeline_stage(task)
            next_status = _clean(task.get("status"))
            if next_stage != previous_stage or next_status != previous_status:
                timeline = list(task.get("timeline") or []) if isinstance(task.get("timeline"), list) else []
                detail = _clean(updates.get("progress") or updates.get("error"))[:300]
                timeline.append(
                    {
                        "stage": next_stage,
                        "status": next_status,
                        "created_at": now_iso,
                        "created_ts": now_ts,
                        **({"detail": detail} if detail else {}),
                    }
                )
                task["timeline"] = timeline[-100:]
            try:
                self.store.upsert(task)
            except Exception:
                task.clear()
                task.update(previous)
                raise
            duration_ms = updates.get("duration_ms")
            if updates.get("status") == TASK_STATUS_SUCCESS and isinstance(duration_ms, (int, float)):
                self._recent_durations_secs.append(max(0.1, float(duration_ms) / 1000.0))

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        raw_items = self.store.load_all()
        tasks: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            status = _clean(item.get("status"))
            if status not in {
                TASK_STATUS_QUEUED,
                TASK_STATUS_PAUSED,
                TASK_STATUS_RUNNING,
                TASK_STATUS_SUCCESS,
                TASK_STATUS_ERROR,
            }:
                status = TASK_STATUS_ERROR
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": status,
                "mode": "edit" if item.get("mode") == "edit" else "generate",
                "source": _clean(item.get("source"), "queue"),
                "endpoint": _clean(
                    item.get("endpoint"),
                    "/api/image-tasks/edits"
                    if item.get("mode") == "edit"
                    else "/api/image-tasks/generations",
                ),
                "owner_role": _clean(item.get("owner_role"), "user"),
                "owner_name": _clean(item.get("owner_name")),
                "owner_group": _clean(item.get("owner_group"), "default"),
                "credit_reserved": bool(item.get("credit_reserved", False)),
                "project_budget_reserved": bool(item.get("project_budget_reserved", False)),
                "model": _clean(item.get("model"), "gpt-image-2"),
                "size": _clean(item.get("size")),
                "quality": _clean(item.get("quality"), "auto"),
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
                "created_ts": item.get("created_ts"),
                "updated_ts": item.get("updated_ts"),
                "started_ts": item.get("started_ts"),
                "duration_ms": item.get("duration_ms"),
                "priority": _priority(item.get("priority")),
                "resume_count": _nonnegative_int(item.get("resume_count")),
                "last_checkpoint": _clean(item.get("last_checkpoint")),
            }
            if item.get("request_n") is not None:
                task["request_n"] = max(1, min(4, _nonnegative_int(item.get("request_n"), maximum=4) or 1))
            if item.get("response_format"):
                task["response_format"] = _clean(item.get("response_format"))
            if item.get("caller_key_id"):
                task["caller_key_id"] = _clean(item.get("caller_key_id"))
            if item.get("caller_key_name"):
                task["caller_key_name"] = _clean(item.get("caller_key_name"))
            if item.get("result_count") is not None:
                task["result_count"] = _nonnegative_int(item.get("result_count"), maximum=100)
            timeline = item.get("timeline")
            if isinstance(timeline, list):
                task["timeline"] = [dict(entry) for entry in timeline[-100:] if isinstance(entry, dict)]
            workflow = item.get("workflow")
            if isinstance(workflow, dict):
                task["workflow"] = dict(workflow)
            data = item.get("data")
            if isinstance(data, list):
                task["data"] = data
            usage = item.get("usage")
            if isinstance(usage, dict):
                task["usage"] = usage
            error = _clean(item.get("error"))
            if error:
                task["error"] = error
            error_code = _clean(item.get("error_code"))
            if not error_code and error:
                error_code = _classify_image_error(None, error)
            if error_code:
                task["error_code"] = error_code
            conversation_id = _clean(item.get("conversation_id"))
            if conversation_id:
                task["conversation_id"] = conversation_id
            account_ref = _clean(item.get("account_ref"))
            if account_ref:
                task["account_ref"] = account_ref
            retry_prompt = _clean(item.get("retry_prompt"))
            prompt = _clean(item.get("prompt"))
            # Old failed generation records only retained retry_prompt. Use it as
            # the display prompt for that same owner; completed legacy records
            # without either field remain intentionally blank.
            if not prompt and task["mode"] == "generate":
                prompt = retry_prompt
            if prompt:
                task["prompt"] = prompt
            if retry_prompt and task["mode"] == "generate":
                task["retry_prompt"] = retry_prompt
            retry_task_id = _clean(item.get("retry_task_id"))
            if retry_task_id:
                task["retry_task_id"] = retry_task_id
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        self.store.replace_all(self._tasks.values())

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        recovered_keys: list[str] = []
        for key, task in list(self._tasks.items()):
            status = task.get("status")
            if status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}:
                continue
            try:
                if status == TASK_STATUS_RUNNING:
                    work = self._rebuild_resume_work(task)
                    checkpoint = "auto_resume_queued"
                    detail = "服务重启后从上游会话检查点继续"
                else:
                    work = self._rebuild_paused_work(task)
                    checkpoint = "recovered_queued"
                    detail = "服务重启后恢复等待任务"
                self._active_attempts[key] = work.attempt
                self._enqueue_work_locked(work)
                self._update_task(
                    key,
                    status=TASK_STATUS_QUEUED,
                    progress="recovered",
                    error="",
                    error_code="",
                    last_checkpoint=checkpoint,
                    resume_count=_nonnegative_int(task.get("resume_count")) + 1,
                    recovery_detail=detail,
                )
                recovered_keys.append(key)
                changed = True
            except Exception as exc:
                module_logger.warning(
                    "image task %s could not be auto-recovered: %s",
                    _clean(task.get("id")),
                    type(exc).__name__,
                )
                self._update_task(
                    key,
                    status=TASK_STATUS_ERROR,
                    error="服务已重启，未完成的图片任务已中断；任务缺少安全恢复检查点，额度已自动退回，可原位重试",
                    error_code="service_restarted",
                    last_checkpoint="recovery_compensated",
                    recovery_detail="unsafe_to_replay",
                )
                changed = True
        if recovered_keys:
            start_error = self._dispatch_locked(trigger_key=recovered_keys[0])
            if start_error is not None:
                module_logger.warning("recovered image task dispatch failed: %s", type(start_error).__name__)
        return changed

    def _reconcile_terminal_credits_locked(self) -> bool:
        changed = False
        for key, task in self._tasks.items():
            if task.get("status") not in TERMINAL_STATUSES:
                continue
            identity = {
                "id": _clean(task.get("owner_id")),
                "role": _clean(task.get("owner_role"), "user"),
            }
            task_id = _clean(task.get("id"))
            task_changed = False
            if task.get("credit_reserved"):
                settled = (
                    self._consume_credit(identity, task_id)
                    if task.get("status") == TASK_STATUS_SUCCESS
                    else self._refund_credit(identity, task_id)
                )
                if settled:
                    task["credit_reserved"] = False
                    task_changed = True
            if task.get("project_budget_reserved"):
                project_settled = self._settle_project_budget_once(
                    key,
                    identity,
                    task_id,
                    success=task.get("status") == TASK_STATUS_SUCCESS,
                    duration_ms=int(task.get("duration_ms") or 0),
                )
                if project_settled:
                    task_changed = True
            if task_changed:
                task["updated_at"] = _now_iso()
                task["updated_ts"] = time.time()
                changed = True
        return changed

    def _clear_credit_reserved_flag(self, key: str) -> None:
        try:
            self._update_task(key, credit_reserved=False)
        except Exception as exc:
            # The terminal task remains durable with credit_reserved=True and will
            # be reconciled idempotently on the next list request or service start.
            module_logger.warning(
                "failed to persist image credit settlement flag: %s",
                type(exc).__name__,
            )

    def _clear_project_budget_reserved_flag(self, key: str) -> None:
        try:
            self._update_task(key, project_budget_reserved=False)
        except Exception as exc:
            module_logger.warning(
                "failed to persist project budget settlement flag: %s",
                type(exc).__name__,
            )

    def _settle_project_budget_once(
        self,
        key: str,
        identity: dict[str, object],
        task_id: str,
        *,
        success: bool,
        duration_ms: int = 0,
    ) -> bool:
        """Claim one terminal project-budget settlement so readers cannot race the worker."""
        with self._lock:
            task = self._tasks.get(key)
            if (
                task is None
                or not task.get("project_budget_reserved")
                or key in self._project_budget_settlements
            ):
                return False
            self._project_budget_settlements.add(key)
        settled = False
        try:
            settled = (
                self._consume_project_budget(identity, task_id, duration_ms)
                if success
                else self._refund_project_budget(identity, task_id)
            )
            return settled
        finally:
            with self._lock:
                if settled:
                    self._clear_project_budget_reserved_flag(key)
                self._project_budget_settlements.discard(key)

    def _reserve_project_budget(
        self,
        identity: dict[str, object],
        project_id: str,
        task_id: str,
    ) -> bool | None:
        if not project_id or self.creative_intelligence_manager is None:
            return None
        return self.creative_intelligence_manager.reserve_project_budget(identity, project_id, task_id)

    def _consume_project_budget(
        self,
        identity: dict[str, object],
        task_id: str,
        duration_ms: int = 0,
    ) -> bool:
        if self.creative_intelligence_manager is None:
            return True
        try:
            return self.creative_intelligence_manager.consume_project_budget(identity, task_id, duration_ms)
        except Exception:
            module_logger.exception("failed to consume project budget for task %s", task_id)
            return False

    def _refund_project_budget(self, identity: dict[str, object], task_id: str) -> bool:
        if self.creative_intelligence_manager is None:
            return True
        try:
            return self.creative_intelligence_manager.refund_project_budget(identity, task_id)
        except Exception:
            module_logger.exception("failed to refund project budget for task %s", task_id)
            return False

    def _notify_batch_completion(self, task: dict[str, Any]) -> None:
        if self.creative_intelligence_manager is None:
            return
        workflow = task.get("workflow") if isinstance(task.get("workflow"), dict) else {}
        batch_id = _clean(workflow.get("batch_id"))
        if not batch_id:
            return
        identity = self._task_identity(task)
        try:
            from services.creative_workspace_service import creative_workspace_service

            task_ids = creative_workspace_service.batch_task_ids(identity, batch_id)
            if not task_ids:
                return
            records = self.list_tasks(identity, task_ids, limit=len(task_ids)).get("items") or []
            if len(records) != len(task_ids) or any(item.get("status") not in TERMINAL_STATUSES for item in records):
                return
            counts = {
                "total": len(records),
                "success": sum(item.get("status") == TASK_STATUS_SUCCESS for item in records),
                "error": sum(item.get("status") == TASK_STATUS_ERROR for item in records),
            }
            self.creative_intelligence_manager.notify_batch_completed(identity, batch_id, counts)
        except Exception:
            module_logger.exception("failed to emit batch completion notification for batch %s", batch_id)

    def _consume_credit(self, identity: dict[str, object], task_id: str) -> bool:
        if not task_id:
            return True
        try:
            self.credit_manager.consume_image_credit(identity, task_id)
        except Exception:
            return False
        return True

    def _refund_credit(self, identity: dict[str, object], task_id: str) -> bool:
        if not task_id:
            return True
        try:
            self.credit_manager.refund_image_credit(identity, task_id)
        except Exception:
            return False
        return True

    def _cleanup_locked(self) -> bool:
        try:
            retention_days = max(1, int(self.retention_days_getter()))
        except Exception:
            retention_days = 30
        cutoff = time.time() - retention_days * 86400
        removed_keys = [
            key
            for key, task in self._tasks.items()
            if task.get("status") in TERMINAL_STATUSES
            and not task.get("credit_reserved")
            and not task.get("project_budget_reserved")
            and _timestamp(task.get("updated_at")) < cutoff
        ]
        for key in removed_keys:
            self._tasks.pop(key, None)
        self.store.delete_many(removed_keys)
        return bool(removed_keys)

    def resume_poll(
        self,
        identity: dict[str, object],
        task_id: str,
        extra_timeout_secs: float = 30.0,
    ) -> dict[str, Any]:
        """Continue an upstream conversation from its persisted checkpoint."""
        owner = _owner_id(identity)
        key = _task_key(owner, _clean(task_id))
        attempt = threading.Event()
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                raise ValueError("task not found")
            if task.get("status") != TASK_STATUS_ERROR:
                raise ValueError("task is not in error state")
            error_code = _clean(task.get("error_code")) or _classify_image_error(
                None,
                _clean(task.get("error")),
            )
            if error_code not in RECOVERABLE_POLL_ERROR_CODES:
                raise ValueError("task error does not support checkpoint recovery")
            conversation_id = _clean(task.get("conversation_id"))
            if not conversation_id:
                raise ValueError("task has no conversation_id")
            account_ref = _clean(task.get("account_ref"))
            if not account_ref:
                raise ValueError("任务缺少原生图账号上下文，请重新生成")
            if not account_service.resolve_image_access_token(account_ref):
                raise ValueError("原生图账号已不可用，无法继续读取该对话，请重新生成")
            _, _, queue_capacity = self._queue_limits()
            if self._pending_count_locked() >= queue_capacity:
                self._queue_rejected_total += 1
                raise ImageQueueFullError(f"图片任务队列已满（上限 {queue_capacity}），请稍后重试")
            mode = task.get("mode", "generate")
            model = task.get("model", "gpt-image-2")
            previous_task = dict(task)
            if task.get("credit_reserved"):
                if not self._refund_credit(identity, _clean(task.get("id"))):
                    raise ValueError("任务额度仍在结算中，请稍后继续等待")
                task["credit_reserved"] = False
                self.store.upsert(task)
                previous_task = dict(task)
            if task.get("project_budget_reserved"):
                if not self._refund_project_budget(identity, _clean(task.get("id"))):
                    raise ValueError("项目额度仍在结算中，请稍后继续等待")
                task["project_budget_reserved"] = False
                self.store.upsert(task)
                previous_task = dict(task)
            reservation = self.credit_manager.reserve_image_credit(identity, _clean(task.get("id")))
            if reservation is False:
                raise ValueError("用户图片额度不足，请联系管理员分配额度")
            credit_reserved = reservation is True
            workflow = task.get("workflow") if isinstance(task.get("workflow"), dict) else {}
            try:
                project_reservation = self._reserve_project_budget(
                    identity,
                    _clean(workflow.get("project_id")),
                    _clean(task.get("id")),
                )
            except Exception:
                if credit_reserved:
                    self._refund_credit(identity, _clean(task.get("id")))
                raise
            if project_reservation is False:
                if credit_reserved:
                    self._refund_credit(identity, _clean(task.get("id")))
                raise ValueError("项目图片额度不足，请联系管理员调整项目预算")
            project_budget_reserved = project_reservation is True
            try:
                self._update_task(
                    key,
                    status=TASK_STATUS_QUEUED,
                    error="",
                    error_code="",
                    credit_reserved=credit_reserved,
                    project_budget_reserved=project_budget_reserved,
                    resume_count=int(task.get("resume_count") or 0) + 1,
                    last_checkpoint="resume_queued",
                )
            except Exception:
                if credit_reserved:
                    self._refund_credit(identity, _clean(task.get("id")))
                if project_budget_reserved:
                    self._refund_project_budget(identity, _clean(task.get("id")))
                raise
            self._active_attempts[key] = attempt
            work = _QueuedImageWork(
                key=key,
                owner_id=owner,
                task_id=_clean(task_id),
                attempt=attempt,
                runner=self._run_resume_poll,
                args=(
                    key,
                    _clean(task_id),
                    conversation_id,
                    account_ref,
                    extra_timeout_secs,
                    dict(identity),
                    mode,
                    model,
                    credit_reserved,
                    attempt,
                ),
                identity=dict(identity),
                credit_reserved=credit_reserved,
                start_failure_restore=previous_task,
            )
            self._enqueue_work_locked(work)
            start_error = self._dispatch_locked(trigger_key=key)
            if start_error is not None:
                raise start_error
            return self._public_task_locked(self._tasks.get(key, task))

    def _run_resume_poll(
        self,
        key: str,
        task_id: str,
        conversation_id: str,
        account_ref: str,
        extra_timeout_secs: float,
        identity: dict[str, object],
        mode: str,
        model: str,
        credit_reserved: bool,
        attempt: threading.Event,
    ) -> None:
        """后台线程：继续轮询已有 conversation_id 的图片结果。"""
        started = time.time()
        backend = None
        try:
            if not self._update_active_attempt(
                key,
                attempt,
                status=TASK_STATUS_RUNNING,
                progress="resume_poll",
                last_checkpoint="resume_polling",
            ):
                return
            from services.openai_backend_api import OpenAIBackendAPI
            from services.protocol.conversation import format_image_result

            access_token = account_service.resolve_image_access_token(account_ref)
            if not access_token:
                raise RuntimeError("原生图账号已不可用，无法继续读取该对话")
            active_token = account_service.refresh_access_token(
                access_token,
                event="resume_image_poll",
            ) or account_service.resolve_access_token(access_token)
            active_token = account_service.resolve_image_access_token(account_ref) or active_token
            if not active_token or account_service.get_account(active_token) is None:
                raise RuntimeError("原生图账号认证已失效，无法继续读取该对话")
            backend = OpenAIBackendAPI(access_token=active_token)
            file_ids, sediment_ids = backend._poll_image_results(
                conversation_id,
                extra_timeout_secs,
            )
            if not file_ids and not sediment_ids:
                raise RuntimeError(
                    f"继续等待 {extra_timeout_secs} 秒后仍未找到图片结果。"
                )

            image_urls = backend.resolve_conversation_image_urls(
                conversation_id, file_ids, sediment_ids, poll=False,
            )
            if not image_urls:
                raise RuntimeError("图片 URL 解析失败")

            image_items = [
                {"b64_json": __import__("base64").b64encode(image_data).decode("ascii")}
                for image_data in backend.download_image_bytes(image_urls)
            ]
            data = format_image_result(
                image_items,
                "",  # prompt 已不重要，结果已经拿到了
                "b64_json",
                "",
                int(time.time()),
            )["data"]
            if not data:
                raise RuntimeError("图片下载结果为空，请稍后重试")
            duration_ms = int((time.time() - started) * 1000)
            completed_task: dict[str, Any] = {}
            with self._lock:
                if not self._is_active_attempt_locked(key, attempt):
                    return
                self._update_task(
                    key,
                    status=TASK_STATUS_SUCCESS,
                    data=data,
                    error="",
                    duration_ms=duration_ms,
                    credit_reserved=credit_reserved,
                    retry_prompt="",
                    error_code="",
                    last_checkpoint="completed",
                )
                if credit_reserved and self._consume_credit(identity, task_id):
                    self._clear_credit_reserved_flag(key)
                completed_task = dict(self._tasks.get(key) or {})
            self._settle_project_budget_once(
                key,
                identity,
                task_id,
                success=True,
                duration_ms=duration_ms,
            )
            if completed_task:
                try:
                    from services.creative_workspace_service import creative_workspace_service

                    versions = creative_workspace_service.record_task_success(completed_task)
                    if versions:
                        with self._lock:
                            current_task = self._tasks.get(key)
                            if current_task is not None:
                                workflow = dict(current_task.get("workflow") or {})
                                workflow["asset_id"] = versions[0].get("asset_id")
                                workflow["version_id"] = versions[0].get("id")
                                current_task["workflow"] = workflow
                                completed_task["workflow"] = dict(workflow)
                                self.store.upsert(current_task)
                        try:
                            if self.creative_operations_manager is not None:
                                self.creative_operations_manager.record_task_provenance(completed_task, versions)
                        except Exception:
                            module_logger.exception("failed to record resumed task provenance for %s", task_id)
                        try:
                            from services.advanced_creative_service import advanced_creative_service

                            for asset_id in {
                                _clean(item.get("asset_id")) for item in versions if _clean(item.get("asset_id"))
                            }:
                                advanced_creative_service.analyze_asset(identity, asset_id)
                        except Exception:
                            module_logger.exception("failed to analyze resumed creative assets for task %s", task_id)
                        try:
                            if self.creative_intelligence_manager is not None:
                                self.creative_intelligence_manager.schedule_asset_intelligence(identity, versions)
                        except Exception:
                            module_logger.exception("failed to schedule resumed creative intelligence for task %s", task_id)
                except Exception:
                    module_logger.exception("failed to archive resumed creative task %s", task_id)
                try:
                    if self.creative_intelligence_manager is not None:
                        self.creative_intelligence_manager.notify_task(completed_task, success=True)
                except Exception:
                    module_logger.exception("failed to notify resumed task success for task %s", task_id)
                self._notify_batch_completion(completed_task)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成（续轮询）",
                status="success",
                urls=_collect_image_urls(data),
            )
        except Exception as exc:
            error_message = str(exc) or "resume poll failed"
            error_code = _classify_image_error(exc, error_message)
            duration_ms = int((time.time() - started) * 1000)
            failed_task: dict[str, Any] = {}
            with self._lock:
                if not self._is_active_attempt_locked(key, attempt):
                    return
                self._update_task(
                    key,
                    status=TASK_STATUS_ERROR,
                    error=error_message,
                    error_code=error_code,
                    data=[],
                    duration_ms=duration_ms,
                    credit_reserved=credit_reserved,
                    last_checkpoint="resume_failed",
                )
                if credit_reserved and self._refund_credit(identity, task_id):
                    self._clear_credit_reserved_flag(key)
                failed_task = dict(self._tasks.get(key) or {})
            self._settle_project_budget_once(key, identity, task_id, success=False)
            try:
                if self.creative_intelligence_manager is not None:
                    self.creative_intelligence_manager.notify_task(failed_task, success=False)
            except Exception:
                module_logger.exception("failed to notify resumed task failure for task %s", task_id)
            self._notify_batch_completion(failed_task)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败（续轮询）",
                status="failed",
                error=error_message,
            )
        finally:
            if backend is not None:
                backend.close()
            with self._lock:
                if self._active_attempts.get(key) is attempt:
                    self._active_attempts.pop(key, None)


image_task_service = ImageTaskService(
    DATA_DIR / "image_tasks.json",
    account_capacity_getter=account_service.image_capacity_snapshot,
    creative_intelligence_manager=creative_intelligence_service,
    creative_operations_manager=creative_operations_service,
)
