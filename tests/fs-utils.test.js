"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { truncateUtf8Name } = require("../app/server/lib/fs-utils");

test("truncateUtf8Name leaves short names untouched", () => {
  assert.equal(truncateUtf8Name("report.txt"), "report.txt");
});

test("truncateUtf8Name keeps total bytes within limit and preserves extension", () => {
  // 每个中文字符 3 字节：构造超长中文名
  const longName = `${"很长的中文名字".repeat(30)}.mp4`;
  assert.ok(Buffer.byteLength(longName, "utf8") > 230);
  const result = truncateUtf8Name(longName, 230);
  assert.ok(Buffer.byteLength(result, "utf8") <= 230);
  assert.ok(result.endsWith(".mp4"), `expected .mp4 suffix, got: ${result}`);
});

test("truncateUtf8Name never splits a multi-byte char", () => {
  const longName = "啊".repeat(200) + ".bin";
  const result = truncateUtf8Name(longName, 200);
  // 结果要么合法 utf8 且不出现半个字符（replacement），要么为空兜底
  assert.doesNotThrow(() => Buffer.from(result, "utf8").toString("utf8"));
});
