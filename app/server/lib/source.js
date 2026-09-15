"use strict";

const fs = require("node:fs");
const path = require("node:path");

// fs 可注入：单测用它制造「文件被换 / 被删」等场景，不必依赖真实时序。
function fingerprintFiles(filePaths, options = {}) {
  const fsModule = options.fsModule || fs;
  return filePaths.map((filePath) => {
    const resolvedPath = fsModule.realpathSync(filePath);
    const stat = fsModule.statSync(resolvedPath);
    return {
      path: resolvedPath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  });
}

function openSourceDescriptors(fingerprints, options = {}) {
  const fsModule = options.fsModule || fs;
  const descriptors = [];
  try {
    for (const fingerprint of fingerprints || []) {
      const fd = fsModule.openSync(fingerprint.path, "r");
      descriptors.push(fd);
    }
  } catch (error) {
    // 半途失败必须把已打开的 fd 全部关掉，否则会泄漏描述符。
    for (const fd of descriptors) {
      try {
        fsModule.closeSync(fd);
      } catch {
        // Ignore close errors during cleanup.
      }
    }
    throw error;
  }
  return descriptors;
}

function closeSourceDescriptors(descriptors, options = {}) {
  const fsModule = options.fsModule || fs;
  for (const fd of descriptors || []) {
    try {
      fsModule.closeSync(fd);
    } catch {
      // Ignore close errors during cleanup.
    }
  }
}

function verifyFingerprints(fingerprints, descriptors, options = {}) {
  const fsModule = options.fsModule || fs;
  for (let index = 0; index < (fingerprints || []).length; index += 1) {
    const expected = fingerprints[index];
    let actual;
    try {
      const stat = descriptors && descriptors[index] !== undefined
        ? fsModule.fstatSync(descriptors[index])
        : fsModule.statSync(expected.path);
      const resolvedPath = expected.path;
      actual = {
        path: resolvedPath,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      const changed = new Error("源压缩包或分卷在任务启动后发生变化");
      changed.code = "SOURCE_CHANGED";
      throw changed;
    }
    if (
      actual.path !== expected.path
      || actual.dev !== expected.dev
      || actual.ino !== expected.ino
      || actual.size !== expected.size
      || actual.mtimeMs !== expected.mtimeMs
    ) {
      const error = new Error("源压缩包或分卷在任务启动后发生变化");
      error.code = "SOURCE_CHANGED";
      throw error;
    }
  }
}

module.exports = {
  closeSourceDescriptors,
  fingerprintFiles,
  openSourceDescriptors,
  verifyFingerprints,
};
