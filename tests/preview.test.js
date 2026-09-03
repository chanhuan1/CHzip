"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  normalizeEntryPath,
  parseTechnicalList,
  createTechnicalListValidator,
  detectTechnicalListFormat,
  PreviewLimitError,
} = require("../app/server/lib/preview");

test("normalizeEntryPath rejects absolute paths", () => {
  assert.throws(() => normalizeEntryPath("/etc/passwd"), /不安全路径/);
});

test("normalizeEntryPath rejects drive letters", () => {
  assert.throws(() => normalizeEntryPath("C:\\Windows\\file"), /不安全路径/);
});

test("normalizeEntryPath rejects parent traversal", () => {
  assert.throws(() => normalizeEntryPath("../etc/passwd"), /不安全路径/);
  assert.throws(() => normalizeEntryPath("foo/../../etc"), /不安全路径/);
});

test("normalizeEntryPath rejects NUL bytes", () => {
  assert.throws(() => normalizeEntryPath("file\0.txt"), /格式不安全/);
});

test("normalizeEntryPath rejects empty paths", () => {
  assert.throws(() => normalizeEntryPath(""), /格式不安全/);
});

test("normalizeEntryPath normalizes backslashes", () => {
  assert.equal(normalizeEntryPath("foo\\bar.txt"), "foo/bar.txt");
});

test("normalizeEntryPath strips leading ./", () => {
  assert.equal(normalizeEntryPath("./foo.txt"), "foo.txt");
});

test("normalizeEntryPath accepts valid relative paths", () => {
  assert.equal(normalizeEntryPath("foo/bar.txt"), "foo/bar.txt");
  assert.equal(normalizeEntryPath("file.txt"), "file.txt");
});

test("parseTechnicalList parses valid output", () => {
  const text = `7-Zip (z) 24.09 (x64) : Copyright 1999-2024 Igor Pavlov : 2024-11-29
...
----------
Path = foo.txt
Size = 1024
Attributes = A

Path = bar
Size = 0
Attributes = D
`;
  const result = parseTechnicalList(text);
  assert.equal(result.entries.length, 2);
  assert.equal(result.summary.fileCount, 1);
  assert.equal(result.summary.directoryCount, 1);
  assert.equal(result.summary.totalSize, 1024);
});

test("parseTechnicalList handles empty archive", () => {
  const text = `7-Zip output without separator`;
  const result = parseTechnicalList(text);
  assert.equal(result.entries.length, 0);
  assert.equal(result.summary.fileCount, 0);
});

test("parseTechnicalList throws on oversized input", () => {
  const huge = "x".repeat(65 * 1024 * 1024);
  assert.throws(
    () => parseTechnicalList(huge, { maxBytes: 64 * 1024 * 1024 }),
    PreviewLimitError,
  );
});

test("parseTechnicalList throws on too many entries", () => {
  let text = "header\n----------\n";
  for (let i = 0; i < 1001; i += 1) {
    text += `Path = file${i}.txt\nSize = 1\nAttributes = A\n\n`;
  }
  assert.throws(
    () => parseTechnicalList(text, { maxEntries: 1000 }),
    PreviewLimitError,
  );
});

test("detectTechnicalListFormat extracts format from header", () => {
  const text = `Type = 7z
----------
Path = foo.txt
`;
  assert.equal(detectTechnicalListFormat(text), "7z");
});

test("detectTechnicalListFormat returns null for unknown", () => {
  assert.equal(detectTechnicalListFormat("no header"), null);
});

test("createTechnicalListValidator counts entries", () => {
  const validator = createTechnicalListValidator();
  validator.write("Type = zip\n");
  validator.write("----------\n");
  validator.write("Path = a.txt\nSize = 1\n");
  validator.write("\n");
  validator.write("Path = b.txt\nSize = 2\n");
  const result = validator.end();
  assert.equal(result.entryCount, 2);
  assert.equal(result.format, "zip");
});

test("createTechnicalListValidator rejects oversized lines", () => {
  const validator = createTechnicalListValidator({ maxLineBytes: 10 });
  assert.throws(
    () => validator.write("x".repeat(100)),
    /超长/,
  );
});
