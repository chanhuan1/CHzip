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
const { normalizeEntryPath } = require("./preview");

/**
 * 校验用户勾选的选择性解压路径清单。
 *
 * 逐条把路径规整后回查压缩包条目表：必须真实存在、必须是文件
 * （不允许目录占位）、自动去除重复勾选。任何一条不合法都抛错，
 * 让前端在创建任务前就能给出具体提示，而不是等解压中途失败。
 * 返回规整去重后的合法文件路径数组（保持用户勾选顺序）。
 */
function validateSelectedPaths(selectedPaths, entries) {
  if (!Array.isArray(selectedPaths) || selectedPaths.length === 0) {
    throw new Error("请选择至少一个文件");
  }

  const entryMap = new Map(entries.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const validated = [];

  for (const value of selectedPaths) {
    const normalized = normalizeEntryPath(value);
    const entry = entryMap.get(normalized);
    if (!entry) {
      throw new Error(`所选文件不存在于压缩包中：${normalized}`);
    }
    if (entry.type !== "file") {
      throw new Error(`选择性解压只能提交文件：${normalized}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      validated.push(normalized);
    }
  }

  return validated;
}

/**
 * 把已校验的勾选清单写入任务私有目录 selection.txt（每行一条）。
 * 目录 0700、文件 0600：清单本身不含敏感数据，但与密码文件同目录，
 * 沿用同样的收紧权限，worker 进程读完后随任务过期一起清理。
 */
function writeSelectionFile(jobDir, selectedPaths) {
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(jobDir, "selection.txt");
  fs.writeFileSync(filePath, `${selectedPaths.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

module.exports = {
  validateSelectedPaths,
  writeSelectionFile,
};
