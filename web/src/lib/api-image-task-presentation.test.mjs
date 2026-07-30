import assert from "node:assert/strict";
import test from "node:test";

import {
  formatImageTaskBytes,
  formatImageTaskDuration,
  shortImageTaskId,
} from "./api-image-task-presentation.ts";

test("formats stored image sizes for the task feed", () => {
  assert.equal(formatImageTaskBytes(), "-");
  assert.equal(formatImageTaskBytes(980), "980 B");
  assert.equal(formatImageTaskBytes(1536), "1.5 KB");
  assert.equal(formatImageTaskBytes(2 * 1024 * 1024), "2.0 MB");
});

test("prefers measured duration and falls back to live elapsed time", () => {
  assert.equal(formatImageTaskDuration(4200, 99), "4.2 秒");
  assert.equal(formatImageTaskDuration(undefined, 75), "1 分 15 秒");
});

test("keeps short identifiers intact and condenses long identifiers", () => {
  assert.equal(shortImageTaskId("task-123"), "task-123");
  assert.equal(
    shortImageTaskId("api-1234567890abcdefghijklmnop"),
    "api-1234…klmnop",
  );
});
