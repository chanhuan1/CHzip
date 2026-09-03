"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  sanitizeOutputStem,
  validateDirectoryName,
} = require("../app/server/lib/paths");

test("sanitizeOutputStem removes illegal characters", () => {
  assert.equal(sanitizeOutputStem('foo<bar>:"/\\|?*'), "foo_bar________");
});

test("sanitizeOutputStem trims trailing dots and spaces", () => {
  assert.equal(sanitizeOutputStem("foo...   "), "foo");
});

test("sanitizeOutputStem falls back to 'archive' for empty", () => {
  assert.equal(sanitizeOutputStem(""), "archive");
  assert.equal(sanitizeOutputStem("..."), "archive");
});

test("sanitizeOutputStem preserves valid names", () => {
  assert.equal(sanitizeOutputStem("my_archive"), "my_archive");
  assert.equal(sanitizeOutputStem("备份 2024"), "备份 2024");
});

test("validateDirectoryName accepts valid names", () => {
  assert.equal(validateDirectoryName("new folder"), "new folder");
  assert.equal(validateDirectoryName("  trimmed  "), "trimmed");
});

test("validateDirectoryName rejects empty", () => {
  assert.throws(() => validateDirectoryName(""), /无效/);
});

test("validateDirectoryName rejects dots", () => {
  assert.throws(() => validateDirectoryName("."), /无效/);
  assert.throws(() => validateDirectoryName(".."), /无效/);
});

test("validateDirectoryName rejects slashes", () => {
  assert.throws(() => validateDirectoryName("foo/bar"), /无效/);
  assert.throws(() => validateDirectoryName("foo\\bar"), /无效/);
});

test("validateDirectoryName rejects control characters", () => {
  assert.throws(() => validateDirectoryName("foo\0bar"), /无效/);
});

test("validateDirectoryName rejects too long", () => {
  assert.throws(() => validateDirectoryName("x".repeat(129)), /无效/);
});
