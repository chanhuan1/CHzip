"use strict";

const fs = require("node:fs");
const path = require("node:path");

function isNestedTar(selection) {
  return selection?.innerFormat === "tar";
}

function innerTarSelection() {
  return {
    kind: "single",
    format: "tar",
    type: "tar",
    innerFormat: null,
  };
}

function findNestedTar(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const error = new Error("压缩包外层包含不支持的符号链接");
        error.code = "UNSAFE_PATH";
        throw error;
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && /\.tar$/i.test(entry.name)) {
        files.push(entryPath);
        // 「必须唯一」的语义不变：0 个或多个 .tar 都算不支持。
        // 一旦发现第 2 个就立刻失败，不必再遍历剩余子树。
        if (files.length > 1) {
          const error = new Error("未找到唯一的内部 TAR 归档");
          error.code = "UNSUPPORTED";
          throw error;
        }
      }
    }
  }
  if (files.length !== 1) {
    const error = new Error("未找到唯一的内部 TAR 归档");
    error.code = "UNSUPPORTED";
    throw error;
  }
  return files[0];
}

module.exports = {
  findNestedTar,
  innerTarSelection,
  isNestedTar,
};
