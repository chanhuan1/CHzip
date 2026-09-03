"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  classifyArchive,
  collectVolumeNames,
  stripKnownExtension,
} = require("../app/server/lib/archive");

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
