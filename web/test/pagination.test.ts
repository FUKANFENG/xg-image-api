import assert from "node:assert/strict";
import test from "node:test";

import { paginateItems } from "../src/lib/pagination.ts";

test("第一页返回按页大小截取的最近作品", () => {
  const result = paginateItems(Array.from({ length: 22 }, (_, index) => index + 1), 1, 6);

  assert.deepEqual(result.items, [1, 2, 3, 4, 5, 6]);
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 4);
  assert.equal(result.totalItems, 22);
});

test("最后一页只返回剩余的作品", () => {
  const result = paginateItems(Array.from({ length: 22 }, (_, index) => index + 1), 4, 6);

  assert.deepEqual(result.items, [19, 20, 21, 22]);
  assert.equal(result.page, 4);
  assert.equal(result.totalPages, 4);
});

test("超出范围的页码会钳制到可用的最后一页", () => {
  const result = paginateItems(Array.from({ length: 22 }, (_, index) => index + 1), 99, 6);

  assert.equal(result.page, 4);
  assert.deepEqual(result.items, [19, 20, 21, 22]);
});

test("空作品集保留稳定的第一页元数据", () => {
  const result = paginateItems([], 7, 6);

  assert.deepEqual(result.items, []);
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 1);
  assert.equal(result.totalItems, 0);
});
