"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { CRYPTO, PERMISSIONS } = require("./constants");

const DEFAULT_LOCK_ATTEMPTS = 200;
const DEFAULT_LOCK_RETRY_MS = 5;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function acquireFileLock(lockPath, options = {}) {
  const maxAttempts = options.maxAttempts || DEFAULT_LOCK_ATTEMPTS;
  const retryMs = options.retryMs || DEFAULT_LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const descriptor = acquireLockDescriptor(
    lockPath,
    maxAttempts,
    retryMs,
    staleMs,
  );
  return {
    release: () => releaseFileLock(lockPath, descriptor),
  };
}

function withFileLock(lockPath, callback, options = {}) {
  const lock = acquireFileLock(lockPath, options);
  try {
    return callback();
  } finally {
    lock.release();
  }
}

function acquireLockDescriptor(lockPath, maxAttempts, retryMs, staleMs) {
  let descriptor;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      return descriptor;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (staleMs > 0) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== "ENOENT") {
            throw statError;
          }
        }
      }
      sleepSync(retryMs);
    }
  }
  const error = new Error("文件锁获取超时");
  error.code = "LOCK_BUSY";
  throw error;
}

function releaseFileLock(lockPath, descriptor) {
  fs.closeSync(descriptor);
  fs.rmSync(lockPath, { force: true });
}

function atomicWriteFile(filePath, content, options = {}) {
  const encoding = options.encoding || "utf8";
  const mode = options.mode || 0o600;
  const directory = require("node:path").dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${require("node:crypto").randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding, mode });
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      // The atomic rename already removed the temporary path.
    }
    throw error;
  }
}

function truncateUtf8Name(name, byteLimit = 230) {
  const value = String(name || "");
  if (Buffer.byteLength(value, "utf8") <= byteLimit) {
    return value;
  }
  const dotIndex = value.lastIndexOf(".");
  const ext = dotIndex > 0 ? value.slice(dotIndex) : "";
  const stem = dotIndex > 0 ? value.slice(0, dotIndex) : value;
  const stemBudget = Math.max(1, byteLimit - Buffer.byteLength(ext, "utf8"));
  let out = "";
  let bytes = 0;
  for (const char of stem) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > stemBudget) {
      break;
    }
    out += char;
    bytes += size;
  }
  const candidate = `${out}${ext}` || value.slice(0, byteLimit);
  return Buffer.byteLength(candidate, "utf8") <= byteLimit
    ? candidate
    : candidate.slice(0, byteLimit);
}

function overwriteFileSync(filePath, passes = CRYPTO.PASSWORD_OVERWRITE_PASSES) {
  if (!filePath) {
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    const length = stat.size;
    if (length === 0) {
      return;
    }
    const fd = fs.openSync(filePath, "w");
    try {
      for (let pass = 0; pass < passes; pass += 1) {
        const buffer = crypto.randomBytes(length);
        fs.writeSync(fd, buffer, 0, length, 0);
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    // File may already be removed; nothing to overwrite.
  }
}

module.exports = {
  DEFAULT_LOCK_ATTEMPTS,
  DEFAULT_LOCK_RETRY_MS,
  DEFAULT_STALE_LOCK_MS,
  acquireFileLock,
  atomicWriteFile,
  overwriteFileSync,
  sleepSync,
  truncateUtf8Name,
  withFileLock,
};
