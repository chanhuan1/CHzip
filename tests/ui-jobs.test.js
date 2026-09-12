"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-jobs");

const { formatTaskDateTime } = globalThis.CHzipUiJobs;

test("formatTaskDateTime renders full local date and time", () => {
  const iso = new Date(2026, 8, 12, 22, 14, 3).toISOString();
  assert.equal(formatTaskDateTime(iso), "2026-09-12 22:14:03");
});

test("formatTaskDateTime zero-pads every segment", () => {
  const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  assert.equal(formatTaskDateTime(iso), "2026-01-02 03:04:05");
});

test("formatTaskDateTime returns empty string for missing or invalid input", () => {
  assert.equal(formatTaskDateTime(""), "");
  assert.equal(formatTaskDateTime(null), "");
  assert.equal(formatTaskDateTime(undefined), "");
  assert.equal(formatTaskDateTime("not-a-date"), "");
});

test("formatTaskDateTime keeps the calendar date across midnight", () => {
  const iso = new Date(2026, 11, 31, 23, 59, 59).toISOString();
  assert.equal(formatTaskDateTime(iso), "2026-12-31 23:59:59");
});
