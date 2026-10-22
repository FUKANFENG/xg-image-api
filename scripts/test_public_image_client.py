"""Offline contract/safety tests for the downloadable public client; no quotas used."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

CLIENT_PATH = Path(__file__).resolve().parents[1] / "web/public/docs/xg_image_client.py"
spec = importlib.util.spec_from_file_location("public_image_client", CLIENT_PATH)
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)


class PublicImageClientTests(unittest.TestCase):
    def setUp(self):
        self.client = client_module.XGImageClient("test-only-key")

    def test_submit_web_model_and_stable_id(self):
        self.client._request = Mock(return_value={"id": "business-1", "status": "queued"})
        self.client.submit("business-1", "白鹤")
        route, payload = self.client._request.call_args.args
        self.assertEqual(route, "/api/image-tasks/generations")
        self.assertEqual(payload["client_task_id"], "business-1")
        self.assertEqual(payload["model"], "gpt-image-2")
        self.assertNotIn("n", payload)

    def test_two_reference_files_are_sent_in_order(self):
        self.client._request = Mock(return_value={"status": "queued"})
        with tempfile.TemporaryDirectory() as folder:
            files = [Path(folder) / "a.png", Path(folder) / "b.jpg"]
            for file in files:
                file.write_bytes(b"fixture-image")
            self.client.submit("edit-1", "combine", images=files)
        route, payload = self.client._request.call_args.args
        self.assertEqual(route, "/api/image-tasks/edits")
        self.assertTrue(payload["images"][0].startswith("data:image/png;base64,"))
        self.assertTrue(payload["images"][1].startswith("data:image/jpeg;base64,"))

    def test_query_contract_and_missing_task(self):
        self.client._request = Mock(return_value={"items": [{"id": "task /1", "status": "running"}], "missing_ids": []})
        self.assertEqual(self.client.get_task("task /1")["status"], "running")
        self.assertIn("?ids=task+%2F1", self.client._request.call_args.args[0])
        self.client._request.return_value = {"items": [], "missing_ids": ["other"]}
        with self.assertRaises(LookupError):
            self.client.get_task("other")

    @patch.object(client_module.time, "sleep")
    def test_poll_success_and_transient_retry(self, sleep):
        self.client.get_task = Mock(side_effect=[URLError("offline"), {"status": "queued"}, {"status": "running"}, {"status": "success", "data": [{"url": "/images/test.png"}]}])
        self.assertEqual(self.client.wait("one")["status"], "success")
        self.assertEqual(self.client.get_task.call_count, 4)

    @patch.object(client_module.time, "sleep")
    def test_auth_failure_does_not_retry(self, sleep):
        self.client.get_task = Mock(side_effect=client_module.XGAPIError(401))
        with self.assertRaises(client_module.XGAPIError):
            self.client.wait("one")
        self.client.get_task.assert_called_once()
        sleep.assert_not_called()

    @patch.object(client_module.time, "sleep")
    def test_rate_limit_retry_is_bounded(self, sleep):
        self.client.get_task = Mock(side_effect=client_module.XGAPIError(429, "5"))
        with self.assertRaises(client_module.XGAPIError):
            self.client.wait("one")
        self.assertEqual(self.client.get_task.call_count, 4)
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(sleep.call_args.args[0], 5)

    def test_business_error_cancel_pause_and_unknown_stop(self):
        for task in [{"status": "error", "error_code": "cancelled_by_user"}, {"status": "paused"}, {"status": "new_state"}, {"status": "success", "data": []}]:
            with self.subTest(task=task):
                self.client.get_task = Mock(return_value=task)
                with self.assertRaises(RuntimeError):
                    self.client.wait("one")
                self.client.get_task.assert_called_once()

    def test_expired_deadline_does_not_submit_or_cancel(self):
        self.client.get_task = Mock()
        with self.assertRaises(TimeoutError):
            self.client.wait("one", timeout=0)
        self.client.get_task.assert_not_called()

    def test_secret_not_sent_to_other_origins_or_redirects(self):
        for url in ["https://external.invalid/images/a.png", "//external.invalid/images/a.png", "http://picture.museyin.com/images/a.png", "https://user:secret@picture.museyin.com/images/a.png"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.client._url(url)
        self.assertIsNone(client_module._NoRedirect().redirect_request(None, None, 302, None, None, "https://external.invalid"))

    def test_download_and_refuse_overwrite(self):
        self.client._request = Mock(return_value=b"image-bytes")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "image.png"
            self.client.download("/images/a.png", path)
            self.assertEqual(path.read_bytes(), b"image-bytes")
            with self.assertRaises(FileExistsError):
                self.client.download("/images/a.png", path)
        self.assertEqual(self.client._request.call_args.args[0], "https://picture.museyin.com/images/a.png")

    def test_invalid_configuration_and_retry_after(self):
        for url in ["http://example.com", "https://example.com/v1", "https://example.com?secret=x"]:
            with self.assertRaises(ValueError):
                client_module.XGImageClient("test", url)
        with self.assertRaises(ValueError):
            client_module.XGImageClient("")
        self.assertEqual(client_module.retry_delay("8", 1), 8)
        self.assertEqual(client_module.retry_delay("Wed, 01 Jan 2020 00:00:00 GMT", 1), 0)


if __name__ == "__main__":
    unittest.main()
