"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  findArchiveAccessibleRoot,
  prepareConflictAwareOutputDir,
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

test("findArchiveAccessibleRoot climbs to the fnOS share root", () => {
  const root = findArchiveAccessibleRoot(
    "/vol1/share/docs/archive.zip",
    {
      platform: "linux",
      realpathResolver: (value) => value,
      capabilityResolver: () => ({
        canBrowse: true,
        canSelect: true,
      }),
    },
  );
  assert.equal(root, "/vol1/share");
});

test("rename policy creates a fresh output directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-output-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "archive"));

  const result = prepareConflictAwareOutputDir(root, "archive", "rename");

  assert.equal(result.path, path.join(root, "archive (2)"));
  assert.equal(result.owned, true);
  assert.equal(result.reused, false);
});

test("overwrite, skip and keepnew reuse the same output directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-output-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "archive");
  fs.mkdirSync(outputDir);

  for (const policy of ["overwrite", "skip", "keepnew"]) {
    const result = prepareConflictAwareOutputDir(root, "archive", policy);
    assert.equal(result.path, fs.realpathSync(outputDir));
    assert.equal(result.owned, false);
    assert.equal(result.reused, true);
  }
});

test("conflict-aware output refuses a non-directory collision", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-output-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "archive"), "not a directory");

  assert.throws(
    () => prepareConflictAwareOutputDir(root, "archive", "overwrite"),
    /不是可安全复用的目录/,
  );
});
