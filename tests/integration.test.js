"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { createServices } = require("../app/server/lib/services");
const { JobStore } = require("../app/server/lib/jobs");
const { overwriteFileSync } = require("../app/server/lib/fs-utils");

let tmpDir;
let services;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-integration-"));
  services = createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: process.execPath, source: "test" }),
    runSync: (tool, args, options) => ({
      exitCode: 0,
      log: "",
      stdout: "Type = zip\n----------\nPath = test.txt\nSize = 100\nAttributes = A\n\n",
      stderr: "",
    }),
    validateListing: () => ({ entryCount: 1, format: "zip" }),
    discoverRoots: () => [{ path: tmpDir, canBrowse: true, canSelect: true }],
    inspectSource: (filePath) => {
      const resolved = fs.realpathSync(filePath);
      const stat = fs.statSync(resolved);
      return {
        path: resolved,
        readable: true,
        mode: "0644",
        uid: 1000,
        gid: 1000,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        application: { uid: 1000, gid: 1000, groups: [] },
        components: [],
        stat,
      };
    },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("createServices initializes with all required methods", () => {
  assert.equal(typeof services.info, "function");
  assert.equal(typeof services.preview, "function");
  assert.equal(typeof services.extract, "function");
  assert.equal(typeof services.status, "function");
  assert.equal(typeof services.cancel, "function");
  assert.equal(typeof services.directories, "function");
  assert.equal(typeof services.createDirectory, "function");
  assert.equal(typeof services.diagnostics, "function");
  assert.equal(typeof services.listJobs, "function");
  assert.equal(typeof services.clearHistory, "function");
});

test("JobStore create and read lifecycle", () => {
  const store = new JobStore(tmpDir);
  const job = store.create({
    archivePath: "/test/archive.zip",
    outputDir: "/test/output",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: "/usr/bin/7z",
    sevenZipSource: "system",
    partCount: 1,
    sourceFingerprint: [],
  });

  assert.ok(/^[a-f0-9]{32}$/.test(job.id));
  assert.equal(job.status, "queued");
  assert.equal(job.progress, 0);

  const read = store.read(job.id);
  assert.equal(read.id, job.id);
  assert.equal(read.archivePath, "/test/archive.zip");
});

test("JobStore update with lock protection", () => {
  const store = new JobStore(tmpDir);
  const job = store.create({
    archivePath: "/test/archive.zip",
    outputDir: "/test/output",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: "/usr/bin/7z",
    sevenZipSource: "system",
    partCount: 1,
    sourceFingerprint: [],
  });

  const updated = store.update(job.id, (current) => ({
    ...current,
    status: "running",
    progress: 50,
  }));

  assert.equal(updated.status, "running");
  assert.equal(updated.progress, 50);
});

test("JobStore cleanupExpired removes old jobs", () => {
  const store = new JobStore(tmpDir);
  const job = store.create({
    archivePath: "/test/archive.zip",
    outputDir: "/test/output",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: "/usr/bin/7z",
    sevenZipSource: "system",
    partCount: 1,
    sourceFingerprint: [],
  });

  store.update(job.id, (current) => ({
    ...current,
    status: "success",
    finishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  }));

  const removed = store.cleanupExpired();
  assert.deepEqual(removed, [job.id]);
  assert.equal(store.read(job.id), null);
});

test("JobStore cleanupExpired preserves recent jobs", () => {
  const store = new JobStore(tmpDir);
  const job = store.create({
    archivePath: "/test/archive.zip",
    outputDir: "/test/output",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: "/usr/bin/7z",
    sevenZipSource: "system",
    partCount: 1,
    sourceFingerprint: [],
  });

  store.update(job.id, (current) => ({
    ...current,
    status: "success",
    finishedAt: new Date().toISOString(),
  }));

  const removed = store.cleanupExpired();
  assert.deepEqual(removed, []);
  assert.ok(store.read(job.id));
});

test("overwriteFileSync overwrites file content", () => {
  const testFile = path.join(tmpDir, "secret.txt");
  fs.writeFileSync(testFile, "sensitive-data", { encoding: "utf8", mode: 0o600 });

  overwriteFileSync(testFile);

  const content = fs.readFileSync(testFile, "utf8");
  assert.notEqual(content, "sensitive-data");
});

test("overwriteFileSync handles missing file gracefully", () => {
  const missingFile = path.join(tmpDir, "nonexistent.txt");
  assert.doesNotThrow(() => overwriteFileSync(missingFile));
});

test("services.diagnostics returns version and structure", () => {
  const archivePath = path.join(tmpDir, "test.zip");
  fs.writeFileSync(archivePath, "fake-zip-content");

  const report = services.diagnostics({ path: archivePath });
  assert.ok(report.version);
  assert.ok(report.generatedAt);
  assert.ok(report.source);
  assert.equal(report.source.path, fs.realpathSync(archivePath));
});

test("services.directories returns authorized roots", () => {
  const archivePath = path.join(tmpDir, "test.zip");
  fs.writeFileSync(archivePath, "fake-zip-content");

  const result = services.directories({ archivePath });
  assert.ok(Array.isArray(result.roots));
  assert.ok(result.roots.length > 0);
});

test("services.createDirectory creates and validates directory", () => {
  const parentDir = path.join(tmpDir, "parent");
  fs.mkdirSync(parentDir, { recursive: true });
  const archivePath = path.join(tmpDir, "test.zip");
  fs.writeFileSync(archivePath, "fake-zip-content");

  const result = services.createDirectory({
    archivePath,
    parentPath: parentDir,
    name: "new-folder",
  });

  assert.equal(result.name, "new-folder");
  assert.ok(fs.existsSync(result.path));
  assert.equal(result.canSelect, true);
});

test("services.createDirectory rejects invalid names", () => {
  const parentDir = path.join(tmpDir, "parent");
  fs.mkdirSync(parentDir, { recursive: true });
  const archivePath = path.join(tmpDir, "test.zip");
  fs.writeFileSync(archivePath, "fake-zip-content");

  assert.throws(
    () => services.createDirectory({
      archivePath,
      parentPath: parentDir,
      name: "",
    }),
    /无效/,
  );

  assert.throws(
    () => services.createDirectory({
      archivePath,
      parentPath: parentDir,
      name: "foo/bar",
    }),
    /无效/,
  );
});

test("JobStore validates job ID format", () => {
  const store = new JobStore(tmpDir);
  assert.throws(() => store.read("invalid-id"), /无效的任务 ID/);
  assert.throws(() => store.update("invalid-id", (j) => j), /无效的任务 ID/);
});

test("JobStore withLock handles concurrent access", () => {
  const store = new JobStore(tmpDir);
  const job = store.create({
    archivePath: "/test/archive.zip",
    outputDir: "/test/output",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: "/usr/bin/7z",
    sevenZipSource: "system",
    partCount: 1,
    sourceFingerprint: [],
  });

  const results = [];
  const promises = [];
  for (let index = 0; index < 5; index += 1) {
    promises.push(new Promise((resolve) => {
      setTimeout(() => {
        const updated = store.update(job.id, (current) => ({
          ...current,
          progress: (current.progress || 0) + 10,
        }));
        results.push(updated.progress);
        resolve();
      }, index * 10);
    }));
  }

  return Promise.all(promises).then(() => {
    const finalJob = store.read(job.id);
    assert.equal(finalJob.progress, 50);
  });
});

test("JobStore cleanupExpired handles running jobs correctly", () => {
  const store = new JobStore(tmpDir);
  const job = store.create({
    archivePath: "/test/archive.zip",
    outputDir: "/test/output",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: "/usr/bin/7z",
    sevenZipSource: "system",
    partCount: 1,
    sourceFingerprint: [],
  });

  store.update(job.id, (current) => ({
    ...current,
    status: "running",
    startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    workerPid: process.pid,
  }));

  const removed = store.cleanupExpired();
  assert.deepEqual(removed, []);
  assert.ok(store.read(job.id));
});

test("services.diagnostics handles missing source file", () => {
  const testServices = createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: process.execPath, source: "test" }),
  });
  const report = testServices.diagnostics({ path: "/nonexistent/path/file.zip" });
  assert.equal(report.source.readable, false);
  assert.ok(report.sourceError);
  assert.ok(
    report.sourceError.code === "SOURCE_NOT_FOUND"
    || report.sourceError.code === "SOURCE_PARENT_DENIED"
    || report.sourceError.code === "SOURCE_REALPATH_FAILED",
  );
});

test("services.directories handles unauthorized path", () => {
  const archivePath = path.join(tmpDir, "test.zip");
  fs.writeFileSync(archivePath, "fake-zip-content");

  services = createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: process.execPath, source: "test" }),
    discoverRoots: () => [],
  });

  const result = services.directories({ archivePath });
  assert.equal(result.roots.length, 0);
});

test("createServices handles missing 7z tool", () => {
  const servicesNoTool = createServices({
    runtimeRoot: tmpDir,
    findTool: () => null,
  });

  const report = servicesNoTool.diagnostics({ path: path.join(tmpDir, "test.zip") });
  assert.equal(report.engine.source, "missing");
});

test("JobStore create generates unique IDs", () => {
  const store = new JobStore(tmpDir);
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const job = store.create({
      archivePath: "/test/archive.zip",
      outputDir: "/test/output",
      selection: { format: "zip", type: "zip" },
      sevenZipPath: "/usr/bin/7z",
      sevenZipSource: "system",
      partCount: 1,
      sourceFingerprint: [],
    });
    assert.ok(!ids.has(job.id));
    ids.add(job.id);
  }
  assert.equal(ids.size, 100);
});

function createTestJob(store, overrides = {}) {
  return store.create({
    archivePath: "/test/archive.zip",
    outputDir: "/test/output",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: "/usr/bin/7z",
    sevenZipSource: "system",
    partCount: 1,
    sourceFingerprint: [],
    ...overrides,
  });
}

test("JobStore removeAllFinished clears finished jobs and keeps active ones", () => {
  const store = new JobStore(tmpDir);
  const success = createTestJob(store);
  store.update(success.id, (current) => ({
    ...current,
    status: "success",
    finishedAt: new Date().toISOString(),
  }));
  const failed = createTestJob(store);
  store.update(failed.id, (current) => ({
    ...current,
    status: "failed",
    finishedAt: new Date().toISOString(),
  }));
  const cancelled = createTestJob(store);
  store.update(cancelled.id, (current) => ({
    ...current,
    status: "cancelled",
    finishedAt: new Date().toISOString(),
  }));
  const running = createTestJob(store);
  store.update(running.id, (current) => ({
    ...current,
    status: "running",
    startedAt: new Date().toISOString(),
    workerPid: process.pid,
  }));

  const removed = store.removeAllFinished();

  assert.equal(removed.length, 3);
  assert.ok(removed.includes(success.id));
  assert.ok(removed.includes(failed.id));
  assert.ok(removed.includes(cancelled.id));
  assert.equal(store.read(success.id), null);
  assert.equal(store.read(failed.id), null);
  assert.equal(store.read(cancelled.id), null);
  assert.ok(store.read(running.id));
});

test("JobStore removeAllFinished removes job data directories", () => {
  const store = new JobStore(tmpDir);
  const job = createTestJob(store);
  fs.writeFileSync(
    path.join(store.dataDir(job.id), "password.txt"),
    "secret",
    { encoding: "utf8", mode: 0o600 },
  );
  store.update(job.id, (current) => ({
    ...current,
    status: "success",
    finishedAt: new Date().toISOString(),
  }));

  assert.ok(fs.existsSync(store.dataDir(job.id)));
  store.removeAllFinished();
  assert.equal(fs.existsSync(store.dataDir(job.id)), false);
});

test("JobStore removeAllFinished keeps extracted output directories", () => {
  const store = new JobStore(tmpDir);
  const outputDir = path.join(tmpDir, "extracted-output");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "file.txt"), "payload");

  const job = createTestJob(store, { outputDir });
  store.update(job.id, (current) => ({
    ...current,
    status: "success",
    finishedAt: new Date().toISOString(),
  }));

  store.removeAllFinished();

  assert.equal(store.read(job.id), null);
  assert.ok(fs.existsSync(outputDir), "清空历史不应删除已解压的文件");
  assert.ok(fs.existsSync(path.join(outputDir, "file.txt")));
});

test("services.clearHistory empties history and reports count", () => {
  const store = services.store;
  const job = createTestJob(store, {
    archivePath: path.join(tmpDir, "test.zip"),
    outputDir: path.join(tmpDir, "out"),
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
  });
  store.update(job.id, (current) => ({
    ...current,
    status: "success",
    finishedAt: new Date().toISOString(),
  }));

  assert.equal(services.listJobs().history.length, 1);
  assert.deepEqual(services.clearHistory(), { removed: 1 });
  assert.equal(services.listJobs().history.length, 0);
});

test("services.clearHistory on empty history is a no-op", () => {
  assert.deepEqual(services.clearHistory(), { removed: 0 });
});
