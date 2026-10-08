#!/usr/bin/env node
/*
 * CHzip - fnOS 智能分卷解压套件
 * Copyright (C) 2026 chanhuan
 *
 * 本程序是自由软件：你可以依据自由软件基金会发布的
 * GNU 通用公共许可证第 3 版（或更高版本，由你选择）的条款，
 * 再分发和/或修改本程序。
 *
 * 发布本程序是希望它能有用，但不附带任何担保；
 * 甚至不附带适销性或特定用途适用性的默示担保。
 * 详见 GNU 通用公共许可证（仓库根目录 LICENSE 文件）。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * 打进 fpk 的仓库顶层条目（白名单制，之外的文件一律不进包）。
 */
const PACKAGE_ITEMS = [
  "ICON.PNG",
  "ICON_256.PNG",
  "app",
  "cmd",
  "config",
  "manifest",
];

/**
 * 各目标平台的配置：vendorDir 是包内 7-Zip 目录名，
 * suffix 是产物文件名里的架构后缀。该形状被 audit-fpk 复用，勿改字段名。
 */
const PLATFORM_CONFIG = {
  x86: {
    vendorDir: "linux-x64",
    suffix: "x86_64",
  },
  arm: {
    vendorDir: "linux-arm64",
    suffix: "arm64",
  },
};

/**
 * 构建变体。当前只有默认变体（空串），预留多发行形态扩展位。
 */
const BUILD_VARIANTS = [""];

/**
 * cpSync 的过滤回调：跳过 macOS 的 .DS_Store 与 AppleDouble(._*)垃圾文件。
 */
function isJunkFile(source) {
  const base = path.basename(source);
  return base === ".DS_Store" || base.startsWith("._");
}

/**
 * 安全闸：断言 candidate 位于 root 之内，防止路径计算错误时误删/误写
 * 构建目录之外的文件。
 */
function assertWithinRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify path outside build root: ${candidate}`);
  }
}

/**
 * 把 staging 里 manifest 的 platform 字段改写为目标平台（x86/arm）。
 * 若 manifest 缺 platform 行则追加一行。
 */
function setManifestPlatform(manifestPath, platform) {
  const original = fs.readFileSync(manifestPath, "utf8");
  const updated = /^platform\s*=.*$/m.test(original)
    ? original.replace(/^platform\s*=.*$/m, `platform              = ${platform}`)
    : `${original.trimEnd()}\nplatform              = ${platform}\n`;
  fs.writeFileSync(manifestPath, updated, "utf8");
}

/**
 * 给需要可执行权限的条目补 755：CGI 入口、内置 7zzs、cmd 全部脚本。
 */
function markExecutables(stageDir, vendorDir) {
  for (const relativePath of [
    "app/ui/api.cgi",
    "app/ui/index.cgi",
    `app/vendor/7zip/${vendorDir}/7zzs`,
  ]) {
    fs.chmodSync(path.join(stageDir, relativePath), 0o755);
  }
  for (const name of fs.readdirSync(path.join(stageDir, "cmd"))) {
    fs.chmodSync(path.join(stageDir, "cmd", name), 0o755);
  }
}

/**
 * 统一 staging 目录树的权限：目录 755、文件 644，再补可执行条目。
 * fnpack 打包对权限敏感，这一步保证产物内权限位确定。
 */
function normalizeModes(stageDir, vendorDir) {
  const stack = [stageDir];
  while (stack.length) {
    const current = stack.pop();
    fs.chmodSync(current, 0o755);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        fs.chmodSync(entryPath, 0o644);
      }
    }
  }
  markExecutables(stageDir, vendorDir);
}

/**
 * 铺一份某个平台的 staging 目录：复制白名单条目 -> 改写 manifest
 * platform -> 剔除另一架构的 7zzs -> 统一权限。返回 staging 目录路径。
 */
function prepareStage({
  rootDir,
  buildRoot,
  platform,
  variant = "",
}) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!BUILD_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported variant: ${variant}`);
  }

  const stageDir = path.join(buildRoot, variant ? `CHzip-${variant}-${platform}` : `CHzip-${platform}`);
  assertWithinRoot(buildRoot, stageDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const item of PACKAGE_ITEMS) {
    fs.cpSync(path.join(rootDir, item), path.join(stageDir, item), {
      recursive: true,
      force: true,
      filter: (source) => !isJunkFile(source),
    });
  }

  setManifestPlatform(path.join(stageDir, "manifest"), platform);
  const vendorRoot = path.join(stageDir, "app", "vendor", "7zip");
  for (const directory of ["linux-x64", "linux-arm64"]) {
    if (directory !== config.vendorDir) {
      fs.rmSync(path.join(vendorRoot, directory), {
        recursive: true,
        force: true,
      });
    }
  }
  normalizeModes(stageDir, config.vendorDir);
  return stageDir;
}

/**
 * 从 manifest 文本里解析 version 字段（如 "4.2"）。缺失即抛错，
 * 因为产物文件名与版本门禁都依赖它。
 */
function parseVersion(manifestPath) {
  const match = fs.readFileSync(manifestPath, "utf8")
    .match(/^version\s*=\s*(\S+)/m);
  if (!match) {
    throw new Error("Manifest version is missing");
  }
  return match[1];
}

/**
 * 生成产物文件名：CHzip_<version>[_<variant>]_<archSuffix>.fpk。
 * 命名规则被 version.test.js 与 audit-fpk.js 共同依赖，勿改格式。
 */
function packageFileName(version, variant, platform) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!BUILD_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported variant: ${variant}`);
  }
  return variant ? `CHzip_${version}_${variant}_${config.suffix}.fpk` : `CHzip_${version}_${config.suffix}.fpk`;
}

/**
 * 构建单个平台的 fpk：prepareStage 铺目录 -> 调 fnpack build ->
 * 把产出的 CHzip.fpk 改名为带版本/架构的标准名。返回产物路径。
 * fnpack 的调用方式与产物结构在此被锁定，改动会直接影响能否安装。
 */
function buildPlatform({
  rootDir,
  buildRoot,
  distDir,
  platform,
  variant = "",
  fnpackPath,
}) {
  const stageDir = prepareStage({
    rootDir,
    buildRoot,
    platform,
    variant,
  });
  fs.mkdirSync(distDir, { recursive: true });
  const result = spawnSync(fnpackPath, ["build", "--directory", stageDir], {
    cwd: distDir,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`fnpack failed for ${platform} with exit code ${result.status}`);
  }

  const generatedPath = path.join(distDir, "CHzip.fpk");
  if (!fs.existsSync(generatedPath)) {
    throw new Error(`fnpack did not create ${generatedPath}`);
  }
  const version = parseVersion(path.join(stageDir, "manifest"));
  const outputPath = path.join(
    distDir,
    packageFileName(version, variant, platform),
  );
  fs.rmSync(outputPath, { force: true });
  fs.renameSync(generatedPath, outputPath);
  return outputPath;
}

/**
 * 解析命令行参数（--stage-only / --platform / --variant / --fnpack），
 * 返回带默认值的构建选项对象。遇到未知参数立即抛错。
 */
function parseArguments(argv) {
  const options = {
    platforms: ["x86", "arm"],
    variants: [""],
    stageOnly: false,
    fnpackPath: process.env.FNPACK_PATH || "fnpack",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--stage-only") {
      options.stageOnly = true;
    } else if (value === "--platform") {
      const platform = argv[index + 1];
      index += 1;
      options.platforms = platform === "all" ? ["x86", "arm"] : [platform];
    } else if (value === "--variant") {
      const variant = argv[index + 1];
      index += 1;
      options.variants = variant === "all"
        ? [...BUILD_VARIANTS]
        : [variant];
    } else if (value === "--fnpack") {
      options.fnpackPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function main() {
  const rootDir = path.resolve(__dirname, "..");
  const buildRoot = path.join(rootDir, "build", "staging");
  const distDir = path.join(rootDir, "dist");
  const options = parseArguments(process.argv.slice(2));
  for (const variant of options.variants) {
    for (const platform of options.platforms) {
      if (options.stageOnly) {
        console.log(prepareStage({
          rootDir,
          buildRoot,
          platform,
          variant,
        }));
        continue;
      }
      // prepareStage 由 buildPlatform 内部调用；此处不要重复调用，
      // 否则会把刚铺好的 staging 立刻删掉再重铺一遍（纯浪费 I/O）。
      const outputPath = buildPlatform({
        rootDir,
        buildRoot,
        distDir,
        platform,
        variant,
        fnpackPath: options.fnpackPath,
      });
      console.log(outputPath);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BUILD_VARIANTS,
  PLATFORM_CONFIG,
  buildPlatform,
  normalizeModes,
  packageFileName,
  parseArguments,
  parseVersion,
  prepareStage,
};
