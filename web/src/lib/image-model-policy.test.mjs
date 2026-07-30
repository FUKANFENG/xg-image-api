import assert from "node:assert/strict";
import test from "node:test";

import {
  getUserWebImageModels,
  isUserWebImageModel,
  resolveUserWebImageModel,
  USER_DEFAULT_IMAGE_MODEL,
} from "./image-model-policy.ts";

test("filters every codex image variant from the user model list", () => {
  assert.deepEqual(
    getUserWebImageModels([
      { id: "codex-gpt-image-2" },
      { id: "PLUS-CODEX-GPT-IMAGE-2" },
      { id: "gpt-image-3" },
      { id: "gpt-image-2" },
    ]),
    ["gpt-image-2", "gpt-image-3"],
  );
});

test("uses the web default when the API only returns codex models", () => {
  assert.deepEqual(
    getUserWebImageModels([{ id: "codex-gpt-image-2" }]),
    [USER_DEFAULT_IMAGE_MODEL],
  );
});

test("replaces codex, stale and empty state with a deterministic web model", () => {
  const available = ["gpt-image-3", "gpt-image-2"];
  assert.equal(
    resolveUserWebImageModel("codex-gpt-image-2", available),
    USER_DEFAULT_IMAGE_MODEL,
  );
  assert.equal(
    resolveUserWebImageModel("removed-image-model", available),
    USER_DEFAULT_IMAGE_MODEL,
  );
  assert.equal(resolveUserWebImageModel("", available), USER_DEFAULT_IMAGE_MODEL);
});

test("preserves a valid selected web model regardless of casing", () => {
  assert.equal(
    resolveUserWebImageModel("GPT-IMAGE-3", ["gpt-image-2", "gpt-image-3"]),
    "gpt-image-3",
  );
});

test("recognizes only non-codex image models as user selectable", () => {
  assert.equal(isUserWebImageModel("gpt-image-2"), true);
  assert.equal(isUserWebImageModel("codex-gpt-image-2"), false);
  assert.equal(isUserWebImageModel("gpt-5.6"), false);
});
