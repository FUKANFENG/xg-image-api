from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from services import editable_file_task_service as editable_files
from services.editable_file_task_service import EditableFileTaskService


OWNER = {"id": "user-1", "name": "User One", "role": "user"}
OTHER_USER = {"id": "user-2", "name": "User Two", "role": "user"}


class EditableFileTaskAccessTests(unittest.TestCase):
    def test_only_task_owner_can_resolve_result_file(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory) / "files"
            task_path = root / "ppt" / "private-task"
            task_path.mkdir(parents=True)
            result_path = task_path / "result.pptx"
            result_path.write_bytes(b"pptx")

            with mock.patch.object(editable_files, "EDITABLE_FILE_ROOT", root):
                service = EditableFileTaskService(Path(directory) / "editable_file_tasks.json")
                service._tasks["user-1:private-task"] = {
                    "id": "private-task",
                    "owner_id": "user-1",
                    "kind": "ppt",
                    "status": "success",
                }

                self.assertEqual(
                    service.owned_file_path(OWNER, "ppt/private-task/result.pptx"),
                    result_path.resolve(),
                )
                with self.assertRaises(PermissionError):
                    service.owned_file_path(OTHER_USER, "ppt/private-task/result.pptx")

    def test_rejects_paths_that_do_not_match_task_layout(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory) / "files"
            root.mkdir()

            with mock.patch.object(editable_files, "EDITABLE_FILE_ROOT", root):
                service = EditableFileTaskService(Path(directory) / "editable_file_tasks.json")
                with self.assertRaises(PermissionError):
                    service.owned_file_path(OWNER, "unrelated/result.zip")


if __name__ == "__main__":
    unittest.main()
