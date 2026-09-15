"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_MISSING_ENUM,
  MAX_VOLUME_NUMBER,
  classifyArchive,
  collectVolumeNames,
  missingRange,
  stripKnownExtension,
} = require("../app/server/lib/archive");
const { inspectArchive } = require("../app/server/lib/archive-service");

test("classifyArchive recognizes single formats", () => {
  assert.equal(classifyArchive("/data/file.zip").format, "zip");
  assert.equal(classifyArchive("/data/file.zip").kind, "single");
  assert.equal(classifyArchive("/data/file.7z").format, "7z");
  assert.equal(classifyArchive("/data/file.tar.gz").format, "gzip");
  assert.equal(classifyArchive("/data/file.tar.gz").innerFormat, "tar");
});

test("classifyArchive recognizes split .001 volumes", () => {
  const result = classifyArchive("/data/file.7z.002");
  assert.equal(result.kind, "split");
  assert.equal(result.format, "7z");
  assert.equal(result.partNumber, 2);
  assert.equal(result.firstVolumeName, "file.7z.001");
});

test("classifyArchive recognizes RAR part volumes", () => {
  const result = classifyArchive("/data/file.part3.rar");
  assert.equal(result.kind, "rar-parts");
  assert.equal(result.format, "rar");
  assert.equal(result.partNumber, 3);
  assert.equal(result.firstVolumeName, "file.part1.rar");
});

test("classifyArchive recognizes zip .z01 volumes", () => {
  const result = classifyArchive("/data/file.z02");
  assert.equal(result.kind, "zip-z");
  assert.equal(result.format, "zip");
  assert.equal(result.partNumber, 2);
  assert.equal(result.firstVolumeName, "file.zip");
});

test("classifyArchive recognizes old RAR .r00 volumes", () => {
  const result = classifyArchive("/data/file.r00");
  assert.equal(result.kind, "rar-old");
  assert.equal(result.format, "rar");
  assert.equal(result.partNumber, 2);
  assert.equal(result.firstVolumeName, "file.rar");
});

test("classifyArchive rejects invalid files", () => {
  assert.equal(classifyArchive("/data/file.txt"), null);
  assert.equal(classifyArchive("/data/file"), null);
  assert.equal(classifyArchive("/data/file.7z.000"), null);
});

test("classifyArchive handles additional single formats", () => {
  assert.equal(classifyArchive("/data/file.iso").format, "iso");
  assert.equal(classifyArchive("/data/file.cab").format, "cab");
  assert.equal(classifyArchive("/data/file.arj").format, "arj");
  assert.equal(classifyArchive("/data/file.lzh").format, "lzh");
  assert.equal(classifyArchive("/data/file.lha").format, "lzh");
});

test("collectVolumeNames finds split volumes", () => {
  const selection = classifyArchive("/data/file.7z.001");
  const directoryNames = ["file.7z.001", "file.7z.002", "file.7z.003"];
  const result = collectVolumeNames(selection, directoryNames);
  assert.deepEqual(result.names, ["file.7z.001", "file.7z.002", "file.7z.003"]);
  assert.deepEqual(result.missingParts, []);
});

test("collectVolumeNames detects missing volumes", () => {
  const selection = classifyArchive("/data/file.7z.001");
  const directoryNames = ["file.7z.001", "file.7z.003"];
  const result = collectVolumeNames(selection, directoryNames);
  assert.deepEqual(result.missingParts, [2]);
});

test("stripKnownExtension removes known extensions", () => {
  assert.equal(stripKnownExtension("file.tar.gz"), "file");
  assert.equal(stripKnownExtension("file.7z"), "file");
  assert.equal(stripKnownExtension("file.zip"), "file");
  assert.equal(stripKnownExtension("file.unknown"), "file.unknown");
});

// ---------------------------------------------------------------- A2：上界

// 分卷号直接来自目录名里的数字。没有上界时，一个合法备份名
// （backup.20260915）会被当成 2000 万号分卷，missingRange 逐号枚举
// 就会分配 2000 万个元素的数组，而结果还会 join 进 warnings 返回。
test("A2 classifyArchive rejects an out-of-range part number", () => {
  assert.equal(classifyArchive("/data/file.7z.999999999"), null);
  assert.equal(classifyArchive("/data/file.part9999999.rar"), null);
  assert.equal(classifyArchive("/data/file.z999999999"), null);
  assert.equal(classifyArchive("/data/backup.20260915"), null);
});

test("A2 classifyArchive still accepts realistic part numbers", () => {
  assert.equal(classifyArchive("/data/file.7z.001").partNumber, 1);
  assert.equal(classifyArchive("/data/file.7z.0001").partNumber, 1);
  assert.equal(
    classifyArchive(`/data/file.7z.${MAX_VOLUME_NUMBER}`).partNumber,
    MAX_VOLUME_NUMBER,
  );
  assert.equal(classifyArchive("/data/file.r00").partNumber, 2);
});

test("A2 missingRange returns the full list when it is small", () => {
  const result = missingRange([1, 3], 1, 3);
  assert.deepEqual(result.values, [2]);
  assert.equal(result.total, 1);
  assert.equal(result.truncated, false);
});

test("A2 missingRange caps the loop at MAX_VOLUME_NUMBER", () => {
  const result = missingRange([1], 1, 999999999);
  assert.equal(result.total, MAX_VOLUME_NUMBER - 1);
  assert.equal(result.values.length, MAX_MISSING_ENUM);
  assert.equal(result.values[0], 2);
  assert.equal(result.values.at(-1), MAX_MISSING_ENUM + 1);
  assert.equal(result.truncated, true);
});

test("A2 collectVolumeNames caps the missing enumeration", () => {
  const selection = classifyArchive("/data/file.7z.001");
  const directoryNames = ["file.7z.001", "file.7z.999999999"];
  const result = collectVolumeNames(selection, directoryNames);

  assert.equal(result.missingParts.length, MAX_MISSING_ENUM);
  assert.equal(result.missingTotal, MAX_VOLUME_NUMBER - 1);
  assert.equal(result.missingTruncated, true);
});

test("A2 collectVolumeNames keeps missingParts a plain number array", () => {
  const selection = classifyArchive("/data/file.7z.001");
  const result = collectVolumeNames(selection, ["file.7z.001", "file.7z.003"]);
  assert.deepEqual(result.missingParts, [2]);
  assert.equal(result.missingTotal, 1);
  assert.equal(result.missingTruncated, false);
});

// -------------------------------------------------- A2：真实 fs 上的文案

function makeArchiveDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-archive-"));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "");
  }
  return dir;
}

const SEVEN_ZIP_STUB = { path: "/nonexistent/7zzs", source: "bundled" };

test("A2 inspectArchive reports the plain missing-volume wording", () => {
  const dir = makeArchiveDir(["file.7z.001", "file.7z.003"]);
  const archive = inspectArchive(path.join(dir, "file.7z.001"), {
    sevenZip: SEVEN_ZIP_STUB,
  });

  assert.equal(archive.partCount, 2);
  assert.deepEqual(archive.missingParts, [2]);
  assert.deepEqual(archive.warnings, ["检测到分卷缺失：2"]);
});

test("A2 inspectArchive summarizes a huge missing range instead of listing it", () => {
  const dir = makeArchiveDir(["file.7z.001", "file.7z.999999999"]);
  const archive = inspectArchive(path.join(dir, "file.7z.001"), {
    sevenZip: SEVEN_ZIP_STUB,
  });

  assert.equal(archive.warnings.length, 1);
  assert.match(archive.warnings[0], /至少 9999 个/);
  assert.ok(
    archive.warnings[0].length < 1000,
    "警告文案必须有界，不能把上万个分卷号整串拼出来",
  );
  assert.equal(archive.missingParts.length, MAX_MISSING_ENUM);
});

test("A2 inspectArchive rejects a backup name that only looks like a split volume", () => {
  const dir = makeArchiveDir(["backup.20260915"]);
  assert.throws(
    () => inspectArchive(path.join(dir, "backup.20260915"), {
      sevenZip: SEVEN_ZIP_STUB,
    }),
    /当前文件类型不支持/,
  );
});
