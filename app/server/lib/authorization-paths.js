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

/**
 * 授权路径快照格式版本。fnOS 侧结构一旦变化，
 * 需要递增版本号并在 normalizeSnapshot 中做迁移。
 */
const SNAPSHOT_VERSION = 1;

/**
 * 生成一份空快照（版本号就位、列表为空、时间为空）。
 * 读取失败 / 版本不符 / 路径缺失时统一回退到它。
 */
function emptySnapshot() {
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: "",
    accessiblePaths: [],
    sharePaths: [],
  };
}

/**
 * 把「路径列表」的各种来源统一规整成去重后的绝对路径数组。
 *
 * 兼容三种输入：
 *   - JSON 数组字符串（fnOS 环境变量主流格式，如 '["/vol1","/vol2"]'）
 *   - 以 换行 / 分号 / 冒号 分隔的纯文本（历史与手工配置格式）
 *   - 直接传入的数组（normalizeSnapshot 内部复用本函数时）
 * 只保留非空的绝对路径，结果去重。
 */
function parsePathList(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }
  let values;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      values = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      values = [];
    }
  } else {
    values = text.split(/[\r\n;:]+/);
  }
  return Array.from(new Set(
    values
      .map((entry) => String(entry || "").trim())
      .filter((entry) => entry && path.isAbsolute(entry)),
  ));
}

/**
 * 把任意来源的快照对象规整为当前版本的规范形态。
 * 版本不符或结构非法时回退空快照，绝不把脏数据透传给白名单合并。
 */
function normalizeSnapshot(value) {
  if (!value || value.version !== SNAPSHOT_VERSION) {
    return emptySnapshot();
  }
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    accessiblePaths: Array.isArray(value.accessiblePaths)
      ? parsePathList(JSON.stringify(value.accessiblePaths))
      : [],
    sharePaths: Array.isArray(value.sharePaths)
      ? parsePathList(JSON.stringify(value.sharePaths))
      : [],
  };
}

/**
 * 读取磁盘上的授权路径快照。
 * 文件缺失、读失败或 JSON 非法都回退空快照——快照只是优化，
 * 缺失时仍可靠环境变量与压缩包所在目录兜底。
 */
function readAuthorizationSnapshot(snapshotPath) {
  if (!snapshotPath) {
    return emptySnapshot();
  }
  try {
    return normalizeSnapshot(JSON.parse(fs.readFileSync(snapshotPath, "utf8")));
  } catch (error) {
    return emptySnapshot();
  }
}

/**
 * 判断环境变量对象是否「显式携带」某个键（含值为空串的情况）。
 * 用 hasOwnProperty 而非真值判断：显式传空列表要覆盖旧快照，
 * 而「键不存在」才回退保留旧快照内容。
 */
function hasOwn(environment, name) {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

/**
 * 把环境变量里的授权目录写入快照文件（原子写 + 0600 权限）。
 *
 * 覆盖语义：环境变量里「显式存在」的键直接覆盖旧快照对应字段；
 * 「不存在」的键保留旧值，避免单次配置只动一类路径时误清另一类。
 * options.now 可注入时钟，便于测试产出确定性时间戳。
 */
function writeAuthorizationSnapshot(snapshotPath, environment, options = {}) {
  if (!snapshotPath) {
    throw new Error("授权路径快照位置无效");
  }
  const previous = readAuthorizationSnapshot(snapshotPath);
  const snapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: (options.now || (() => new Date()))().toISOString(),
    accessiblePaths: hasOwn(environment, "TRIM_DATA_ACCESSIBLE_PATHS")
      ? parsePathList(environment.TRIM_DATA_ACCESSIBLE_PATHS)
      : previous.accessiblePaths,
    sharePaths: hasOwn(environment, "TRIM_DATA_SHARE_PATHS")
      ? parsePathList(environment.TRIM_DATA_SHARE_PATHS)
      : previous.sharePaths,
  };
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, snapshotPath);
    fs.chmodSync(snapshotPath, 0o600);
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (error) {
      // The atomic rename already removed the temporary path.
    }
  }
  return snapshot;
}

/**
 * 汇总一次解压请求可用的授权目录候选：
 *   环境变量（实时） + 磁盘快照（安装/配置时落盘） + 压缩包所在目录。
 * 输出目录白名单校验以这份去重后的候选集为准。
 */
function collectAuthorizedPathCandidates(archivePath, options = {}) {
  const environment = options.environment || process.env;
  const snapshotPath = options.snapshotPath
    || (environment.TRIM_PKGVAR
      ? path.join(environment.TRIM_PKGVAR, "authorized-paths.json")
      : "");
  const snapshot = readAuthorizationSnapshot(snapshotPath);
  const candidates = [
    ...parsePathList(environment.TRIM_DATA_ACCESSIBLE_PATHS),
    ...parsePathList(environment.TRIM_DATA_SHARE_PATHS),
    ...snapshot.accessiblePaths,
    ...snapshot.sharePaths,
    path.dirname(archivePath),
  ];
  return Array.from(new Set(candidates));
}

module.exports = {
  SNAPSHOT_VERSION,
  collectAuthorizedPathCandidates,
  emptySnapshot,
  parsePathList,
  readAuthorizationSnapshot,
  writeAuthorizationSnapshot,
};
