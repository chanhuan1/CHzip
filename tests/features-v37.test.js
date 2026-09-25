"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { classifyArchive } = require("../app/server/lib/archive");
const { removeSourceArchive } = require("../app/server/lib/worker");
const { createServices } = require("../app/server/lib/services");
const { routeRequest } = require("../app/server/api");

// ------------------------------------------------------------ 1. 扩展格式
test("v3.7 recognizes comic and system image formats", () => {
  assert.equal(classifyArchive("/path/to/comic.cbz")?.format, "zip");
  assert.equal(classifyArchive("/path/to/comic.cbr")?.format, "rar");
  assert.equal(classifyArchive("/path/to/book.epub")?.format, "zip");
  assert.equal(classifyArchive("/path/to/win.wim")?.format, "wim");
  assert.equal(classifyArchive("/path/to/win.swm")?.format, "wim");
  assert.equal(classifyArchive("/path/to/mac.dmg")?.format, "dmg");
});

// ------------------------------------------------------------ 2. 删除源文件单元测试
test("removeSourceArchive deletes single source file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-del-test-"));
  const archivePath = path.join(tmp, "test.zip");
  fs.writeFileSync(archivePath, "fake");

  const job = {
    deleteSource: true,
    archivePath,
    sourceFingerprint: [{ path: archivePath }],
  };
  const result = removeSourceArchive(job);
  assert.equal(result.deletedCount, 1);
  assert.equal(fs.existsSync(archivePath), false);
  assert.match(result.deleteNote, /已自动清理源压缩包/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("removeSourceArchive deletes all split volumes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-del-test-"));
  const part1 = path.join(tmp, "test.7z.001");
  const part2 = path.join(tmp, "test.7z.002");
  fs.writeFileSync(part1, "p1");
  fs.writeFileSync(part2, "p2");

  const job = {
    deleteSource: true,
    archivePath: part1,
    sourceFingerprint: [{ path: part1 }, { path: part2 }],
  };
  const result = removeSourceArchive(job);
  assert.equal(result.deletedCount, 2);
  assert.equal(fs.existsSync(part1), false);
  assert.equal(fs.existsSync(part2), false);
  assert.match(result.deleteNote, /已自动清理 2 个源分卷文件/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("removeSourceArchive is a no-op when deleteSource is false or not set", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-del-test-"));
  const archivePath = path.join(tmp, "test.zip");
  fs.writeFileSync(archivePath, "fake");

  const job = {
    deleteSource: false,
    archivePath,
    sourceFingerprint: [{ path: archivePath }],
  };
  const result = removeSourceArchive(job);
  assert.equal(result.deletedCount, 0);
  assert.equal(fs.existsSync(archivePath), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("removeSourceArchive refuses to delete source when selective extraction is used", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-del-test-"));
  const archivePath = path.join(tmp, "test.zip");
  fs.writeFileSync(archivePath, "fake");

  const job = {
    deleteSource: true,
    selection: ["file1.txt"],
    archivePath,
    sourceFingerprint: [{ path: archivePath }],
  };
  const result = removeSourceArchive(job);
  assert.equal(result.deletedCount, 0);
  assert.equal(fs.existsSync(archivePath), true, "部分选择性解压时严禁删除源压缩包");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("removeSourceArchive refuses to delete source when job kind is test", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-del-test-"));
  const archivePath = path.join(tmp, "test.zip");
  fs.writeFileSync(archivePath, "fake");

  const job = {
    kind: "test",
    deleteSource: true,
    archivePath,
    sourceFingerprint: [{ path: archivePath }],
  };
  const result = removeSourceArchive(job);
  assert.equal(result.deletedCount, 0);
  assert.equal(fs.existsSync(archivePath), true, "完整性体检任务严禁删除源压缩包");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------ 3. API 与 Services 透传 deleteSource
test("api extract forwards deleteSource to services", async () => {
  let captured;
  const fakeServices = {
    async extract(input) {
      captured = input;
      return { jobId: "a".repeat(32), outputDir: "/out" };
    },
  };
  await routeRequest("extract", {
    query: {},
    body: { path: "/a.zip", deleteSource: true },
    requestId: "123",
  }, fakeServices);

  assert.equal(captured.deleteSource, true);
});

// ------------------------------------------------------------ 4. 固实包提示引导方法在 uiDialogs 中正常导出
test("uiDialogs exports openSolidConfirmDialog and closeSolidConfirmDialog", () => {
  require("../app/www/js/ui-dialogs");
  const dialogs = globalThis.CHzipUiDialogs;
  assert.equal(typeof dialogs.openSolidConfirmDialog, "function");
  assert.equal(typeof dialogs.closeSolidConfirmDialog, "function");
});
