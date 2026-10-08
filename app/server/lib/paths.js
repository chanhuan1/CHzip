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
const { LIMITS, PERMISSIONS } = require("./constants");
const {
  collectAuthorizedPathCandidates,
  parsePathList,
} = require("./authorization-paths");

/**
 * 把路径规整为「可比较形态」：resolve 成绝对路径，
 * Windows 下统一小写（NTFS 大小写不敏感），POSIX 保持原样。
 */
function toComparablePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 判断 candidate 是否位于 root 之内（含 root 本身）。
 * 用 path.relative 而非字符串前缀比较，避免 "/vol1/ab" 被误判在 "/vol1/a" 内。
 */
function isPathInside(rootPath, candidatePath) {
  const root = toComparablePath(rootPath);
  const candidate = toComparablePath(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 断言目标存在、是目录、且应用对其有 读/写/执行 权限，否则抛错。
 */
function assertUsableDirectory(directoryPath) {
  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error("目标路径不是目录");
  }
  fs.accessSync(
    directoryPath,
    fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
  );
}

/**
 * 探测某路径在给定 mode 下是否可访问，返回布尔而不抛错。
 */
function probeAccess(directoryPath, mode) {
  try {
    fs.accessSync(directoryPath, mode);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 返回目录的「可浏览 / 可选中（可写）」两项能力。
 *
 * 访问性检查必须用 access(2) 而不是从 stat.mode 推断：fnOS 的共享目录授权
 * 走 ACL，stat.mode 不反映 ACL 授权结果。每子目录 stat+2×access 看似冗余，
 * 但换成 mode 位推断会在 ACL 场景误判——正确性优先于这 2 次 syscall。
 */
function getDirectoryCapabilities(directoryPath) {
  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) {
    return {
      canBrowse: false,
      canSelect: false,
    };
  }
  return {
    canBrowse: probeAccess(directoryPath, fs.constants.R_OK | fs.constants.X_OK),
    canSelect: probeAccess(directoryPath, fs.constants.W_OK | fs.constants.X_OK),
  };
}

/**
 * 授权根既可以是字符串路径，也可以是 { path } 对象，统一取出路径串。
 */
function pathOfRoot(root) {
  return typeof root === "string" ? root : root.path;
}

/**
 * 把一组授权根解析为 realpath 后的物理路径数组（符号链接归一）。
 */
function resolveRootPaths(roots) {
  return roots.map((root) => {
    const resolved = fs.realpathSync(pathOfRoot(root));
    return resolved;
  });
}

/**
 * 校验并把「用户选定的输出目录」解析为可写的物理路径。
 * 依次强制：绝对路径 -> 存在且可读写 -> 落在授权共享目录白名单内。
 * 任何一步失败都抛出中文错误（前端原样展示）。
 */
function resolveAuthorizedDirectory(candidatePath, roots) {
  if (!path.isAbsolute(candidatePath)) {
    throw new Error("目录必须使用绝对路径");
  }

  let resolved;
  try {
    resolved = fs.realpathSync(candidatePath);
    assertUsableDirectory(resolved);
  } catch (error) {
    throw new Error("目录不存在或应用没有读写权限");
  }

  let authorizedRoots;
  try {
    authorizedRoots = resolveRootPaths(roots);
  } catch (error) {
    throw new Error("授权共享目录不可用");
  }
  if (!authorizedRoots.some((root) => isPathInside(root, resolved))) {
    throw new Error("目标目录不在应用授权的共享目录内");
  }
  return resolved;
}

/**
 * 列出某授权目录的直接子目录（前端目录选择器的数据源）。
 * 只返回「子目录」、排除符号链接，并为每个子项附带可浏览/可选中能力；
 * 无任何能力的子目录直接不进树。结果按自然序（数字感知、忽略大小写）排序。
 */
function listAuthorizedDirectory(candidatePath, roots) {
  if (!path.isAbsolute(candidatePath)) {
    const error = new Error("目录必须使用绝对路径");
    error.code = "DIRECTORY_NOT_AUTHORIZED";
    throw error;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(candidatePath);
  } catch (cause) {
    const error = new Error("目录不存在或应用无法访问");
    error.code = "DIRECTORY_NOT_BROWSABLE";
    throw error;
  }
  const authorizedRoots = resolveRootPaths(roots);
  if (!authorizedRoots.some((root) => isPathInside(root, resolved))) {
    const error = new Error("目标目录不在应用授权的共享目录内");
    error.code = "DIRECTORY_NOT_AUTHORIZED";
    throw error;
  }
  const capabilities = getDirectoryCapabilities(resolved);
  if (!capabilities.canBrowse) {
    const error = new Error("应用无法浏览此目录");
    error.code = "DIRECTORY_NOT_BROWSABLE";
    throw error;
  }
  const children = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const childPath = path.join(resolved, entry.name);
      let childCapabilities = {
        canBrowse: false,
        canSelect: false,
      };
      try {
        childCapabilities = getDirectoryCapabilities(childPath);
      } catch (error) {
        // Keep an inaccessible directory out of the tree.
      }
      return {
        name: entry.name,
        path: childPath,
        type: "directory",
        ...childCapabilities,
      };
    })
    .filter((entry) => entry.canBrowse || entry.canSelect)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }));

  return {
    path: resolved,
    ...capabilities,
    children,
  };
}

/**
 * 把压缩包名清洗成「可用的输出目录名主干」：
 * 替换非法字符、去掉末尾的点与空白，空结果回退为 "archive"。
 */
function sanitizeOutputStem(outputStem) {
  const cleaned = String(outputStem || "archive")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim();
  return cleaned || "archive";
}

const MAX_OUTPUT_DIR_ATTEMPTS = LIMITS.MAX_OUTPUT_DIR_ATTEMPTS;
const MAX_OUTPUT_DIR_TIMEOUT_MS = 5000;

/**
 * 在 destinationRoot 下创建「不重名」的输出目录。
 * 首选 safeStem，冲突则依次追加 " (2)"、" (3)"…；受 maxAttempts 与
 * timeoutMs 双重限制，超限抛错。mkdir 用独占语义，撞名才重试。
 */
function createUniqueOutputDir(destinationRoot, outputStem, options = {}) {
  assertUsableDirectory(destinationRoot);
  const safeStem = sanitizeOutputStem(outputStem);
  const maxAttempts = options.maxAttempts || MAX_OUTPUT_DIR_ATTEMPTS;
  const timeoutMs = options.timeoutMs || MAX_OUTPUT_DIR_TIMEOUT_MS;
  const startTime = Date.now();

  for (let index = 1; index < maxAttempts; index += 1) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error("创建解压目录超时");
    }
    const name = index === 1 ? safeStem : `${safeStem} (${index})`;
    const candidate = path.join(destinationRoot, name);
    try {
      fs.mkdirSync(candidate, { mode: PERMISSIONS.MODE_DIR_OUTPUT });
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new Error(`无法创建解压目录：${error.message}`);
      }
    }
  }

  throw new Error("无法生成唯一的解压目录名称");
}

function defaultRootCandidates(
  archivePath,
  options = {},
) {
  return collectAuthorizedPathCandidates(archivePath, options);
}

function findArchiveAccessibleRoot(archivePath, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const realpathResolver = options.realpathResolver || fs.realpathSync;
  const capabilityResolver = options.capabilityResolver
    || getDirectoryCapabilities;
  const archiveDirectory = realpathResolver(pathApi.dirname(archivePath));
  if (platform === "win32") {
    return archiveDirectory;
  }

  // fnOS 共享目录结构: /vol<N>/<shareName>/<path>
  // 例如: /vol1/共享文件夹/文档/archive.zip
  // 我们需要找到共享目录的根路径 (/vol1/共享文件夹)
  const fnosSharePattern = options.fnosSharePattern
    || /^(\/vol\d+\/[^/]+\/[^/]+)(?:\/|$)/i;
  const match = archiveDirectory.match(fnosSharePattern);
  if (!match) {
    return archiveDirectory;
  }

  const boundary = match[1];
  let current = archiveDirectory;
  while (current !== boundary) {
    const parent = pathApi.dirname(current);
    if (
      parent === current
      || !(parent === boundary || parent.startsWith(`${boundary}/`))
    ) {
      break;
    }
    let capabilities;
    try {
      capabilities = capabilityResolver(parent);
    } catch (error) {
      break;
    }
    if (!capabilities.canBrowse) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * 汇总当前可用的授权根列表（目录选择器的根节点集合）。
 * 合并「环境/快照候选」与「压缩包所在可访问根」，逐项 realpath + 能力
 * 探测后去重，再剔除被更上层可浏览根包含的冗余项，最终按路径排序。
 */
function discoverAuthorizedRoots(archivePath, options = {}) {
  const capabilityResolver = options.capabilityResolver
    || getDirectoryCapabilities;
  const candidates = [
    ...(options.candidateRoots || defaultRootCandidates(archivePath)),
  ];
  try {
    candidates.push(findArchiveAccessibleRoot(archivePath, {
      capabilityResolver,
      platform: options.platform,
      realpathResolver: options.realpathResolver,
    }));
  } catch (error) {
    // The archive directory candidate remains available as a safe fallback.
  }
  const accessible = [];
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const capabilities = capabilityResolver(resolved);
      if (
        (capabilities.canBrowse || capabilities.canSelect)
        && !accessible.some((entry) => entry.path === resolved)
      ) {
        accessible.push({
          path: resolved,
          ...capabilities,
        });
      }
    } catch (error) {
      // Ignore paths that are absent or not granted to the application.
    }
  }

  accessible.sort((a, b) => a.path.length - b.path.length
    || a.path.localeCompare(b.path));
  const roots = [];
  for (const candidate of accessible) {
    if (!roots.some((root) => (
      root.canBrowse && isPathInside(root.path, candidate.path)
    ))) {
      roots.push(candidate);
    }
  }
  return roots.sort((a, b) => a.path.localeCompare(b.path, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

/**
 * 构造一个带错误码的目录操作错误（前端按 code 区分提示文案）。
 */
function makeDirectoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 校验「新建文件夹名」是否合法：非空、非 . / ..、长度受限、不含路径
 * 分隔符与控制字符。合法则返回清洗后的名字，否则抛 INVALID_DIRECTORY_NAME。
 */
function validateDirectoryName(name) {
  const value = String(name || "").trim();
  if (
    !value
    || value === "."
    || value === ".."
    || value.length > LIMITS.MAX_DIRECTORY_NAME_LENGTH
    || /[\/\\\x00-\x1f]/.test(value)
  ) {
    throw makeDirectoryError("INVALID_DIRECTORY_NAME", "文件夹名称无效");
  }
  return value;
}

/**
 * 在某授权父目录下「新建文件夹」（前端目录选择器的"新建"操作）。
 * 强制：父目录存在 -> 在白名单内 -> 可写 -> 名字合法 -> 创建成功；
 * 重名返回 DIRECTORY_EXISTS，其余失败映射为相应错误码。
 */
function createAuthorizedDirectory(parentPath, name, roots) {
  let parent;
  try {
    parent = fs.realpathSync(parentPath);
  } catch (cause) {
    throw makeDirectoryError("DIRECTORY_NOT_BROWSABLE", "父目录不存在或无法访问");
  }
  const authorizedRoots = resolveRootPaths(roots);
  if (!authorizedRoots.some((root) => isPathInside(root, parent))) {
    throw makeDirectoryError(
      "DIRECTORY_NOT_AUTHORIZED",
      "目标目录不在应用授权的共享目录内",
    );
  }
  const capabilities = getDirectoryCapabilities(parent);
  if (!capabilities.canSelect) {
    throw makeDirectoryError("DIRECTORY_NOT_WRITABLE", "应用无法写入此目录");
  }
  const safeName = validateDirectoryName(name);
  const destination = path.join(parent, safeName);
  try {
    fs.mkdirSync(destination, { mode: PERMISSIONS.MODE_DIR_OUTPUT });
  } catch (cause) {
    if (cause.code === "EEXIST") {
      throw makeDirectoryError("DIRECTORY_EXISTS", "同名文件夹已经存在");
    }
    throw makeDirectoryError("DIRECTORY_NOT_WRITABLE", "无法创建文件夹");
  }
  const resolved = fs.realpathSync(destination);
  return {
    name: safeName,
    path: resolved,
    ...getDirectoryCapabilities(resolved),
  };
}

module.exports = {
  createAuthorizedDirectory,
  createUniqueOutputDir,
  defaultRootCandidates,
  discoverAuthorizedRoots,
  findArchiveAccessibleRoot,
  getDirectoryCapabilities,
  isPathInside,
  listAuthorizedDirectory,
  resolveAuthorizedDirectory,
  sanitizeOutputStem,
  validateDirectoryName,
};
