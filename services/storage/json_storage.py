from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from services.storage.base import StorageBackend


class JSONStorageError(RuntimeError):
    """JSON 存储内容不可读取或结构不合法。"""


class JSONStorageBackend(StorageBackend):
    """本地 JSON 文件存储后端"""

    def __init__(self, file_path: Path, auth_keys_path: Path | None = None):
        self.file_path = file_path
        self.auth_keys_path = auth_keys_path or file_path.with_name("auth_keys.json")
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        self.auth_keys_path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _load_json_list(file_path: Path, wrapper_key: str | None = None) -> list[dict[str, Any]]:
        if not file_path.exists():
            return []
        try:
            data = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise JSONStorageError(f"无法读取有效 JSON：{file_path}: {exc}") from exc
        if wrapper_key and isinstance(data, dict):
            data = data.get(wrapper_key)
        if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
            raise JSONStorageError(f"JSON 数据结构无效：{file_path} 应包含对象数组")
        return data

    @staticmethod
    def _atomic_write_text(file_path: Path, content: str) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(
            dir=file_path.parent,
            prefix=f".{file_path.name}.",
            suffix=".tmp",
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as temporary_file:
                fd = -1
                temporary_file.write(content)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_path, file_path)
        finally:
            if fd >= 0:
                os.close(fd)
            temporary_path.unlink(missing_ok=True)

    @classmethod
    def _save_json_list(cls, file_path: Path, items: list[dict[str, Any]]) -> None:
        cls._atomic_write_text(
            file_path,
            json.dumps(items, ensure_ascii=False, indent=2) + "\n",
        )

    def load_accounts(self) -> list[dict[str, Any]]:
        """从 JSON 文件加载账号数据"""
        return self._load_json_list(self.file_path)

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        """保存账号数据到 JSON 文件"""
        self._save_json_list(self.file_path, accounts)

    def load_auth_keys(self) -> list[dict[str, Any]]:
        """从 JSON 文件加载鉴权密钥数据"""
        return self._load_json_list(self.auth_keys_path, wrapper_key="items")

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        """保存鉴权密钥数据到 JSON 文件"""
        self._atomic_write_text(
            self.auth_keys_path,
            json.dumps({"items": auth_keys}, ensure_ascii=False, indent=2) + "\n",
        )

    def health_check(self) -> dict[str, Any]:
        """健康检查"""
        try:
            self.load_accounts()
            self.load_auth_keys()
            return {
                "status": "healthy",
                "backend": "json",
                "file_exists": self.file_path.exists(),
                "file_path": str(self.file_path),
                "auth_keys_file_exists": self.auth_keys_path.exists(),
                "auth_keys_file_path": str(self.auth_keys_path),
            }
        except Exception as e:
            return {
                "status": "unhealthy",
                "backend": "json",
                "error": str(e),
            }

    def get_backend_info(self) -> dict[str, Any]:
        """获取存储后端信息"""
        return {
            "type": "json",
            "description": "本地 JSON 文件存储",
            "file_path": str(self.file_path),
            "file_exists": self.file_path.exists(),
            "auth_keys_file_path": str(self.auth_keys_path),
            "auth_keys_file_exists": self.auth_keys_path.exists(),
        }
