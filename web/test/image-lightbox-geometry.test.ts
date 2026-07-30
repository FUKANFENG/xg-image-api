import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLightboxTransform, zoomLightboxAtPoint } from "../src/lib/image-lightbox-geometry.ts";

test("zooms around the mouse position instead of the viewport center", () => {
  const result = zoomLightboxAtPoint(
    { scale: 1, x: 0, y: 0 },
    2,
    { x: 750, y: 200 },
    { width: 1_000, height: 800 },
  );

  assert.deepEqual(result, { scale: 2, x: -250, y: 200 });
});

test("returns to the centered default transform when zooming back to 100 percent", () => {
  const result = zoomLightboxAtPoint(
    { scale: 2, x: -250, y: 200 },
    0.5,
    { x: 750, y: 200 },
    { width: 1_000, height: 800 },
  );

  assert.deepEqual(result, { scale: 1, x: 0, y: 0 });
});

test("keeps panning within the visible viewport bounds", () => {
  const result = normalizeLightboxTransform({ scale: 2, x: 900, y: -900 }, { width: 1_000, height: 800 });

  assert.deepEqual(result, { scale: 2, x: 500, y: -400 });
});
