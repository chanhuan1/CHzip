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
 * 把 stat.mode 格式化为三位八进制权限串（如 "0644"），供诊断报告展示。
 */
function modeString(mode) {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/**
 * 诊断信息里展示路径时只取文件名，避免把完整目录结构泄露进日志/前端。
 */
function displayName(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return "";
  }
  const basename = path.basename(filePath);
  return basename || filePath;
}

/**
 * 按错误码生成面向用户的中文提示（文件名脱敏后拼接）。
 */
function describeSourceError(code, filePath) {
  const name = displayName(filePath);
  if (code === "SOURCE_NOT_FOUND") {
    return `源文件不存在：${name}`;
  }
  if (code === "SOURCE_PARENT_DENIED") {
    return `应用无法遍历源文件所在目录：${name}`;
  }
  if (code === "SOURCE_FILE_DENIED") {
    return `应用无法读取源文件：${name}（请检查现有文件 ACL，目录授权不等于文件 ACL 已更新）`;
  }
  if (code === "SOURCE_REALPATH_FAILED") {
    return `无法解析源文件真实路径：${name}`;
  }
  return `源路径不可用：${name}`;
}

/**
 * 把底层 fs 错误（ENOENT/EACCES/…）归类为带 SOURCE_* 错误码、
 * 含中文提示与诊断上下文的结构化错误。stage 区分是遍历父目录
 * 还是读取文件本身时报错，两者映射到不同的错误码。
 */
function classifySourceError(error, filePath, stage = "file") {
  let code = "SOURCE_REALPATH_FAILED";
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    code = "SOURCE_NOT_FOUND";
  } else if (error?.code === "EACCES" || error?.code === "EPERM") {
    code = stage === "parent"
      ? "SOURCE_PARENT_DENIED"
      : "SOURCE_FILE_DENIED";
  }
  const classified = new Error(describeSourceError(code, filePath));
  classified.code = code;
  classified.errno = error?.errno ?? null;
  classified.syscall = error?.syscall || "";
  classified.path = filePath;
  classified.cause = error;
  return classified;
}

/**
 * 采集当前进程的「应用身份」（uid/gid/groups），供诊断报告说明
 * 应用是以什么身份去访问源文件的。三项都可注入替身便于测试。
 */
function currentIdentity(options = {}) {
  const getuid = options.getuid || process.getuid?.bind(process);
  const getgid = options.getgid || process.getgid?.bind(process);
  const getgroups = options.getgroups || process.getgroups?.bind(process);
  return {
    uid: typeof getuid === "function" ? getuid() : null,
    gid: typeof getgid === "function" ? getgid() : null,
    groups: typeof getgroups === "function" ? getgroups() : [],
  };
}

/**
 * 把绝对路径拆成「从根到目标」的逐级祖先路径数组（不含目标文件本身），
 * 用于逐级 stat+access 检查每一级祖先目录的可遍历性。
 */
function ancestorPaths(absolutePath, pathModule = path) {
  const parsed = pathModule.parse(absolutePath);
  const parts = absolutePath
    .slice(parsed.root.length)
    .split(pathModule.sep)
    .filter(Boolean);
  const components = [];
  let current = parsed.root;
  if (current) {
    components.push(current);
  }
  for (const part of parts.slice(0, -1)) {
    current = pathModule.join(current, part);
    components.push(current);
  }
  return components;
}

/**
 * 生成单个路径组件的诊断快照（路径/类型/权限/属主/是否可访问）。
 */
function componentReport(filePath, stat, type, accessible) {
  return {
    path: filePath,
    type,
    mode: modeString(stat.mode),
    uid: Number.isFinite(stat.uid) ? stat.uid : null,
    gid: Number.isFinite(stat.gid) ? stat.gid : null,
    accessible,
  };
}

/**
 * 检查源文件的可访问性并产出结构化诊断报告。
 *
 * 流程：逐级校验祖先目录可遍历 -> realpath 解析 -> 校验是普通文件且可读。
 * 任一步失败都抛 classifySourceError 归类的错误，并携带已收集的组件链
 * 供诊断。成功则返回含 size/mtime/权限/属主的完整报告。
 *
 * options.verifiedComponents 是可选的祖先目录校验缓存：同一目录下的多个
 * 文件（典型场景是分卷压缩包，20 个分卷深 6 级目录）祖先链完全相同，
 * 逐个重跑 stat+access 是纯浪费。只缓存校验成功的目录，不放任任何一级。
 */
function inspectSourceFile(filePath, options = {}) {
  const fsModule = options.fsModule || fs;
  const pathModule = options.pathModule || path;
  const application = currentIdentity(options);
  const verifiedComponents = options.verifiedComponents || null;
  if (!filePath || typeof filePath !== "string" || !pathModule.isAbsolute(filePath)) {
    const error = new Error("源文件路径必须是绝对路径");
    error.code = "SOURCE_PATH_INVALID";
    throw error;
  }

  const resolvedPath = pathModule.resolve(filePath);
  const components = [];
  const checkedComponents = new Set();
  const pathParts = ancestorPaths(resolvedPath, pathModule);

  for (const component of pathParts) {
    if (checkedComponents.has(component)) {
      continue;
    }
    checkedComponents.add(component);
    const cached = verifiedComponents && verifiedComponents.get(component);
    if (cached) {
      components.push(cached);
      continue;
    }
    let stat;
    try {
      stat = fsModule.statSync(component);
      if (stat.isDirectory()) {
        fsModule.accessSync(component, fs.constants.X_OK);
      }
      const report = componentReport(component, stat, "directory", true);
      components.push(report);
      if (verifiedComponents) {
        verifiedComponents.set(component, report);
      }
    } catch (error) {
      if (stat) {
        components.push(componentReport(component, stat, "directory", false));
      }
      const classified = classifySourceError(error, component, "parent");
      classified.diagnostic = {
        application,
        components,
      };
      throw classified;
    }
  }

  let resolved;
  try {
    resolved = fsModule.realpathSync(filePath);
  } catch (error) {
    const classified = classifySourceError(error, filePath, "realpath");
    classified.diagnostic = {
      application,
      components,
    };
    throw classified;
  }

  let stat;
  try {
    stat = fsModule.statSync(resolved);
    if (!stat.isFile()) {
      const error = new Error("源路径不是普通文件");
      error.code = "SOURCE_NOT_FILE";
      error.path = resolved;
      throw error;
    }
    fsModule.accessSync(resolved, fs.constants.R_OK);
  } catch (error) {
    if (error.code === "SOURCE_NOT_FILE") {
      throw error;
    }
    if (stat) {
      components.push(componentReport(resolved, stat, "file", false));
    }
    const classified = classifySourceError(error, resolved, "file");
    classified.diagnostic = {
      application,
      components,
    };
    throw classified;
  }

  components.push(componentReport(resolved, stat, "file", true));
  return {
    path: resolved,
    readable: true,
    mode: modeString(stat.mode),
    uid: Number.isFinite(stat.uid) ? stat.uid : null,
    gid: Number.isFinite(stat.gid) ? stat.gid : null,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    application,
    components,
    stat,
  };
}

module.exports = {
  classifySourceError,
  inspectSourceFile,
  modeString,
};
