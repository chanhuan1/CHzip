"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ARCHIVE_PATTERNS = [
  /\.7z$/i, /\.zip$/i, /\.rar$/i, /\.tar$/i, /\.tgz$/i,
  /\.tbz2?$/i, /\.txz$/i, /\.gz$/i, /\.bz2$/i, /\.xz$/i,
  /\.zst(?:d)?$/i, /\.tzst$/i, /\.cab$/i, /\.iso$/i,
  /\.arj$/i, /\.lzh$/i, /\.lha$/i, /\.z$/i, /\.lzma$/i,
  /\.cpio$/i, /\.rpm$/i, /\.deb$/i, /\.dmg$/i, /\.wim$/i, /\.xar$/i,
  /\.(?:7z|zip)\.\d{3}$/i,
];

function isArchiveFile(filePath) {
  const basename = path.basename(filePath);
  return ARCHIVE_PATTERNS.some((pattern) => pattern.test(basename));
}

class DirectoryWatcher {
  constructor(options = {}) {
    this.watchDir = options.watchDir;
    this.intervalMs = options.intervalMs || 30000;
    this.onNewArchive = options.onNewArchive || (() => {});
    this.processedFile = new Set();
    this.timer = null;
    this.startedAt = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    if (!this.startedAt) {
      this.startedAt = Date.now();
    }
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  scan() {
    if (!this.watchDir || !fs.existsSync(this.watchDir)) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(this.watchDir, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(this.watchDir, entry.name);
      if (this.processedFile.has(filePath)) {
        continue;
      }
      if (!isArchiveFile(entry.name)) {
        continue;
      }
      try {
        const stat = fs.statSync(filePath);
        if (this.startedAt && stat.mtimeMs < this.startedAt) {
          this.processedFile.add(filePath);
          continue;
        }
        this.processedFile.add(filePath);
        this.onNewArchive(filePath, entry.name);
      } catch (error) {
        this.processedFile.add(filePath);
      }
    }
  }

  clearProcessed() {
    this.processedFile.clear();
  }

  isRunning() {
    return this.timer !== null;
  }
}

module.exports = {
  DirectoryWatcher,
  ARCHIVE_PATTERNS,
  isArchiveFile,
};
