import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES,
  imageSourceToReferenceFile,
  validateReferenceImages,
} from "../src/lib/image-references.ts";

function imageFile(name: string, type: string, size = 4) {
  return new File([new Uint8Array(size)], name, { type });
}

test("accepts supported PNG and JPEG reference images", () => {
  const png = imageFile("first.png", "image/png");
  const jpeg = imageFile("second.jpg", "image/jpeg");

  const result = validateReferenceImages([png, jpeg]);

  assert.deepEqual(result.accepted, [png, jpeg]);
  assert.deepEqual(result.errors, []);
});

test("rejects non-image and unsupported image formats", () => {
  const result = validateReferenceImages([
    imageFile("notes.txt", "text/plain"),
    imageFile("vector.svg", "image/svg+xml"),
  ]);

  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.errors, [
    "notes.txt 不是支持的图片格式，请上传 PNG、JPG、JPEG 或 WEBP。",
    "vector.svg 不是支持的图片格式，请上传 PNG、JPG、JPEG 或 WEBP。",
  ]);
});

test("rejects reference images above the client size limit", () => {
  const oversized = imageFile("large.png", "image/png", MAX_REFERENCE_IMAGE_BYTES + 1);

  const result = validateReferenceImages([oversized]);

  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.errors, ["large.png 超过 50 MB，请压缩后重试。"]);
});

test("enforces the total reference image count while keeping valid files", () => {
  const files = Array.from({ length: MAX_REFERENCE_IMAGES + 2 }, (_, index) =>
    imageFile(`${index + 1}.webp`, "image/webp"),
  );

  const result = validateReferenceImages(files, 1);

  assert.equal(result.accepted.length, MAX_REFERENCE_IMAGES - 1);
  assert.deepEqual(result.errors, [`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图，已忽略其余 3 张。`]);
});

test("converts an existing image result into a reference file", async () => {
  const request = async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));

  const file = await imageSourceToReferenceFile("/result.png", "xg-result.png", request);

  assert.equal(file.name, "xg-result.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 3);
});

test("rejects a result URL that does not return an image", async () => {
  const request = async () => new Response("not found", { status: 404 });

  await assert.rejects(
    imageSourceToReferenceFile("/missing.png", "missing.png", request),
    /读取作品图片失败（404）/,
  );
});
