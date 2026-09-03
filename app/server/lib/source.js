"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fingerprintFiles(filePaths) {
  return filePaths.map((filePath) => {
    const resolvedPath = fs.realpathSync(filePath);
    const stat = fs.statSync(resolvedPath);
    return {
      path: resolvedPath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  });
}

function openSourceDescriptors(fingerprints) {
  const descriptors = [];
  try {
    for (const fingerprint of fingerprints || []) {
      const fd = fs.openSync(fingerprint.path, "r");
      descriptors.push(fd);
    }
  } catch (error) {
    for (const fd of descriptors) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors during cleanup.
      }
    }
    throw error;
  }
  return descriptors;
}

function closeSourceDescriptors(descriptors) {
  for (const fd of descriptors || []) {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors during cleanup.
    }
  }
}

function verifyFingerprints(fingerprints, descriptors) {
  for (let index = 0; index < (fingerprints || []).length; index += 1) {
    const expected = fingerprints[index];
    let actual;
    try {
      const stat = descriptors && descriptors[index] !== undefined
        ? fs.fstatSync(descriptors[index])
        : fs.statSync(expected.path);
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
