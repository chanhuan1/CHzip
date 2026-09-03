"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { isArchiveFile, DirectoryWatcher } = require("../app/server/lib/watcher");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-watcher-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("isArchiveFile recognizes archives", () => {
  assert.equal(isArchiveFile("test.zip"), true);
  assert.equal(isArchiveFile("test.7z"), true);
  assert.equal(isArchiveFile("test.rar"), true);
  assert.equal(isArchiveFile("test.tar.gz"), true);
  assert.equal(isArchiveFile("test.7z.001"), true);
  assert.equal(isArchiveFile("test.txt"), false);
  assert.equal(isArchiveFile("test.jpg"), false);
});

test("DirectoryWatcher detects new archives", () => {
  return new Promise((resolve, reject) => {
    let detected = null;
    const watcher = new DirectoryWatcher({
      watchDir: tmpDir,
      intervalMs: 50,
      onNewArchive(filePath, name) {
        detected = name;
      },
    });
    watcher.start();

    setTimeout(() => {
      fs.writeFileSync(path.join(tmpDir, "newfile.zip"), "fake");
    }, 150);

    setTimeout(() => {
      watcher.stop();
      try {
        assert.equal(detected, "newfile.zip");
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 500);
  });
});

test("DirectoryWatcher ignores old files", () => {
  return new Promise((resolve, reject) => {
    const oldFile = path.join(tmpDir, "old.zip");
    fs.writeFileSync(oldFile, "fake");
    const oldMtime = fs.statSync(oldFile).mtimeMs;

    let detected = false;
    const watcher = new DirectoryWatcher({
      watchDir: tmpDir,
      intervalMs: 50,
      onNewArchive() {
        detected = true;
      },
    });
    // Ensure startedAt is after the old file's mtime
    watcher.startedAt = oldMtime + 1000;
    watcher.start();

    setTimeout(() => {
      watcher.stop();
      try {
        assert.equal(detected, false);
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 300);
  });
});

test("DirectoryWatcher stops correctly", () => {
  const watcher = new DirectoryWatcher({
    watchDir: tmpDir,
    intervalMs: 1000,
  });
  assert.equal(watcher.isRunning(), false);
  watcher.start();
  assert.equal(watcher.isRunning(), true);
  watcher.stop();
  assert.equal(watcher.isRunning(), false);
});
