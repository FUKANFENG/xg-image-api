import assert from "node:assert/strict";
import test from "node:test";

import {
  getImageTaskErrorPresentation,
  getImageTaskProgressPresentation,
} from "../src/lib/image-task-presentation.ts";

test("maps recoverable account failures to a clear retry action", () => {
  const presentation = getImageTaskErrorPresentation(
    "account_precheck_failed",
    "image account precheck failed",
  );

  assert.equal(presentation.title, "账号连接检查失败");
  assert.equal(presentation.action, "retry");
  assert.match(presentation.detail, /自动切换|稍后重试/);
});

test("maps policy rejection to prompt editing instead of blind retry", () => {
  const presentation = getImageTaskErrorPresentation(
    "content_policy_violation",
    "rejected",
  );

  assert.equal(presentation.title, "提示词需要调整");
  assert.equal(presentation.action, "edit_prompt");
});

test("maps backend progress into a stable five-stage flow", () => {
  assert.equal(getImageTaskProgressPresentation("queued").activeIndex, 0);
  assert.equal(getImageTaskProgressPresentation("getting_account").activeIndex, 1);
  assert.equal(getImageTaskProgressPresentation("starting_generation").activeIndex, 3);
  assert.equal(getImageTaskProgressPresentation("receiving_image").activeIndex, 4);
});
