"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  validateSelectedPaths,
  writeSelectionFile,
} = require("../app/server/lib/selection");

const ENTRIES = [
  { path: "dir/a.txt", name: "a.txt", type: "file" },
  { path: "dir/b.txt", name: "b.txt", type: "file" },
  { path: "dir", name: "dir", type: "directory" },
];

// ---------------------------------------------------------------- C13

test("C13 validateSelectedPaths dedupes while preserving order", () => {
  const result = validateSelectedPaths(
    ["dir/b.txt", "dir/a.txt", "dir/b.txt"],
    ENTRIES,
  );
  assert.deepEqual(result, ["dir/b.txt", "dir/a.txt"]);
});

test("C13 validateSelectedPaths normalizes a ./ prefix", () => {
  assert.deepEqual(validateSelectedPaths(["./dir/a.txt"], ENTRIES), ["dir/a.txt"]);
});

test("C13 validateSelectedPaths rejects an empty selection", () => {
  for (const value of [[], null, undefined, "dir/a.txt", 42]) {
    assert.throws(
      () => validateSelectedPaths(value, ENTRIES),
      /请选择至少一个文件/,
      `应拒绝：${JSON.stringify(value)}`,
    );
  }
});

test("C13 validateSelectedPaths rejects a path missing from the archive", () => {
  assert.throws(
    () => validateSelectedPaths(["dir/c.txt"], ENTRIES),
    /所选文件不存在于压缩包中/,
  );
});

test("C13 validateSelectedPaths rejects directory entries", () => {
  assert.throws(
    () => validateSelectedPaths(["dir"], ENTRIES),
    /选择性解压只能提交文件/,
  );
});

// 安全红线：这些路径都必须被 normalizeEntryPath 拦下。
test("C13 validateSelectedPaths rejects traversal and unsafe paths", () => {
  const attacks = [
    "../evil.txt",
    "dir/../../evil.txt",
    "/etc/passwd",
    "C:\\Windows\\system32",
    "a\\..\\b",
    "a\0b",
    "a\nb",
    "a\rb",
    "",
  ];

  for (const value of attacks) {
    assert.throws(
      () => validateSelectedPaths([value], ENTRIES),
      /不安全/,
      `应拒绝：${JSON.stringify(value)}`,
    );
  }
});

test("C13 validateSelectedPaths ignores entries that are not in the archive", () => {
  // entries 里没有的路径一律拒绝，不做任何「猜测性」放行。
  assert.throws(
    () => validateSelectedPaths(["dir/a.txt", "other/b.txt"], ENTRIES),
    /所选文件不存在于压缩包中/,
  );
});

test("C13 writeSelectionFile writes 0600 in a 0700 dir, one path per line", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-selection-"));
  const jobDir = path.join(parent, "job.d");

  const filePath = writeSelectionFile(jobDir, ["dir/a.txt", "dir/b.txt"]);

  assert.equal(filePath, path.join(jobDir, "selection.txt"));
  assert.equal(fs.readFileSync(filePath, "utf8"), "dir/a.txt\ndir/b.txt\n");
  assert.equal(fs.statSync(jobDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("C13 writeSelectionFile creates a missing job directory", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-selection-"));
  const nested = path.join(parent, "a", "b");

  assert.doesNotThrow(() => writeSelectionFile(nested, ["dir/a.txt"]));
  assert.equal(fs.existsSync(path.join(nested, "selection.txt")), true);
});
