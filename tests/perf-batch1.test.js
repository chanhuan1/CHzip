"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createServices } = require("../app/server/lib/services");
const { JobStore } = require("../app/server/lib/jobs");
const { runSevenZipSync } = require("../app/server/lib/engine");
const { inspectSourceFile } = require("../app/server/lib/source-access");
const { findNestedTar } = require("../app/server/lib/nested");
const { CLEANUP_APIS, hasRequestBody } = require("../app/server/api");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-perf-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

function createTestServices(overrides = {}) {
  return createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: process.execPath, source: "test" }),
    runSync: () => ({
      exitCode: 0,
      log: "",
      stdout: "Type = zip\n----------\nPath = test.txt\nSize = 100\nAttributes = A\n\n",
      stderr: "",
    }),
    discoverRoots: () => [{ path: tmpDir, canBrowse: true, canSelect: true }],
    ...overrides,
  });
}

// ---------------------------------------------------------------- A2：陈旧锁回收

test("A2 withLock reclaims a stale lock file instead of hanging forever", () => {
  const store = new JobStore(tmpDir);
  const job = createTestJob(store);
  const lockPath = `${store.jobPath(job.id)}.lock`;
  fs.writeFileSync(lockPath, "", { mode: 0o600 });
  const longAgo = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(lockPath, longAgo, longAgo);

  const updated = store.update(job.id, (current) => ({ ...current, progress: 7 }));

  assert.equal(updated.progress, 7);
  assert.equal(fs.existsSync(lockPath), false, "陈旧锁应被回收，释放后不应残留");
});

test("A2 withLock still refuses a fresh lock (未超时不得误删)", () => {
  const store = new JobStore(tmpDir);
  const job = createTestJob(store);
  const lockPath = `${store.jobPath(job.id)}.lock`;
  fs.writeFileSync(lockPath, "", { mode: 0o600 });
  try {
    assert.throws(
      () => store.update(job.id, (current) => current),
      /任务状态文件正忙/,
    );
    assert.equal(fs.existsSync(lockPath), true, "新鲜锁必须保留");
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

// ---------------------------------------------------------------- A3：read 语义

test("A3 read returns null only for a missing job and still throws on corrupt JSON", () => {
  const store = new JobStore(tmpDir);
  assert.equal(store.read("a".repeat(32)), null);

  const job = createTestJob(store);
  fs.writeFileSync(store.jobPath(job.id), "{ not json", { mode: 0o600 });
  assert.throws(() => store.read(job.id), SyntaxError);
});

// ---------------------------------------------------------------- A4：status 视图

test("A4 status exposes only client-facing fields", () => {
  const services = createTestServices();
  const job = createTestJob(services.store, {
    archivePath: "/tmp/demo/archive.zip",
  });
  services.store.update(job.id, (current) => ({
    ...current,
    status: "running",
    progress: 33,
    currentFile: "a.txt",
    log: "x".repeat(4096),
    selectionFile: "/secret/selection.txt",
    passwordFile: "/secret/password.txt",
  }));

  const view = services.status({ jobId: job.id });

  assert.equal(view.id, job.id);
  assert.equal(view.progress, 33);
  assert.equal(view.currentFile, "a.txt");
  assert.equal(view.archiveName, "archive.zip");
  for (const hidden of [
    "log",
    "sourceFingerprint",
    "selectionFile",
    "passwordFile",
    "outputOwned",
    "sevenZipPath",
    "sevenZipSource",
  ]) {
    assert.equal(
      Object.hasOwn(view, hidden),
      false,
      `status 不应暴露内部字段 ${hidden}`,
    );
  }
});

// ---------------------------------------------------------------- A5：单次遍历修剪

test("A5 listAndTrimHistory trims overflow and lists in one pass", () => {
  const store = new JobStore(tmpDir);
  const ids = [];
  for (let index = 0; index < 25; index += 1) {
    const job = createTestJob(store);
    const finishedAt = new Date(Date.now() - (25 - index) * 60 * 1000).toISOString();
    store.update(job.id, (current) => ({
      ...current,
      status: "success",
      finishedAt,
    }));
    ids.push(job.id);
  }

  const { jobs, removed } = store.listAndTrimHistory(20);

  assert.equal(removed.length, 5);
  assert.equal(jobs.length, 20);
  for (const id of ids.slice(0, 5)) {
    assert.equal(store.read(id), null, "最旧的 5 条应被删除");
    assert.equal(fs.existsSync(store.dataDir(id)), false);
  }
  for (const id of ids.slice(5)) {
    assert.ok(store.read(id), "其余 20 条应保留");
  }
});

test("A5 listAndTrimHistory keeps active jobs and ignores unfinished overflow", () => {
  const store = new JobStore(tmpDir);
  const running = createTestJob(store);
  store.update(running.id, (current) => ({
    ...current,
    status: "running",
    startedAt: new Date().toISOString(),
  }));

  for (let index = 0; index < 3; index += 1) {
    const job = createTestJob(store);
    store.update(job.id, (current) => ({
      ...current,
      status: "success",
      finishedAt: new Date().toISOString(),
    }));
  }

  const { jobs, removed } = store.listAndTrimHistory(20);

  assert.deepEqual(removed, []);
  assert.equal(jobs.length, 4);
  assert.ok(jobs.some((job) => job.id === running.id), "进行中的任务不得被修剪");
});

// ---------------------------------------------------------------- A6：清理节流

test("A6 cleanupExpiredIfDue throttles repeated calls via the stamp file", () => {
  const store = new JobStore(tmpDir);

  assert.ok(Array.isArray(store.cleanupExpiredIfDue()), "首次应真正执行清理");
  assert.equal(store.cleanupExpiredIfDue(), null, "紧接着的第二次应被节流跳过");

  const stampPath = path.join(tmpDir, "cleanup.stamp");
  assert.ok(fs.existsSync(stampPath), "应写入节流时间戳");

  const longAgo = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(stampPath, longAgo, longAgo);
  assert.ok(Array.isArray(store.cleanupExpiredIfDue()), "超过最小间隔后应再次执行");
});

test("A6 cleanupExpiredIfDue honours a custom minimum interval", () => {
  const store = new JobStore(tmpDir);
  assert.ok(Array.isArray(store.cleanupExpiredIfDue({ minIntervalMs: 0 })));
  assert.ok(
    Array.isArray(store.cleanupExpiredIfDue({ minIntervalMs: 0 })),
    "间隔为 0 时不应节流",
  );
});

// ---------------------------------------------------------------- A7：GET 不读 stdin

test("A7 hasRequestBody skips stdin for GET/HEAD and empty bodies", () => {
  assert.equal(hasRequestBody({ REQUEST_METHOD: "GET" }), false);
  assert.equal(hasRequestBody({ REQUEST_METHOD: "HEAD" }), false);
  assert.equal(hasRequestBody({ REQUEST_METHOD: "GET", CONTENT_LENGTH: "0" }), false);
  assert.equal(hasRequestBody({ REQUEST_METHOD: "POST", CONTENT_LENGTH: "42" }), true);
  assert.equal(hasRequestBody({ REQUEST_METHOD: "POST" }), true);
  assert.equal(hasRequestBody({}), true, "方法未知时保持原行为，避免漏读请求体");
});

test("A6/A7 cleanup only runs for user-initiated endpoints", () => {
  assert.ok(CLEANUP_APIS.has("extract"));
  assert.ok(CLEANUP_APIS.has("jobs"));
  assert.ok(CLEANUP_APIS.has("clear-history"));
  assert.equal(CLEANUP_APIS.has("status"), false, "1s 轮询不得触发全目录扫描");
  assert.equal(CLEANUP_APIS.has("preview"), false);
});

// ---------------------------------------------------------------- A9：archive 复用

test("A9 preview reuses a caller-provided archive instead of re-inspecting", () => {
  const services = createTestServices();
  const missing = "/definitely/missing/archive.zip";
  const provided = {
    filePath: missing,
    directory: tmpDir,
    selection: { format: "zip", type: "zip" },
    parts: [{ path: missing, name: "archive.zip" }],
    missingParts: [],
    warnings: [],
    partCount: 1,
    tool: { path: process.execPath, source: "test" },
  };

  // 路径并不存在：若 preview 忽略传入的 archive 而重新 inspectArchive，这里必然抛错。
  const result = services.preview({ path: missing }, provided);

  assert.equal(result.format, "zip");
  assert.equal(result.parts.length, 1);
});

// ---------------------------------------------------------------- A11：祖先目录去重

test("A11 inspectSourceFile reuses cached ancestor checks within one call scope", () => {
  const calls = { stat: 0, access: 0 };
  const countingFs = {
    constants: fs.constants,
    statSync: (target) => {
      calls.stat += 1;
      return fs.statSync(target);
    },
    accessSync: (target, mode) => {
      calls.access += 1;
      return fs.accessSync(target, mode);
    },
    realpathSync: (target) => fs.realpathSync(target),
  };

  const first = path.join(tmpDir, "a.txt");
  const second = path.join(tmpDir, "b.txt");
  fs.writeFileSync(first, "a");
  fs.writeFileSync(second, "b");

  const verifiedComponents = new Map();
  inspectSourceFile(first, { fsModule: countingFs, verifiedComponents });
  assert.ok(calls.stat > 1, "首个文件需要逐级校验祖先目录");
  assert.ok(verifiedComponents.size > 1);

  calls.stat = 0;
  calls.access = 0;
  const result = inspectSourceFile(second, {
    fsModule: countingFs,
    verifiedComponents,
  });

  assert.equal(result.readable, true);
  assert.equal(calls.stat, 1, "第二个文件只应 stat 自身一次（祖先全部命中缓存）");
  assert.equal(calls.access, 1, "第二个文件只应 access 自身一次");

  // 对照：不带缓存时仍会逐级重跑。
  calls.stat = 0;
  calls.access = 0;
  inspectSourceFile(second, { fsModule: countingFs });
  assert.ok(calls.stat > 1, "不带缓存时应逐级重新校验");
});

test("A11 inspectSourceFile still rejects a file whose ancestors are not traversable", () => {
  const missingDir = path.join(tmpDir, "nope", "deep");
  assert.throws(
    () => inspectSourceFile(path.join(missingDir, "x.zip")),
    (error) => error.code === "SOURCE_NOT_FOUND",
  );
});

// ---------------------------------------------------------------- A12：嵌套 tar

test("A12 findNestedTar returns the only tar and rejects zero or many", () => {
  const single = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-nested-one-"));
  const double = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-nested-two-"));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-nested-zero-"));
  try {
    fs.writeFileSync(path.join(single, "inner.tar"), "x");
    fs.writeFileSync(path.join(single, "readme.txt"), "x");
    assert.equal(findNestedTar(single), path.join(single, "inner.tar"));

    fs.writeFileSync(path.join(double, "one.tar"), "x");
    fs.writeFileSync(path.join(double, "two.tar"), "x");
    assert.throws(
      () => findNestedTar(double),
      (error) => error.code === "UNSUPPORTED",
      "出现第二个 .tar 就应立刻判为不支持",
    );

    assert.throws(() => findNestedTar(empty), (error) => error.code === "UNSUPPORTED");
  } finally {
    for (const dir of [single, double, empty]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------- A13：预览上限

test("A13 previewFile reports PREVIEW_TOO_LARGE instead of ENOBUFS", async () => {
  const archivePath = path.join(tmpDir, "big.zip");
  fs.writeFileSync(archivePath, "fake-archive");
  const scriptPath = path.join(tmpDir, "big-output.sh");
  fs.writeFileSync(
    scriptPath,
    "#!/bin/sh\ndd if=/dev/zero bs=1024 count=64 2>/dev/null | tr '\\0' 'x'\n",
    { mode: 0o755 },
  );
  fs.chmodSync(scriptPath, 0o755);

  const services = createTestServices({
    findTool: () => ({ path: scriptPath, source: "test" }),
    // previewFile 现在走 runSync（= runSevenZipSync）以继承超时与错误分类，
    // 所以这里必须注入真实实现，否则会被 createTestServices 的替身拦下。
    runSync: runSevenZipSync,
    maxPreviewFileBytes: 1024,
  });

  await assert.rejects(
    () => services.previewFile({ path: archivePath, targetPath: "inner.txt" }),
    (error) => error.code === "PREVIEW_TOO_LARGE",
  );
});

test("A13 previewFile still succeeds for output under the limit", async () => {
  const archivePath = path.join(tmpDir, "small.zip");
  fs.writeFileSync(archivePath, "fake-archive");
  const scriptPath = path.join(tmpDir, "small-output.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\nprintf 'hello'\n", { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);

  const services = createTestServices({
    findTool: () => ({ path: scriptPath, source: "test" }),
    // 同上：previewFile 走 runSync，需要真实实现。
    runSync: runSevenZipSync,
    maxPreviewFileBytes: 1024 * 1024,
  });

  const result = await services.previewFile({
    path: archivePath,
    targetPath: "inner.txt",
  });
  assert.equal(result.content, "hello");
  assert.equal(result.encoding, "utf8");
  assert.equal(result.fileName, "inner.txt");
});
