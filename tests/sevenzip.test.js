"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  buildCommentArgs,
  buildExtractArgs,
  buildListArgs,
  buildReadCommentArgs,
  buildStdoutExtractArgs,
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

// ------------------------------------------------------------ -t 强制类型红线
// 7-Zip 26.x 对 RAR5 多分卷（Volume Locator）在强制 -tRar 时 Open ERROR；
// `.split` 是内部伪类型。所有构造 7z 参数的函数都必须遵守同一条红线。

const RAR_SELECTIONS = [
  { type: "rar", format: "rar" },
  { type: "rar.split", format: "rar" },
];
const SPLIT_SELECTIONS = [
  { type: "7z.split", format: "7z" },
  { type: "zip.split", format: "zip" },
];

function hasForcedType(args) {
  return args.some((arg) => /^-t/i.test(arg));
}

test("buildCommentArgs never forces -tRar or a split pseudo-type", () => {
  for (const selection of [...RAR_SELECTIONS, ...SPLIT_SELECTIONS]) {
    const args = buildCommentArgs(selection, {
      archivePath: "/data/a.rar",
      commentFile: "/tmp/c.txt",
    });
    assert.equal(
      hasForcedType(args),
      false,
      `type=${selection.type} 不应强制 -t，得到 ${args.join(" ")}`,
    );
  }
});

test("buildReadCommentArgs never forces -tRar or a split pseudo-type", () => {
  for (const selection of [...RAR_SELECTIONS, ...SPLIT_SELECTIONS]) {
    const args = buildReadCommentArgs(selection, { archivePath: "/data/a.rar" });
    assert.equal(
      hasForcedType(args),
      false,
      `type=${selection.type} 不应强制 -t，得到 ${args.join(" ")}`,
    );
  }
});

test("comment args still force -t for genuinely forceable types", () => {
  const writeArgs = buildCommentArgs(
    { type: "7z", format: "7z" },
    { archivePath: "/data/a.7z", commentFile: "/tmp/c.txt" },
  );
  assert.ok(writeArgs.includes("-t7z"));
  const readArgs = buildReadCommentArgs(
    { type: "zip", format: "zip" },
    { archivePath: "/data/a.zip" },
  );
  assert.ok(readArgs.includes("-tzip"));
});

test("list/extract/stdout args keep the same -t red line (regression)", () => {
  for (const selection of [...RAR_SELECTIONS, ...SPLIT_SELECTIONS]) {
    const common = { archivePath: "/data/a.rar" };
    assert.equal(hasForcedType(buildListArgs(selection, common)), false);
    assert.equal(
      hasForcedType(buildExtractArgs(selection, { ...common, outputDir: "/out" })),
      false,
    );
    assert.equal(hasForcedType(buildStdoutExtractArgs(selection, common)), false);
  }
  assert.ok(hasForcedType(buildListArgs(
    { type: "7z", format: "7z" },
    { archivePath: "/data/a.7z" },
  )));
});
