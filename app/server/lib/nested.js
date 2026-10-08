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
 * 判断一份「压缩格式选择元数据」是否代表嵌套 TAR 场景
 * （外层是 .tar.gz / .tar.bz2 这类单文件压缩，里面裹着唯一一个 .tar）。
 * 判定依据是元数据上的 innerFormat 标记，由 classifyArchive 写入。
 */
function isNestedTar(selection) {
  return selection?.innerFormat === "tar";
}

/**
 * 构造「进入内层 TAR」时使用的选择元数据：
 * 外层压缩已被解开，接下来按单一 tar 归档处理，innerFormat 清空。
 */
function innerTarSelection() {
  return {
    kind: "single",
    format: "tar",
    type: "tar",
    innerFormat: null,
  };
}

/**
 * 构造一个带错误码的嵌套归档错误。
 */
function nestedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 广度优先遍历 rootDir，收集全部「内层 .tar 文件」的物理路径。
 *
 * 设计约束（与原实现语义严格一致）：
 *   - 遇到符号链接立即抛 UNSAFE_PATH（防目录穿越）；
 *   - 只认扩展名 .tar（大小写不敏感）的普通文件；
 *   - 目录递归下钻，文件不递归。
 * 这里先把整棵树扫完再交给上层判定唯一性，
 * 而不是边扫边提前抛错——两者结果等价，但收集与判定分离更清晰。
 */
function collectInnerTars(rootDir) {
  const found = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw nestedError("UNSAFE_PATH", "压缩包外层包含不支持的符号链接");
      }
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (entry.isFile() && /\.tar$/i.test(entry.name)) {
        found.push(entryPath);
      }
    }
  }
  return found;
}

/**
 * 在外层解压出的目录树里定位「唯一的内层 TAR 归档」。
 *
 * 「必须唯一」的语义：树里恰好有 1 个 .tar 才算支持；
 * 0 个（不是嵌套 tar）或 2 个及以上（无法确定解哪个）都抛 UNSUPPORTED。
 * 成功时返回该内层 TAR 的物理路径。
 */
function findNestedTar(rootDir) {
  const found = collectInnerTars(rootDir);
  if (found.length !== 1) {
    throw nestedError("UNSUPPORTED", "未找到唯一的内部 TAR 归档");
  }
  return found[0];
}

module.exports = {
  findNestedTar,
  innerTarSelection,
  isNestedTar,
};
