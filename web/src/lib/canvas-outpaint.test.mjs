import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateOutpaintGeometry,
  imageModelSizeForRatio,
} from "./canvas-outpaint.ts";

test("expands a square canvas to 16:9 and anchors the image to the left", () => {
  assert.deepEqual(calculateOutpaintGeometry(1024, 1024, "16:9", ["right"]), {
    width: 1821,
    height: 1024,
    offsetX: 0,
    offsetY: 0,
  });
});

test("centers horizontal expansion when both sides are selected", () => {
  assert.deepEqual(
    calculateOutpaintGeometry(1000, 1000, "4:3", ["left", "right"]),
    { width: 1334, height: 1000, offsetX: 167, offsetY: 0 },
  );
});

test("uses portrait model size for portrait ratios", () => {
  assert.equal(imageModelSizeForRatio("9:16"), "1024x1536");
  assert.equal(imageModelSizeForRatio("16:9"), "1536x1024");
  assert.equal(imageModelSizeForRatio("1:1"), "1024x1024");
});

test("expands a same-ratio canvas in the selected direction", () => {
  assert.deepEqual(calculateOutpaintGeometry(1000, 1000, "1:1", ["right"]), {
    width: 1250,
    height: 1250,
    offsetX: 0,
    offsetY: 125,
  });
});

test("honors a vertical direction while preserving a landscape ratio", () => {
  assert.deepEqual(calculateOutpaintGeometry(1000, 1000, "16:9", ["top"]), {
    width: 2223,
    height: 1250,
    offsetX: 611,
    offsetY: 250,
  });
});

test("does not expand when no direction is selected", () => {
  assert.deepEqual(calculateOutpaintGeometry(1000, 1000, "16:9", []), {
    width: 1000,
    height: 1000,
    offsetX: 0,
    offsetY: 0,
  });
});
