#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  BUILD_VARIANTS,
  PLATFORM_CONFIG,
  packageFileName,
  parseVersion,
} = require("./build-fpk");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const checksumPath = path.join(distDir, "SHA256SUMS.txt");
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
const FONT_SHA256 = "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3";
const LICENSE_SHA256 = "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a";

// ELF e_machine：x86-64 = 62，AArch64 = 183。
const ELF_MACHINE = Object.freeze({ x86: 62, arm: 183 });

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 版本号、包名与 7zzs 路径全部由 build-fpk 的导出推导。
// 发布清单里版本号本来就要手动同步 4 处，audit 曾经又硬编码 3 处
// （两个 fileName + 一处 manifest 版本正则），改一次版本要动 7 个地方。
const version = parseVersion(path.join(rootDir, "manifest"));
const packages = [];
for (const variant of BUILD_VARIANTS) {
  for (const platform of Object.keys(PLATFORM_CONFIG)) {
    const vendorDir = PLATFORM_CONFIG[platform].vendorDir;
    const otherVendorDir = Object.keys(PLATFORM_CONFIG)
      .filter((name) => name !== platform)
      .map((name) => PLATFORM_CONFIG[name].vendorDir)[0];
    packages.push({
      fileName: packageFileName(version, variant, platform),
      variant,
      platform,
      sevenZipPath: `vendor/7zip/${vendorDir}/7zzs`,
      unexpectedSevenZipPath: `vendor/7zip/${otherVendorDir}/7zzs`,
      machine: ELF_MACHINE[platform],
    });
  }
}

function runTar(args, input) {
  const result = spawnSync(tarCommand, args, {
    cwd: rootDir,
    input,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${tarCommand} ${args.join(" ")} failed:\n${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout;
}

function outerEntry(packagePath, entryPath) {
  return runTar(["-xOf", packagePath, entryPath]);
}

function innerEntry(appArchive, entryPath) {
  return runTar(["-xOzf", "-", entryPath], appArchive);
}

function innerEntries(appArchive) {
  return new Set(
    runTar(["-tzf", "-"], appArchive)
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean),
  );
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readExpectedPackageHashes() {
  assert.equal(fs.existsSync(checksumPath), true, "missing SHA256SUMS.txt");
  const entries = new Map();
  for (const line of fs.readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) {
      entries.set(match[2], match[1].toLowerCase());
    }
  }
  return entries;
}

const expectedPackageHashes = readExpectedPackageHashes();

function auditPackage(config) {
  const packagePath = path.join(distDir, config.fileName);
  assert.equal(fs.existsSync(packagePath), true, `missing ${config.fileName}`);
  assert.equal(
    sha256(fs.readFileSync(packagePath)),
    expectedPackageHashes.get(config.fileName),
    `${config.fileName} does not match SHA256SUMS.txt`,
  );

  const manifest = outerEntry(packagePath, "manifest").toString("utf8");
  assert.match(
    manifest,
    new RegExp(`^version\\s*=\\s*${escapeRegExp(version)}$`, "m"),
  );
  assert.match(
    manifest,
    new RegExp(`^platform\\s*=\\s*${config.platform}$`, "m"),
  );

  const appArchive = outerEntry(packagePath, "app.tgz");
  const entries = innerEntries(appArchive);
  assert.equal(entries.has(config.sevenZipPath), true);
  assert.equal(
    entries.has(config.unexpectedSevenZipPath),
    false,
    `${config.fileName} contains unexpected 7-Zip architecture`,
  );
  const font = innerEntry(appArchive, "www/fonts/InterVariable.woff2");
  const license = innerEntry(appArchive, "www/fonts/LICENSE-Inter.txt");
  const css = innerEntry(appArchive, "www/css/style.css").toString("utf8");
  const html = innerEntry(appArchive, "www/index.html").toString("utf8");
  const treeJs = innerEntry(appArchive, "www/js/tree.js").toString("utf8");
  const appJs = innerEntry(appArchive, "www/js/app.js").toString("utf8");
  const sevenZip = innerEntry(appArchive, config.sevenZipPath);

  assert.equal(sha256(font), FONT_SHA256);
  assert.equal(sha256(license), LICENSE_SHA256);
  assert.match(license.toString("utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(css, /@font-face/);
  assert.match(css, /font-family:\s*"Inter Variable"/);
  assert.match(css, /InterVariable\.woff2\?v=4\.1/);
  assert.match(html, /id="treeSearchInput"/);
  assert.match(treeJs, /createSearchScheduler/);
  assert.match(treeJs, /renderBatches/);
  assert.match(appJs, /createSearchScheduler\(\{\s*delay:\s*180/);
  assert.equal(sevenZip.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(sevenZip.readUInt16LE(18), config.machine);

  // 后端 JS 内容断言：audit 此前只查 manifest/7zzs/字体/css，不验证打包进去
  // 的 server 代码是不是当前版本。一旦「bump 后忘了重新打包」或 staging 残留
  // 旧代码，这些关键标记会对不上。每个标记都是对应版本里引入的符号，
  // 随版本演进可增补。
  const serverChecks = [
    ["server/api.js", ["QUIET_SUCCESS_APIS", "CLEANUP_APIS", "routeRequest"]],
    ["server/lib/paths.js", ["resolveAuthorizedDirectory", "isPathInside"]],
    ["server/lib/worker.js", ["markStartupFailure", "registerProcessGroup", "cleanupJobArtifacts"]],
    ["server/lib/services.js", ["createServices", "toJobView", "withPreparedArchive"]],
    ["server/lib/engine.js", ["classifySevenZipError", "createProgressTracker"]],
    ["server/lib/constants.js", ["PREVIEW_FILE_MS", "MAX_CONCURRENT_EXTRACTS"]],
    ["server/lib/diagnostics.js", ["redactDiagnosticValue", "createDiagnosticLogger"]],
  ];
  for (const [entryPath, markers] of serverChecks) {
    const content = innerEntry(appArchive, entryPath).toString("utf8");
    for (const marker of markers) {
      assert.ok(
        content.includes(marker),
        `${config.fileName} 的 ${entryPath} 缺少预期标记 ${marker}（可能是旧代码）`,
      );
    }
  }

  console.log(`${config.fileName}: release audit passed`);
}

for (const config of packages) {
  auditPackage(config);
}
