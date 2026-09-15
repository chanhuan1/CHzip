"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { LIMITS, PERMISSIONS, TIMEOUTS } = require("./constants");

const REDACTED = "[REDACTED]";

// 敏感键判定。
//
// 大多数敏感词足够长、无歧义，子串命中即可（顺带覆盖 userpassword 这类写法）。
// 唯独 "auth" 不行：子串匹配会把 authorizedRoots 判成敏感
// （"authorizedroots".includes("auth") 为真），而 diagnostic-service 的报告里
// 恰好有 authorizedRoots 字段 —— 结果是诊断报告最关键的字段恒被抹成
// [REDACTED]，而该报告的核心用途恰恰是排查目录授权问题。实测确认过。
// 因此 "auth" 改为要求整体命中一个词元。
const SENSITIVE_SUBSTRINGS = Object.freeze([
  "password",
  "secret",
  "token",
  "credential",
  "private",
  "authorization",
]);

const SENSITIVE_TOKENS = Object.freeze(["auth"]);

// camelCase 边界必须在 toLowerCase() 之前拆开，否则边界信息已经丢失。
function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SENSITIVE_PATTERNS = Object.freeze([
  // 7-Zip 的密码参数。前缀要求「行首 / 空白 / = : ( [ { / 引号」。
  //
  // 这里刻意不用 \b：词字符与 `-` 之间本身就构成词边界，于是
  // `my-project`、`authorized-paths.json` 这类含 `-p` 的路径会被误伤成
  // `my[REDACTED]`，诊断报告里的路径随之失真。去掉 \b 后实测
  // 「7z x -pSecret123」仍被完整脱敏，而含 -p 的路径不再被破坏。
  /(?:^|[\s=:([{"'])-p[\w!@#$%^&*+\-.]+/g,
  /(?:^|[\s=:])[A-Za-z0-9+/]{32,}={0,2}(?=[\s"']|$)/g,
]);

function redactString(value) {
  let result = String(value);
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function isSensitiveKey(key) {
  if (!key) {
    return false;
  }
  const normalized = String(key).toLowerCase();
  if (SENSITIVE_SUBSTRINGS.some((word) => normalized.includes(word))) {
    return true;
  }
  return keyTokens(key).some((token) => SENSITIVE_TOKENS.includes(token));
}

function redactDiagnosticValue(value, key = "") {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => (
      typeof entry === "string"
        ? redactString(entry)
        : redactDiagnosticValue(entry, String(index))
    ));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactDiagnosticValue(entryValue, entryKey),
      ]),
    );
  }
  return typeof value === "string" ? redactString(value) : value;
}

class DiagnosticLogger {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
    this.maxBytes = options.maxBytes || LIMITS.MAX_LOG_BYTES;
    this.backups = options.backups ?? LIMITS.MAX_LOG_BACKUPS;
    fs.mkdirSync(this.rootDir, { recursive: true, mode: PERMISSIONS.MODE_DIR });
    try {
      fs.chmodSync(this.rootDir, PERMISSIONS.MODE_DIR);
    } catch (error) {
      // Some filesystems do not expose POSIX modes.
    }
    this.logPath = path.join(this.rootDir, "chzip.log");
    this.lockPath = `${this.logPath}.lock`;
  }

  withLock(callback) {
    let descriptor;
    for (let attempt = 0; attempt < TIMEOUTS.LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        descriptor = fs.openSync(this.lockPath, "wx", PERMISSIONS.MODE_FILE_SECRET);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > TIMEOUTS.STALE_LOCK_MS) {
            fs.rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== "ENOENT") {
            throw statError;
          }
        }
        const signal = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(signal, 0, 0, TIMEOUTS.LOCK_RETRY_MS);
      }
    }
    if (descriptor == null) {
      const error = new Error("诊断日志文件正忙");
      error.code = "LOG_BUSY";
      throw error;
    }
    try {
      return callback();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  rotateIfNeeded(nextBytes) {
    let currentBytes = 0;
    try {
      currentBytes = fs.statSync(this.logPath).size;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    if (currentBytes + nextBytes <= this.maxBytes) {
      return;
    }
    for (let index = this.backups; index >= 1; index -= 1) {
      const destination = `${this.logPath}.${index}`;
      const source = index === 1
        ? this.logPath
        : `${this.logPath}.${index - 1}`;
      fs.rmSync(destination, { force: true });
      if (fs.existsSync(source)) {
        fs.renameSync(source, destination);
      }
    }
  }

  write(event) {
    const record = {
      timestamp: new Date().toISOString(),
      ...redactDiagnosticValue(event),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.withLock(() => {
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.logPath, line, {
        encoding: "utf8",
        mode: PERMISSIONS.MODE_FILE_SECRET,
      });
      try {
        fs.chmodSync(this.logPath, PERMISSIONS.MODE_FILE_SECRET);
      } catch (error) {
        // Some filesystems do not expose POSIX modes.
      }
    });
    return record;
  }

  tail(maxBytes = LIMITS.MAX_LOG_TAIL_BYTES) {
    return this.tailFile(this.logPath, maxBytes);
  }

  tailFile(filePath, maxBytes = LIMITS.MAX_LOG_TAIL_BYTES) {
    try {
      const stat = fs.statSync(filePath);
      const length = Math.min(stat.size, maxBytes);
      const descriptor = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(descriptor, buffer, 0, length, stat.size - length);
        return buffer.toString("utf8");
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  tailForRequest(requestId, maxBytes = LIMITS.MAX_LOG_TAIL_BYTES) {
    if (!requestId) {
      return "";
    }
    const escapedRequestId = JSON.stringify(requestId);
    const matches = [];
    const maxMatches = LIMITS.MAX_TAIL_REQUEST_MATCHES;
    const logPaths = [];
    for (let index = this.backups; index >= 1; index -= 1) {
      logPaths.push(`${this.logPath}.${index}`);
    }
    logPaths.push(this.logPath);
    for (const filePath of logPaths) {
      const content = this.tailFile(filePath, maxBytes);
      if (!content) {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (!line) {
          continue;
        }
        if (!line.includes(escapedRequestId)) {
          continue;
        }
        try {
          if (JSON.parse(line).requestId === requestId) {
            matches.push(line);
            if (matches.length >= maxMatches) {
              return matches.join("\n");
            }
          }
        } catch (error) {
          continue;
        }
      }
    }
    return matches.join("\n");
  }
}

class NullDiagnosticLogger {
  write() {
    // No-op: logging is unavailable, discard all events.
  }

  tail() {
    return "";
  }

  tailForRequest() {
    return "";
  }
}

function createDiagnosticLogger(options = {}) {
  const roots = options.rootDirs || [options.rootDir].filter(Boolean);
  for (const rootDir of roots) {
    try {
      return new DiagnosticLogger({
        rootDir,
        maxBytes: options.maxBytes,
        backups: options.backups,
      });
    } catch (error) {
      // Try the next application-owned runtime directory.
    }
  }
  return new NullDiagnosticLogger();
}

function safeDiagnosticWrite(logger, event) {
  try {
    return logger?.write(event) || null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  createDiagnosticLogger,
  DiagnosticLogger,
  NullDiagnosticLogger,
  redactDiagnosticValue,
  safeDiagnosticWrite,
};
