"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  normalizeApiName,
  parseJsonBody,
} = require("../app/server/api");

test("parseJsonBody rejects JSON primitives, arrays and null as invalid request bodies", () => {
  for (const raw of ["null", "[]", "\"text\"", "1", "true"]) {
    assert.throws(
      () => parseJsonBody(raw),
      (error) => error.code === "INVALID_JSON",
      `应拒绝 ${raw}`,
    );
  }
});

test("normalizeApiName tolerates an absent body", () => {
  assert.equal(normalizeApiName({ api: "status" }, null), "status");
  assert.equal(normalizeApiName({}, null), "");
});
