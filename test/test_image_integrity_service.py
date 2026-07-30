from __future__ import annotations

import unittest

from services.image_integrity_service import ImageIntegrityService


OWNER = {"id": "owner-1", "role": "user"}


class FakeWorkspace:
    def __init__(self, references):
        self.references = references

    def list_image_references(self, _identity, *, include_all=False):
        return list(self.references)


class FakeStorage:
    def __init__(self, mode: str, statuses: dict[str, dict[str, object]]):
        self.storage_mode = mode
        self.statuses = statuses

    def mode(self):
        return self.storage_mode

    def inspect_paths(self, paths):
        return [dict(self.statuses[path]) for path in paths]

    def restore_local(self, path):
        self.statuses[path].update(
            local=True,
            remote=True,
            exists=True,
            recoverable=False,
            backed_up=True,
            invalid_local=False,
            storage="both",
        )
        return dict(self.statuses[path])

    def backup_paths(self, paths):
        for path in paths:
            self.statuses[path].update(remote=True, backed_up=True, storage="both")
        return {"uploaded": list(paths), "skipped": [], "failed": []}


def status(path: str, *, local: bool, remote: bool, valid: bool = True):
    exists = (local and valid) or remote
    return {
        "path": path,
        "exists": exists,
        "local": local and valid,
        "remote": remote,
        "recoverable": not (local and valid) and remote,
        "backed_up": local and valid and remote,
        "invalid_local": local and not valid,
        "storage": "both" if local and remote else "local" if local else "webdav" if remote else "missing",
    }


class ImageIntegrityServiceTests(unittest.TestCase):
    def test_local_mode_does_not_report_healthy_local_images_as_problems(self):
        path = "2026/07/27/local.png"
        service = ImageIntegrityService(
            FakeWorkspace([{"asset_id": "a1", "asset_name": "本地图", "image_path": path}]),
            FakeStorage("local", {path: status(path, local=True, remote=False)}),
            cache_ttl_secs=0,
        )

        report = service.scan(OWNER)

        self.assertEqual(report["summary"]["missing"], 0)
        self.assertEqual(report["problems"], [])

    def test_repair_restores_remote_only_and_backs_up_local_only(self):
        remote_path = "2026/07/27/remote.png"
        local_path = "2026/07/27/local.png"
        workspace = FakeWorkspace([
            {"asset_id": "a1", "asset_name": "远端图", "image_path": remote_path},
            {"asset_id": "a2", "asset_name": "本地图", "image_path": local_path},
        ])
        storage = FakeStorage(
            "both",
            {
                remote_path: status(remote_path, local=False, remote=True),
                local_path: status(local_path, local=True, remote=False),
            },
        )
        service = ImageIntegrityService(workspace, storage, cache_ttl_secs=0)

        result = service.repair(OWNER)

        self.assertEqual(result["restored"], [remote_path])
        self.assertEqual(result["backed_up"], [local_path])
        self.assertEqual(result["after"]["missing"], 0)
        self.assertEqual(result["problems"], [])


if __name__ == "__main__":
    unittest.main()
