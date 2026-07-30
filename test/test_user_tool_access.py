from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest import mock

from fastapi import HTTPException

from api import support
from services.config import ConfigStore


class UserToolSettingsTests(unittest.TestCase):
    def test_defaults_are_enabled_and_updates_are_normalized(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"auth-key": "test-key"}), encoding="utf-8")
            store = ConfigStore(path)

            self.assertEqual(store.get_user_tools_settings(), {"search": True, "ppt": True, "psd": True})

            saved = store.update({"user_tools": {"search": False, "ppt": "on", "psd": "off"}})

            self.assertEqual(saved["user_tools"], {"search": False, "ppt": True, "psd": False})
            self.assertFalse(store.is_user_tool_enabled("search"))
            self.assertTrue(store.is_user_tool_enabled("ppt"))
            self.assertFalse(store.is_user_tool_enabled("psd"))


class UserToolAccessTests(unittest.TestCase):
    def test_disabled_tool_blocks_user_server_side(self) -> None:
        user = {"id": "user-1", "name": "普通用户", "role": "user"}
        disabled_config = SimpleNamespace(is_user_tool_enabled=lambda _tool: False)

        with mock.patch.object(support, "require_identity", return_value=user), mock.patch.object(support, "config", disabled_config):
            with self.assertRaises(HTTPException) as context:
                support.require_user_tool("Bearer test", "ppt")

        self.assertEqual(context.exception.status_code, 403)
        self.assertIn("PPT", str(context.exception.detail))

    def test_admin_bypasses_user_tool_toggle(self) -> None:
        admin = {"id": "admin", "name": "管理员", "role": "admin"}
        disabled_config = SimpleNamespace(is_user_tool_enabled=lambda _tool: False)

        with mock.patch.object(support, "require_identity", return_value=admin), mock.patch.object(support, "config", disabled_config):
            self.assertEqual(support.require_user_tool("Bearer test", "search"), admin)

    def test_enabled_tool_allows_user(self) -> None:
        user = {"id": "user-1", "name": "普通用户", "role": "user"}
        enabled_config = SimpleNamespace(is_user_tool_enabled=lambda _tool: True)

        with mock.patch.object(support, "require_identity", return_value=user), mock.patch.object(support, "config", enabled_config):
            self.assertEqual(support.require_user_tool("Bearer test", "psd"), user)


if __name__ == "__main__":
    unittest.main()
