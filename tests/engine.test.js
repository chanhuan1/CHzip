"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  classifySevenZipError,
  parseProgress,
} = require("../app/server/lib/engine");

test("classifySevenZipError detects password required", () => {
  const result = classifySevenZipError("Enter password", 255, {
    passwordProvided: false,
  });
  assert.equal(result.code, "PASSWORD_REQUIRED");
});

test("classifySevenZipError detects wrong password", () => {
  const result = classifySevenZipError("Wrong password or CRC failed", 255, {
    passwordProvided: true,
  });
  assert.equal(result.code, "PASSWORD");
});

test("classifySevenZipError detects missing volume", () => {
  const result = classifySevenZipError("Unexpected end of archive", 2, {});
  assert.equal(result.code, "MISSING_VOLUME");
});

test("classifySevenZipError detects permission denied", () => {
  const result = classifySevenZipError("Permission denied", 2, {});
  assert.equal(result.code, "PERMISSION");
});

test("classifySevenZipError detects damaged archive", () => {
  const result = classifySevenZipError("Data error in file", 2, {});
  assert.equal(result.code, "DAMAGED");
});

test("classifySevenZipError detects unsupported format", () => {
  const result = classifySevenZipError("Can not open as archive", 2, {});
  assert.equal(result.code, "UNSUPPORTED");
});

test("classifySevenZipError handles cancellation", () => {
  const result = classifySevenZipError("", 255, { cancelled: true });
  assert.equal(result.code, "CANCELLED");
});

test("classifySevenZipError returns generic ENGINE for unknown", () => {
  const result = classifySevenZipError("some random error", 2, {});
  assert.equal(result.code, "ENGINE");
});

test("parseProgress extracts percent and current file", () => {
  const log = "  42% file.txt\n";
  const result = parseProgress(log);
  assert.equal(result.percent, 42);
  assert.equal(result.currentFile, "file.txt");
});

test("parseProgress caps at 100%", () => {
  const log = "  150% file.txt\n";
  const result = parseProgress(log);
  assert.equal(result.percent, 100);
});

test("parseProgress returns zero for empty", () => {
  const result = parseProgress("");
  assert.equal(result.percent, 0);
  assert.equal(result.currentFile, "");
});

test("parseProgress takes the latest carriage-return snapshot", () => {
  const log = "  0% a.txt\r  37% b.txt\r  99% c.txt\r";
  const result = parseProgress(log);
  assert.equal(result.percent, 99);
  assert.equal(result.currentFile, "c.txt");
});

