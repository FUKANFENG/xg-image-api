from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Literal

from services.config import config
from services.storage.base import StorageBackend

AuthRole = Literal["admin", "user"]

_USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$")
_PASSWORD_MIN_LENGTH = 8
_PASSWORD_MAX_LENGTH = 128
_PASSWORD_SCRYPT_N = 2**14
_PASSWORD_SCRYPT_R = 8
_PASSWORD_SCRYPT_P = 1
_PASSWORD_SCRYPT_DKLEN = 32
_SESSION_TTL = timedelta(hours=12)
_IMAGE_CREDIT_LEDGER_LIMIT = 20_000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}")


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_PASSWORD_SCRYPT_N,
        r=_PASSWORD_SCRYPT_R,
        p=_PASSWORD_SCRYPT_P,
        dklen=_PASSWORD_SCRYPT_DKLEN,
    )
    return "$".join(
        [
            "scrypt",
            str(_PASSWORD_SCRYPT_N),
            str(_PASSWORD_SCRYPT_R),
            str(_PASSWORD_SCRYPT_P),
            _b64encode(salt),
            _b64encode(digest),
        ]
    )


def _verify_password(password: str, password_hash: str) -> bool:
    try:
        algorithm, n, r, p, encoded_salt, encoded_digest = password_hash.split("$", 5)
        if algorithm != "scrypt":
            return False
        expected = _b64decode(encoded_digest)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_b64decode(encoded_salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError, UnicodeError):
        return False


class AuthService:
    def __init__(
        self,
        storage: StorageBackend,
        *,
        session_secret_getter: Callable[[], str] | None = None,
    ):
        self.storage = storage
        self._session_secret_getter = session_secret_getter or (lambda: str(config.auth_key or ""))
        self._lock = Lock()
        self._items = self._load()
        self._last_used_flush_at: dict[str, datetime] = {}

    @staticmethod
    def _clean(value: object) -> str:
        return str(value or "").strip()

    @classmethod
    def _normalize_username(cls, value: object) -> str:
        username = cls._clean(value).lower()
        if not _USERNAME_PATTERN.fullmatch(username):
            raise ValueError("用户名需为 3–32 位字母、数字、点、下划线或连字符，且必须以字母或数字开头")
        return username

    @classmethod
    def _validate_password(cls, value: object) -> str:
        password = str(value or "")
        if len(password) < _PASSWORD_MIN_LENGTH:
            raise ValueError(f"密码至少需要 {_PASSWORD_MIN_LENGTH} 位")
        if len(password) > _PASSWORD_MAX_LENGTH:
            raise ValueError(f"密码不能超过 {_PASSWORD_MAX_LENGTH} 位")
        return password

    @classmethod
    def _nonnegative_int(cls, value: object, *, default: int = 0) -> int:
        try:
            return max(0, int(value if value is not None else default))
        except (TypeError, ValueError):
            return default

    @classmethod
    def _normalize_credit_ledger(cls, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list):
            return []
        result: list[dict[str, object]] = []
        for raw in value[-_IMAGE_CREDIT_LEDGER_LIMIT:]:
            if not isinstance(raw, dict):
                continue
            action = cls._clean(raw.get("action")).lower()
            task_id = cls._clean(raw.get("task_id"))
            created_at = cls._clean(raw.get("created_at"))
            if action not in {"allocate", "adjust", "reserve", "consume", "refund"} or not created_at:
                continue
            try:
                amount = int(raw.get("amount") or 0)
            except (TypeError, ValueError):
                amount = 0
            result.append(
                {
                    "id": cls._clean(raw.get("id")) or uuid.uuid4().hex,
                    "task_id": task_id,
                    "action": action,
                    "amount": amount,
                    "balance_before": cls._nonnegative_int(raw.get("balance_before")),
                    "balance_after": cls._nonnegative_int(raw.get("balance_after")),
                    "used_before": cls._nonnegative_int(raw.get("used_before")),
                    "used_after": cls._nonnegative_int(raw.get("used_after")),
                    "reason": cls._clean(raw.get("reason"))[:300],
                    "created_at": created_at,
                }
            )
        return result

    @classmethod
    def _append_credit_event(
        cls,
        item: dict[str, object],
        *,
        task_id: str,
        action: str,
        balance_before: int,
        balance_after: int,
        used_before: int,
        used_after: int,
        reason: str = "",
    ) -> None:
        normalized_task_id = cls._clean(task_id)
        normalized_action = cls._clean(action).lower()
        ledger = cls._normalize_credit_ledger(item.get("image_credit_ledger"))
        if normalized_task_id and any(
            event.get("task_id") == normalized_task_id and event.get("action") == normalized_action
            for event in ledger
        ):
            item["image_credit_ledger"] = ledger
            return
        ledger.append(
            {
                "id": uuid.uuid4().hex,
                "task_id": normalized_task_id,
                "action": normalized_action,
                "amount": int(balance_after) - int(balance_before),
                "balance_before": max(0, int(balance_before)),
                "balance_after": max(0, int(balance_after)),
                "used_before": max(0, int(used_before)),
                "used_after": max(0, int(used_after)),
                "reason": cls._clean(reason)[:300],
                "created_at": _now_iso(),
            }
        )
        item["image_credit_ledger"] = ledger[-_IMAGE_CREDIT_LEDGER_LIMIT:]

    @staticmethod
    def _default_name(role: object) -> str:
        return "管理员密钥" if str(role or "").strip().lower() == "admin" else "普通用户"

    def _normalize_item(self, raw: object) -> dict[str, object] | None:
        if not isinstance(raw, dict):
            return None
        role = self._clean(raw.get("role")).lower()
        if role not in {"admin", "user"}:
            return None

        key_hash = self._clean(raw.get("key_hash"))
        username = self._clean(raw.get("username")).lower()
        password_hash = self._clean(raw.get("password_hash"))
        if username and not _USERNAME_PATTERN.fullmatch(username):
            return None
        if password_hash and not username:
            return None
        if not key_hash and not password_hash:
            return None

        raw_reservations = raw.get("image_credit_reservations")
        reservations: list[str] = []
        if isinstance(raw_reservations, list):
            reservations = list(dict.fromkeys(self._clean(item) for item in raw_reservations if self._clean(item)))

        item_id = self._clean(raw.get("id")) or uuid.uuid4().hex[:12]
        name = self._clean(raw.get("name")) or username or self._default_name(role)
        created_at = self._clean(raw.get("created_at")) or _now_iso()
        last_used_at = self._clean(raw.get("last_used_at")) or None
        return {
            "id": item_id,
            "name": name,
            "role": role,
            "group": (self._clean(raw.get("group")) or "default") if role == "user" else "admin",
            "key_hash": key_hash,
            "username": username,
            "password_hash": password_hash,
            "enabled": bool(raw.get("enabled", True)),
            "image_quota": self._nonnegative_int(raw.get("image_quota")),
            "image_quota_used": self._nonnegative_int(raw.get("image_quota_used")),
            "image_credit_reservations": reservations,
            "image_credit_ledger": self._normalize_credit_ledger(raw.get("image_credit_ledger")),
            "session_version": max(1, self._nonnegative_int(raw.get("session_version"), default=1)),
            "created_at": created_at,
            "last_used_at": last_used_at,
        }

    def _load(self) -> list[dict[str, object]]:
        try:
            items = self.storage.load_auth_keys()
        except Exception:
            return []
        if not isinstance(items, list):
            return []
        return [normalized for item in items if (normalized := self._normalize_item(item)) is not None]

    def _save(self) -> None:
        self.storage.save_auth_keys(self._items)

    def _reload_locked(self) -> None:
        self._items = self._load()

    @classmethod
    def _public_item(cls, item: dict[str, object]) -> dict[str, object]:
        return {
            "id": item.get("id"),
            "name": item.get("name"),
            "username": item.get("username") or None,
            "role": item.get("role"),
            "group": item.get("group") or ("default" if item.get("role") == "user" else "admin"),
            "enabled": bool(item.get("enabled", True)),
            "image_quota": cls._nonnegative_int(item.get("image_quota")),
            "image_quota_used": cls._nonnegative_int(item.get("image_quota_used")),
            "password_configured": bool(cls._clean(item.get("password_hash"))),
            "legacy_key_enabled": bool(cls._clean(item.get("key_hash"))),
            "created_at": item.get("created_at"),
            "last_used_at": item.get("last_used_at"),
        }

    @classmethod
    def _identity_from_item(cls, item: dict[str, object]) -> dict[str, object]:
        identity = {
            "id": cls._clean(item.get("id")),
            "name": cls._clean(item.get("name")),
            "role": cls._clean(item.get("role")),
            "group": cls._clean(item.get("group")) or "default",
            "session_version": cls._nonnegative_int(item.get("session_version"), default=1),
            "last_used_at": item.get("last_used_at"),
        }
        if identity["role"] == "user" and cls._clean(item.get("password_hash")):
            identity["image_quota"] = cls._nonnegative_int(item.get("image_quota"))
        return identity

    def list_keys(self, role: AuthRole | None = None) -> list[dict[str, object]]:
        with self._lock:
            self._reload_locked()
            items = [item for item in self._items if role is None or item.get("role") == role]
            return [self._public_item(item) for item in items]

    def list_users(self) -> list[dict[str, object]]:
        return self.list_keys(role="user")

    def _find_item_index_locked(self, item_id: str, *, role: AuthRole | None = None) -> int | None:
        normalized_id = self._clean(item_id)
        for index, item in enumerate(self._items):
            if self._clean(item.get("id")) != normalized_id:
                continue
            if role is not None and item.get("role") != role:
                continue
            return index
        return None

    def _has_key_hash_locked(self, key_hash: str, *, exclude_id: str = "") -> bool:
        for item in self._items:
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            stored_hash = self._clean(item.get("key_hash"))
            if stored_hash and hmac.compare_digest(stored_hash, key_hash):
                return True
        return False

    def _build_key_hash_locked(self, raw_key: str, *, exclude_id: str = "") -> str:
        candidate = self._clean(raw_key)
        if not candidate:
            raise ValueError("请输入新的专用密钥")
        admin_key = self._clean(config.auth_key)
        if admin_key and hmac.compare_digest(candidate, admin_key):
            raise ValueError("这个密钥和管理员密钥冲突了，请换一个新的密钥")
        key_hash = _hash_key(candidate)
        if self._has_key_hash_locked(key_hash, exclude_id=exclude_id):
            raise ValueError("这个专用密钥已经存在，请换一个新的密钥")
        return key_hash

    def _has_name_locked(self, name: str, *, role: AuthRole | None = None, exclude_id: str = "") -> bool:
        candidate = self._clean(name)
        if not candidate:
            return False
        for item in self._items:
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            if role is not None and item.get("role") != role:
                continue
            if self._clean(item.get("name")) == candidate:
                return True
        return False

    def _build_default_name_locked(self, role: AuthRole, *, exclude_id: str = "") -> str:
        base_name = self._default_name(role)
        if not self._has_name_locked(base_name, role=role, exclude_id=exclude_id):
            return base_name
        suffix = 2
        while True:
            candidate = f"{base_name} {suffix}"
            if not self._has_name_locked(candidate, role=role, exclude_id=exclude_id):
                return candidate
            suffix += 1

    def _build_name_locked(self, name: str, *, role: AuthRole, exclude_id: str = "") -> str:
        candidate = self._clean(name)
        if not candidate:
            return self._build_default_name_locked(role, exclude_id=exclude_id)
        if self._has_name_locked(candidate, role=role, exclude_id=exclude_id):
            raise ValueError("这个名称已经在使用中了，换一个更容易区分的名称吧")
        return candidate

    def _has_username_locked(self, username: str, *, exclude_id: str = "") -> bool:
        candidate = self._clean(username).lower()
        for item in self._items:
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            if item.get("role") != "user":
                continue
            if self._clean(item.get("username")).lower() == candidate:
                return True
        return False

    def _build_username_locked(self, username: object, *, exclude_id: str = "") -> str:
        candidate = self._normalize_username(username)
        if candidate == "admin":
            raise ValueError("admin 是保留的管理员账号名，请使用其他登录账号")
        if self._has_username_locked(candidate, exclude_id=exclude_id):
            raise ValueError("这个登录账号已经存在，请换一个用户名")
        return candidate

    def _touch_item_locked(self, index: int) -> dict[str, object]:
        item = dict(self._items[index])
        now = datetime.now(timezone.utc)
        item["last_used_at"] = now.isoformat()
        self._items[index] = item
        item_id = self._clean(item.get("id"))
        last_flush_at = self._last_used_flush_at.get(item_id)
        if last_flush_at is None or (now - last_flush_at).total_seconds() >= 60:
            try:
                self._save()
                self._last_used_flush_at[item_id] = now
            except Exception:
                pass
        return item

    def create_key(self, *, role: AuthRole, name: str = "") -> tuple[dict[str, object], str]:
        """保留旧 API 密钥能力，供已有集成迁移；新网页用户不再调用该方法。"""
        with self._lock:
            self._reload_locked()
            normalized_name = self._build_name_locked(name, role=role)
            while True:
                raw_key = f"sk-{secrets.token_urlsafe(24)}"
                try:
                    key_hash = self._build_key_hash_locked(raw_key)
                    break
                except ValueError:
                    continue
            item = {
                "id": uuid.uuid4().hex[:12],
                "name": normalized_name,
                "role": role,
                "key_hash": key_hash,
                "username": "",
                "password_hash": "",
                "enabled": True,
                "image_quota": 0,
                "image_quota_used": 0,
                "image_credit_reservations": [],
                "image_credit_ledger": [],
                "session_version": 1,
                "created_at": _now_iso(),
                "last_used_at": None,
            }
            self._items.append(item)
            self._save()
            return self._public_item(item), raw_key

    def create_user(
        self,
        *,
        username: str,
        password: str,
        name: str = "",
        image_quota: int = 0,
        group: str = "default",
    ) -> dict[str, object]:
        with self._lock:
            self._reload_locked()
            normalized_username = self._build_username_locked(username)
            normalized_name = self._build_name_locked(name or normalized_username, role="user")
            normalized_password = self._validate_password(password)
            item = {
                "id": uuid.uuid4().hex[:12],
                "name": normalized_name,
                "role": "user",
                "group": (self._clean(group) or "default")[:40],
                "key_hash": "",
                "username": normalized_username,
                "password_hash": _hash_password(normalized_password),
                "enabled": True,
                "image_quota": self._nonnegative_int(image_quota),
                "image_quota_used": 0,
                "image_credit_reservations": [],
                "image_credit_ledger": [],
                "session_version": 1,
                "created_at": _now_iso(),
                "last_used_at": None,
            }
            if int(item["image_quota"]) > 0:
                self._append_credit_event(
                    item,
                    task_id=f"allocation:{item['id']}",
                    action="allocate",
                    balance_before=0,
                    balance_after=int(item["image_quota"]),
                    used_before=0,
                    used_after=0,
                    reason="新用户初始额度",
                )
            self._items.append(item)
            self._save()
            return self._public_item(item)

    def update_key(
        self,
        key_id: str,
        updates: dict[str, object],
        *,
        role: AuthRole | None = None,
    ) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return None
        with self._lock:
            self._reload_locked()
            index = self._find_item_index_locked(normalized_id, role=role)
            if index is None:
                return None
            item = self._items[index]
            next_item = dict(item)
            next_role: AuthRole = "admin" if str(next_item.get("role") or "").strip().lower() == "admin" else "user"
            if "name" in updates and updates.get("name") is not None:
                next_item["name"] = self._build_name_locked(
                    str(updates.get("name") or ""),
                    role=next_role,
                    exclude_id=normalized_id,
                )
            if "enabled" in updates and updates.get("enabled") is not None:
                next_item["enabled"] = bool(updates.get("enabled"))
                next_item["session_version"] = self._nonnegative_int(next_item.get("session_version"), default=1) + 1
            if "key" in updates and updates.get("key") is not None:
                next_item["key_hash"] = self._build_key_hash_locked(str(updates.get("key") or ""), exclude_id=normalized_id)
            self._items[index] = next_item
            self._save()
            return self._public_item(next_item)

    def update_user(self, user_id: str, updates: dict[str, object]) -> dict[str, object] | None:
        normalized_id = self._clean(user_id)
        if not normalized_id:
            return None
        with self._lock:
            self._reload_locked()
            index = self._find_item_index_locked(normalized_id, role="user")
            if index is None:
                return None
            next_item = dict(self._items[index])
            if "name" in updates and updates.get("name") is not None:
                next_item["name"] = self._build_name_locked(
                    str(updates.get("name") or ""),
                    role="user",
                    exclude_id=normalized_id,
                )
            if "username" in updates and updates.get("username") is not None:
                next_item["username"] = self._build_username_locked(updates.get("username"), exclude_id=normalized_id)
            if "image_quota" in updates and updates.get("image_quota") is not None:
                previous_quota = self._nonnegative_int(next_item.get("image_quota"))
                next_quota = self._nonnegative_int(updates.get("image_quota"))
                next_item["image_quota"] = next_quota
                if next_quota != previous_quota:
                    used = self._nonnegative_int(next_item.get("image_quota_used"))
                    self._append_credit_event(
                        next_item,
                        task_id=f"adjust:{uuid.uuid4().hex}",
                        action="adjust",
                        balance_before=previous_quota,
                        balance_after=next_quota,
                        used_before=used,
                        used_after=used,
                        reason="管理员调整额度",
                    )
            if "group" in updates and updates.get("group") is not None:
                next_item["group"] = self._clean(updates.get("group"), "default")[:40]
            should_bump_session = False
            if "enabled" in updates and updates.get("enabled") is not None:
                next_item["enabled"] = bool(updates.get("enabled"))
                should_bump_session = True
            if "password" in updates and updates.get("password") is not None:
                if not self._clean(next_item.get("username")):
                    raise ValueError("旧用户密钥迁移为账号密码时，请同时设置登录账号")
                next_item["password_hash"] = _hash_password(self._validate_password(updates.get("password")))
                should_bump_session = True
            if should_bump_session:
                next_item["session_version"] = self._nonnegative_int(next_item.get("session_version"), default=1) + 1
            self._items[index] = next_item
            self._save()
            return self._public_item(next_item)

    def delete_key(self, key_id: str, *, role: AuthRole | None = None) -> bool:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return False
        with self._lock:
            self._reload_locked()
            before = len(self._items)
            self._items = [
                item
                for item in self._items
                if not (item.get("id") == normalized_id and (role is None or item.get("role") == role))
            ]
            if len(self._items) == before:
                return False
            self._save()
            return True

    def authenticate_key(self, raw_key: str) -> dict[str, object] | None:
        candidate = self._clean(raw_key)
        if not candidate:
            return None
        candidate_hash = _hash_key(candidate)
        with self._lock:
            self._reload_locked()
            for index, item in enumerate(self._items):
                if not bool(item.get("enabled", True)):
                    continue
                stored_hash = self._clean(item.get("key_hash"))
                if not stored_hash or not hmac.compare_digest(stored_hash, candidate_hash):
                    continue
                return self._identity_from_item(self._touch_item_locked(index))
        return None

    def authenticate(self, raw_key: str) -> dict[str, object] | None:
        return self.authenticate_key(raw_key)

    def authenticate_password(self, username: str, password: str) -> dict[str, object] | None:
        try:
            normalized_username = self._normalize_username(username)
        except ValueError:
            return None
        candidate_password = str(password or "")
        if not candidate_password:
            return None
        with self._lock:
            self._reload_locked()
            for index, item in enumerate(self._items):
                if item.get("role") != "user" or not bool(item.get("enabled", True)):
                    continue
                if self._clean(item.get("username")).lower() != normalized_username:
                    continue
                password_hash = self._clean(item.get("password_hash"))
                if not password_hash or not _verify_password(candidate_password, password_hash):
                    return None
                return self._identity_from_item(self._touch_item_locked(index))
        return None

    def _session_secret(self) -> bytes:
        secret = self._clean(self._session_secret_getter())
        if not secret:
            raise ValueError("管理员认证密码尚未配置，无法创建登录会话")
        return secret.encode("utf-8")

    def create_session(self, identity: dict[str, object]) -> str:
        role = self._clean(identity.get("role"))
        subject_id = self._clean(identity.get("id"))
        if role not in {"admin", "user"} or not subject_id:
            raise ValueError("登录身份无效")
        now = datetime.now(timezone.utc)
        payload = {
            "sub": subject_id,
            "role": role,
            "ver": self._nonnegative_int(identity.get("session_version"), default=1),
            "iat": int(now.timestamp()),
            "exp": int((now + _SESSION_TTL).timestamp()),
        }
        encoded_payload = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        signature = _b64encode(hmac.new(self._session_secret(), encoded_payload.encode("ascii"), hashlib.sha256).digest())
        return f"v1.{encoded_payload}.{signature}"

    def authenticate_session(self, token: str) -> dict[str, object] | None:
        try:
            version, encoded_payload, encoded_signature = self._clean(token).split(".", 2)
            if version != "v1":
                return None
            expected = hmac.new(self._session_secret(), encoded_payload.encode("ascii"), hashlib.sha256).digest()
            if not hmac.compare_digest(expected, _b64decode(encoded_signature)):
                return None
            payload = json.loads(_b64decode(encoded_payload).decode("utf-8"))
            if not isinstance(payload, dict) or int(payload.get("exp") or 0) <= int(datetime.now(timezone.utc).timestamp()):
                return None
            role = self._clean(payload.get("role"))
            subject_id = self._clean(payload.get("sub"))
            if role == "admin" and subject_id == "admin":
                return {"id": "admin", "name": "管理员", "role": "admin", "session_version": 1}
            if role != "user":
                return None
            with self._lock:
                self._reload_locked()
                index = self._find_item_index_locked(subject_id, role="user")
                if index is None:
                    return None
                item = self._items[index]
                if not bool(item.get("enabled", True)) or not self._clean(item.get("password_hash")):
                    return None
                if self._nonnegative_int(item.get("session_version"), default=1) != self._nonnegative_int(payload.get("ver"), default=1):
                    return None
                return self._identity_from_item(item)
        except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
            return None

    def get_image_quota(self, identity: dict[str, object]) -> int | None:
        if self._clean(identity.get("role")) != "user":
            return None
        with self._lock:
            self._reload_locked()
            index = self._find_item_index_locked(self._clean(identity.get("id")), role="user")
            if index is None:
                return None
            item = self._items[index]
            if not self._clean(item.get("password_hash")):
                return None
            return self._nonnegative_int(item.get("image_quota"))

    def reserve_image_credit(self, identity: dict[str, object], task_id: str) -> bool | None:
        if self._clean(identity.get("role")) != "user":
            return None
        normalized_task_id = self._clean(task_id)
        if not normalized_task_id:
            return False
        with self._lock:
            self._reload_locked()
            index = self._find_item_index_locked(self._clean(identity.get("id")), role="user")
            if index is None:
                return None
            item = self._items[index]
            if not self._clean(item.get("password_hash")):
                return None
            if not bool(item.get("enabled", True)):
                return False
            reservations = list(item.get("image_credit_reservations") or [])
            if normalized_task_id in reservations:
                return True
            quota = self._nonnegative_int(item.get("image_quota"))
            if quota < 1:
                return False
            next_item = dict(item)
            next_item["image_quota"] = quota - 1
            next_item["image_credit_reservations"] = [*reservations, normalized_task_id]
            used = self._nonnegative_int(item.get("image_quota_used"))
            self._append_credit_event(
                next_item,
                task_id=normalized_task_id,
                action="reserve",
                balance_before=quota,
                balance_after=quota - 1,
                used_before=used,
                used_after=used,
                reason="图片任务预扣",
            )
            self._items[index] = next_item
            self._save()
            return True

    def refund_image_credit(self, identity: dict[str, object], task_id: str) -> bool:
        return self._refund_image_credit_by_id(self._clean(identity.get("id")), task_id)

    def refund_image_credit_by_id(self, user_id: str, task_id: str) -> bool:
        return self._refund_image_credit_by_id(user_id, task_id)

    def _refund_image_credit_by_id(self, user_id: str, task_id: str) -> bool:
        normalized_task_id = self._clean(task_id)
        if not user_id or not normalized_task_id:
            return False
        with self._lock:
            self._reload_locked()
            index = self._find_item_index_locked(user_id, role="user")
            if index is None:
                return False
            item = self._items[index]
            reservations = list(item.get("image_credit_reservations") or [])
            if normalized_task_id not in reservations:
                return False
            next_item = dict(item)
            quota = self._nonnegative_int(item.get("image_quota"))
            next_item["image_quota"] = quota + 1
            next_item["image_credit_reservations"] = [reservation for reservation in reservations if reservation != normalized_task_id]
            used = self._nonnegative_int(item.get("image_quota_used"))
            self._append_credit_event(
                next_item,
                task_id=normalized_task_id,
                action="refund",
                balance_before=quota,
                balance_after=quota + 1,
                used_before=used,
                used_after=used,
                reason="图片任务失败或取消退回",
            )
            self._items[index] = next_item
            self._save()
            return True

    def consume_image_credit(self, identity: dict[str, object], task_id: str) -> bool:
        normalized_task_id = self._clean(task_id)
        if self._clean(identity.get("role")) != "user" or not normalized_task_id:
            return False
        with self._lock:
            self._reload_locked()
            index = self._find_item_index_locked(self._clean(identity.get("id")), role="user")
            if index is None:
                return False
            item = self._items[index]
            reservations = list(item.get("image_credit_reservations") or [])
            if normalized_task_id not in reservations:
                return False
            next_item = dict(item)
            next_item["image_credit_reservations"] = [reservation for reservation in reservations if reservation != normalized_task_id]
            quota = self._nonnegative_int(item.get("image_quota"))
            used = self._nonnegative_int(item.get("image_quota_used"))
            next_item["image_quota_used"] = used + 1
            self._append_credit_event(
                next_item,
                task_id=normalized_task_id,
                action="consume",
                balance_before=quota,
                balance_after=quota,
                used_before=used,
                used_after=used + 1,
                reason="图片任务成功核销",
            )
            self._items[index] = next_item
            self._save()
            return True

    def list_image_credit_events(
        self,
        identity: dict[str, object],
        *,
        owner_id: str = "",
        action: str = "",
        task_id: str = "",
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, object]:
        requester = self._clean(identity.get("id"))
        is_admin = self._clean(identity.get("role")).lower() in {"admin", "administrator"}
        target = self._clean(owner_id) if is_admin else requester
        normalized_action = self._clean(action).lower()
        normalized_task_id = self._clean(task_id)
        with self._lock:
            self._reload_locked()
            items: list[dict[str, object]] = []
            for user in self._items:
                if user.get("role") != "user":
                    continue
                user_id = self._clean(user.get("id"))
                if target and user_id != target:
                    continue
                for event in self._normalize_credit_ledger(user.get("image_credit_ledger")):
                    if normalized_action and event.get("action") != normalized_action:
                        continue
                    if normalized_task_id and event.get("task_id") != normalized_task_id:
                        continue
                    items.append(
                        {
                            **event,
                            "owner_id": user_id,
                            "owner_name": self._clean(user.get("name")) or self._clean(user.get("username")),
                            "username": self._clean(user.get("username")) or None,
                        }
                    )
        items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        page_limit = max(1, min(int(limit), 200))
        page_offset = max(0, int(offset))
        return {
            "items": items[page_offset : page_offset + page_limit],
            "pagination": {"limit": page_limit, "offset": page_offset, "total": len(items)},
        }


auth_service = AuthService(config.get_storage_backend())
