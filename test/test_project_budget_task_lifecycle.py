from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from services.image_task_service import ImageTaskService


OWNER = {"id": "owner-budget", "name": "Owner", "role": "user"}


class Credits:
    def __init__(self):
        self.reserved: list[str] = []
        self.consumed: list[str] = []
        self.refunded: list[str] = []

    def reserve_image_credit(self, _identity, task_id: str):
        self.reserved.append(task_id)
        return True

    def consume_image_credit(self, _identity, task_id: str):
        self.consumed.append(task_id)
        return True

    def refund_image_credit(self, _identity, task_id: str):
        self.refunded.append(task_id)
        return True


def wait_for_terminal(service: ImageTaskService, task_id: str) -> dict[str, object]:
    deadline = time.time() + 2
    while time.time() < deadline:
        task = service.list_tasks(OWNER, [task_id])["items"][0]
        if task["status"] in {"success", "error"}:
            return task
        time.sleep(0.02)
    raise AssertionError("task did not finish")


def wait_for_idle(service: ImageTaskService) -> None:
    deadline = time.time() + 2
    while time.time() < deadline:
        if service._running_total == 0 and not service._active_attempts:
            return
        time.sleep(0.02)
    raise AssertionError("task worker did not release its resources")


class ProjectBudgetTaskLifecycleTests(unittest.TestCase):
    def test_success_consumes_project_budget_once(self):
        with tempfile.TemporaryDirectory() as root:
            credits = Credits()
            service = ImageTaskService(
                Path(root) / "tasks.json",
                generation_handler=lambda _payload: {"data": [{"url": "https://example.test/image.png"}]},
                credit_manager=credits,
                retention_days_getter=lambda: 30,
            )
            with (
                mock.patch.object(service, "_reserve_project_budget", return_value=True) as reserve,
                mock.patch.object(service, "_consume_project_budget", return_value=True) as consume,
                mock.patch.object(service, "_refund_project_budget", return_value=True) as refund,
                mock.patch(
                    "services.creative_workspace_service.creative_workspace_service.record_task_success",
                    return_value=[],
                ),
                mock.patch(
                    "services.creative_intelligence_service.creative_intelligence_service.notify_task",
                    return_value={},
                ),
            ):
                service.submit_generation(
                    OWNER,
                    client_task_id="budget-success",
                    prompt="海报",
                    model="gpt-image-2",
                    size=None,
                    workflow={"project_id": "project-1"},
                )
                task = wait_for_terminal(service, "budget-success")
                wait_for_idle(service)

            self.assertEqual(task["status"], "success")
            reserve.assert_called_once_with(OWNER, "project-1", "budget-success")
            consume.assert_called_once()
            refund.assert_not_called()
            self.assertEqual(credits.consumed, ["budget-success"])

    def test_failure_refunds_project_budget_and_insufficient_budget_refunds_user_credit(self):
        with tempfile.TemporaryDirectory() as root:
            credits = Credits()

            def fail(_payload):
                raise RuntimeError("upstream unavailable")

            service = ImageTaskService(
                Path(root) / "tasks.json",
                generation_handler=fail,
                credit_manager=credits,
                retention_days_getter=lambda: 30,
            )
            with (
                mock.patch.object(service, "_reserve_project_budget", return_value=True),
                mock.patch.object(service, "_consume_project_budget", return_value=True) as consume,
                mock.patch.object(service, "_refund_project_budget", return_value=True) as refund,
                mock.patch(
                    "services.creative_intelligence_service.creative_intelligence_service.notify_task",
                    return_value={},
                ),
            ):
                service.submit_generation(
                    OWNER,
                    client_task_id="budget-failure",
                    prompt="海报",
                    model="gpt-image-2",
                    size=None,
                    workflow={"project_id": "project-1"},
                )
                task = wait_for_terminal(service, "budget-failure")
                wait_for_idle(service)

            self.assertEqual(task["status"], "error")
            consume.assert_not_called()
            refund.assert_called_once_with(OWNER, "budget-failure")
            self.assertIn("budget-failure", credits.refunded)

            rejected = ImageTaskService(
                Path(root) / "rejected.json",
                generation_handler=lambda _payload: self.fail("handler must not run"),
                credit_manager=credits,
                retention_days_getter=lambda: 30,
            )
            with mock.patch.object(rejected, "_reserve_project_budget", return_value=False):
                with self.assertRaisesRegex(ValueError, "项目图片额度不足"):
                    rejected.submit_generation(
                        OWNER,
                        client_task_id="budget-rejected",
                        prompt="海报",
                        model="gpt-image-2",
                        size=None,
                        workflow={"project_id": "project-1"},
                    )
            self.assertIn("budget-rejected", credits.refunded)


if __name__ == "__main__":
    unittest.main()
