"use strict";

// 固实（solid）压缩包无法随机访问：取出其中任意一个文件，7-Zip 都必须从
// 固实块开头一路解压到目标位置。代价由**压缩包体积**决定，与目标文件大小
// 无关 —— 1GB+ 的固实 RAR 预览一个几 KB 的 txt，也会让一个核跑满很久。
//
// 这里锁定两件事：
//   1. preview-file 必须有超时，且超时后**真的把 7z 子进程杀掉**（否则它会
//      在后台继续烧 CPU —— 这是本次修复的核心）；
//   2. 固实标记能从已有的 `7z l -slt` 输出里零成本读出来，并随 preview 返回。
//
// 手法：用**真实 shell 脚本**冒充 7z（内置 7zzs 是 Linux ELF，macOS 跑不了），
// 这样超时、杀进程、二进制透传都是真跑出来的，不是替身假装。

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createServices } = require("../app/server/lib/services");
const { runSevenZipSync } = require("../app/server/lib/engine");
const { detectTechnicalListProperties } = require("../app/server/lib/preview");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-preview-timeout-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFakeTool(name, body) {
  const scriptPath = path.join(tmpDir, name);
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeArchive(name = "a.zip") {
  const archivePath = path.join(tmpDir, name);
  fs.writeFileSync(archivePath, "fake-archive");
  return archivePath;
}

function createPreviewServices(toolPath, overrides = {}) {
  return createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: toolPath, source: "test" }),
    // previewFile 现在走 runSync（= runSevenZipSync）以继承超时与错误分类，
    // 所以这里必须注入真实实现，不能让它被替身拦下。
    runSync: runSevenZipSync,
    discoverRoots: () => [{ path: tmpDir, canBrowse: true, canSelect: true }],
    ...overrides,
  });
}

// ------------------------------------------------- 超时与杀进程

test("previewFile reports PREVIEW_TIMEOUT when 7z exceeds the deadline", async () => {
  const tool = writeFakeTool("slow.sh", "sleep 10");
  const archivePath = writeArchive();
  const services = createPreviewServices(tool, { previewFileTimeoutMs: 300 });

  const startedAt = Date.now();
  await assert.rejects(
    () => services.previewFile({ path: archivePath, targetPath: "inner.txt" }),
    (error) => {
      assert.equal(error.code, "PREVIEW_TIMEOUT");
      // 文案必须点出真实原因，否则用户只会看到一次莫名其妙的失败。
      assert.match(error.message, /固实/);
      return true;
    },
  );
  assert.ok(
    Date.now() - startedAt < 5000,
    "超时应当立刻生效，而不是等 sleep 跑完",
  );
});

test("previewFile timeout message states the deadline without rounding to zero", async () => {
  // 短超时曾被 Math.round 成「0 秒」——文案必须对任意超时值都成立。
  const tool = writeFakeTool("slow-short.sh", "sleep 10");
  const archivePath = writeArchive();
  const services = createPreviewServices(tool, { previewFileTimeoutMs: 1500 });

  await assert.rejects(
    () => services.previewFile({ path: archivePath, targetPath: "inner.txt" }),
    (error) => {
      assert.equal(error.code, "PREVIEW_TIMEOUT");
      assert.match(error.message, /已超过 1\.5 秒/);
      return true;
    },
  );
});

test("previewFile actually kills the 7z process on timeout", async () => {
  // 脚本先睡 2 秒，然后写一个 marker。若超时只是"放弃等待"而没有真的杀掉
  // 子进程，2 秒后 marker 就会出现。
  const marker = path.join(tmpDir, "still-running.txt");
  const tool = writeFakeTool("killed.sh", `sleep 2\ntouch "${marker}"`);
  const archivePath = writeArchive();
  const services = createPreviewServices(tool, { previewFileTimeoutMs: 200 });

  await assert.rejects(
    () => services.previewFile({ path: archivePath, targetPath: "inner.txt" }),
    (error) => error.code === "PREVIEW_TIMEOUT",
  );

  // 等到脚本本该写出 marker 的时间点之后。
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(
    fs.existsSync(marker),
    false,
    "超时后 7z 子进程必须被真的杀掉，否则它会继续占满一个核",
  );
});

test("previewFile returns content when 7z finishes within the deadline", async () => {
  const tool = writeFakeTool("fast.sh", "printf 'hello'");
  const archivePath = writeArchive();
  const services = createPreviewServices(tool, { previewFileTimeoutMs: 10 * 1000 });

  const result = await services.previewFile({
    path: archivePath,
    targetPath: "inner.txt",
  });
  assert.equal(result.content, "hello");
  assert.equal(result.encoding, "utf8");
  assert.equal(result.fileName, "inner.txt");
});

test("previewFile keeps binary bytes intact for images (encoding null)", async () => {
  // 0x00 0xFF 0x10 —— 一旦被 UTF-8 解码就会变成替换字符，图片会损坏。
  const tool = writeFakeTool("binary.sh", "printf '\\000\\377\\020'");
  const archivePath = writeArchive();
  const services = createPreviewServices(tool, { previewFileTimeoutMs: 10 * 1000 });

  const result = await services.previewFile({
    path: archivePath,
    targetPath: "pic.png",
  });
  assert.equal(result.encoding, "base64");
  assert.equal(
    Buffer.from(result.content, "base64").toString("hex"),
    "00ff10",
  );
});

// ------------------------------------------------- 固实标记检测

test("detectTechnicalListProperties reports a solid archive", () => {
  const listing = [
    "Listing archive: big.rar",
    "",
    "--",
    "Path = big.rar",
    "Type = Rar5",
    "Physical Size = 1234567890",
    "Solid = +",
    "Blocks = 1",
    "",
    "----------",
    "Path = inner.txt",
    "Size = 12",
    "Attributes = A",
    "",
  ].join("\n");

  const properties = detectTechnicalListProperties(listing);
  assert.equal(properties.solid, true);
  assert.equal(properties.format, "rar5");
  assert.equal(properties.blocks, 1);
});

test("detectTechnicalListProperties reports a non-solid archive", () => {
  const listing = [
    "Path = a.zip",
    "Type = zip",
    "Physical Size = 2048",
    "Solid = -",
    "",
    "----------",
    "Path = inner.txt",
    "Size = 12",
    "",
  ].join("\n");

  const properties = detectTechnicalListProperties(listing);
  assert.equal(properties.solid, false);
  assert.equal(properties.format, "zip");
});

test("detectTechnicalListProperties defaults to non-solid when the field is absent", () => {
  const listing = "Path = a.zip\nType = zip\n\n----------\nPath = inner.txt\n\n";
  const properties = detectTechnicalListProperties(listing);
  assert.equal(properties.solid, false);
  assert.equal(properties.format, "zip");
});

test("services.preview surfaces the solid flag from the listing", async () => {
  const archivePath = writeArchive("solid.zip");
  const services = createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: process.execPath, source: "test" }),
    runSync: () => ({
      exitCode: 0,
      log: "",
      stdout: "Path = solid.rar\nType = Rar5\nSolid = +\n\n"
        + "----------\nPath = inner.txt\nSize = 12\nAttributes = A\n\n",
      stderr: "",
    }),
    discoverRoots: () => [{ path: tmpDir, canBrowse: true, canSelect: true }],
  });

  const result = await services.preview({ path: archivePath });
  assert.equal(result.solid, true);
  assert.equal(result.entries.length, 1);
});

// ------------------------------------------------- runSevenZipSync 的 encoding

test("runSevenZipSync keeps utf8 output by default", () => {
  const tool = { path: writeFakeTool("echo.sh", "printf '中文'"), source: "test" };
  const result = runSevenZipSync(tool, [], { cwd: tmpDir });
  assert.equal(typeof result.stdout, "string");
  assert.equal(result.stdout, "中文");
  assert.equal(result.log, "中文");
});

test("runSevenZipSync returns raw bytes when encoding is null", () => {
  const tool = {
    path: writeFakeTool("bytes.sh", "printf '\\000\\377\\020'"),
    source: "test",
  };
  const result = runSevenZipSync(tool, [], { cwd: tmpDir, encoding: null });
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.equal(result.stdout.toString("hex"), "00ff10");
  // 日志只用于错误分类，必须始终是可读文本，不能跟着变成 Buffer。
  assert.equal(typeof result.log, "string");
});
