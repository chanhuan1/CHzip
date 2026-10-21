"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { CRYPTO } = require("./constants");

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

function truncateUtf8Name(name, byteLimit = 230) {
  const value = String(name || "");
  const limit = Math.max(0, Math.floor(Number(byteLimit) || 0));
  if (limit === 0) {
    return "";
  }
  if (Buffer.byteLength(value, "utf8") <= limit) {
    return value;
  }
  const dotIndex = value.lastIndexOf(".");
  let ext = dotIndex > 0 ? value.slice(dotIndex) : "";
  if (Buffer.byteLength(ext, "utf8") + 1 > limit) {
    // 扩展名自身就超过上限时不能强行保留，否则会再次越过文件系统限制。
    ext = "";
  }
  const stem = ext ? value.slice(0, dotIndex) : value;
  const stemBudget = Math.max(0, limit - Buffer.byteLength(ext, "utf8"));
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
  let candidate = `${out}${ext}`;
  if (!candidate && !ext) {
    // 至少返回一个合法字符；调用方传入的典型上限远大于 1 字节。
    for (const char of value) {
      if (Buffer.byteLength(char, "utf8") <= limit) {
        candidate = char;
      }
      break;
    }
  }
  if (!candidate) {
    candidate = "_";
  }
  // 正常分支已按字节精确截断；这里再做一次字符级兜底，绝不做 UTF-16 slice。
  while (Buffer.byteLength(candidate, "utf8") > limit) {
    const chars = Array.from(candidate);
    chars.pop();
    candidate = chars.join("");
  }
  return candidate || "_";
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
  overwriteFileSync,
  sleepSync,
  truncateUtf8Name,
};
