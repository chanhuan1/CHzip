"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  buildListArgs,
  buildExtractArgs,
  buildTestArgs,
} = require("../app/server/lib/sevenzip");

test("buildListArgs includes password when provided", () => {
  const args = buildListArgs(
    { type: "7z", format: "7z" },
    { archivePath: "/data/file.7z", password: "secret" },
  );
  assert.ok(args.includes("-psecret"));
  assert.ok(args.includes("/data/file.7z"));
});

test("buildExtractArgs includes selection file", () => {
  const args = buildExtractArgs(
    { type: "7z", format: "7z" },
    {
      archivePath: "/data/file.7z",
      outputDir: "/out",
      selectionFile: "/tmp/sel.txt",
    },
  );
  assert.ok(args.includes("-i@/tmp/sel.txt"));
  assert.ok(args.includes("-o/out"));
});

test("buildTestArgs builds correct command", () => {
  const args = buildTestArgs(
    { type: "zip", format: "zip" },
    { archivePath: "/data/file.zip", password: "pw" },
  );
  assert.equal(args[0], "t");
  assert.ok(args.includes("-ppw"));
  assert.ok(args.includes("/data/file.zip"));
});
