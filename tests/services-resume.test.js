"use strict";

// F8 services.resume：
// - 校验：job 不存在 / 非 failed / 无 partialSuccess / outputDir 已删 / 非 extract kind
// - 成功：沿用旧 outputDir、conflictPolicy=skip、retryOf 落新任务
// - 密码文件重新写（旧密码文件已被 worker 启动时销毁）
// - 满员时保持 queued，由 spawnQueued 唤起

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServices } = require("../app/server/lib/services");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-resume-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStubs(overrides = {}) {
  return {
    findTool: () => ({ path: process.execPath, source: "test" }),
    runSync: () => ({
      exitCode: 0,
      log: "",
      stdout: "Type = zip\n----------\nPath = test.txt\nSize = 100\nAttributes = A\n\n",
      stderr: "",
    }),
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
    ...overrides,
  };
}

function fakeWorker(pid) {
  return { pid, once() {} };
}

function writeArchive(name = "a.zip") {
  const archivePath = path.join(tmpDir, name);
  fs.writeFileSync(archivePath, "fake-archive");
  return archivePath;
}

// 造一个「已失败 + 保留了部分成果」的旧任务。
function seedFailedPartialJob(services, overrides = {}) {
  const archivePath = writeArchive();
  const outputDir = path.join(tmpDir, "out-partial");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "done-1.txt"), "done");
  const job = services.store.create({
    archivePath,
    outputDir,
    outputOwned: true,
    outputStem: "out-partial",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
    ...overrides,
  });
  services.store.update(job.id, (current) => ({
    ...current,
    status: "failed",
    phase: "failed",
    partialSuccess: true,
    finishedAt: new Date().toISOString(),
    error: { code: "DAMAGED", message: "压缩包已损坏或数据校验失败" },
  }));
  return services.store.read(job.id);
}

test("F8 resume rejects a missing job", () => {
  const services = createServices(makeStubs({ runtimeRoot: tmpDir }));
  assert.throws(
    () => services.resume({ jobId: "f".repeat(32) }),
    /原任务不存在或已过期/,
  );
});

test("F8 resume rejects a job that is not failed", () => {
  const services = createServices(makeStubs({ runtimeRoot: tmpDir }));
  const old = seedFailedPartialJob(services);
  services.store.update(old.id, (c) => ({ ...c, status: "success" }));
  assert.throws(
    () => services.resume({ jobId: old.id }),
    /仅「失败且保留了部分成果」的任务可以续跑/,
  );
});

test("F8 resume rejects a failed job without partialSuccess", () => {
  const services = createServices(makeStubs({ runtimeRoot: tmpDir }));
  const old = seedFailedPartialJob(services);
  services.store.update(old.id, (c) => ({ ...c, partialSuccess: false }));
  assert.throws(
    () => services.resume({ jobId: old.id }),
    /仅「失败且保留了部分成果」的任务可以续跑/,
  );
});

test("F8 resume rejects when the old outputDir was deleted", () => {
  const services = createServices(makeStubs({ runtimeRoot: tmpDir }));
  const old = seedFailedPartialJob(services);
  fs.rmSync(old.outputDir, { recursive: true, force: true });
  assert.throws(
    () => services.resume({ jobId: old.id }),
    /原输出目录已被删除/,
  );
});

test("F8 resume rejects a non-extract kind", () => {
  const services = createServices(makeStubs({ runtimeRoot: tmpDir }));
  const old = seedFailedPartialJob(services, { kind: "test" });
  assert.throws(
    () => services.resume({ jobId: old.id }),
    /仅解压任务支持续跑/,
  );
});

test("F8 resume reuses old outputDir, forces skip, records retryOf", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(42000);
    },
  }));
  const old = seedFailedPartialJob(services);

  const result = services.resume({ jobId: old.id, password: "", codePage: "auto" });

  assert.equal(spawned.length, 1, "有名额应立即唤起 worker");
  assert.equal(spawned[0], result.jobId);
  assert.notEqual(result.jobId, old.id, "必须是新任务 id");
  assert.equal(result.retryOf, old.id);
  const created = services.store.read(result.jobId);
  assert.equal(created.retryOf, old.id);
  assert.equal(created.conflictPolicy, "skip", "续跑必须强制 skip 冲突策略");
  assert.equal(created.outputDir, old.outputDir, "必须沿用旧 outputDir");
  assert.equal(created.outputOwned, true);
  // archivePath 经 info() 的 inspectSource 用 realpathSync 解析——macOS 上
  // /var 是 /private/var 的软链，os.tmpdir() 返回 /var/... 而 realpath 得到
  // /private/var/...，两者指向同一文件。比较前统一 realpath，避免平台表示差。
  assert.equal(
    fs.realpathSync(created.archivePath),
    fs.realpathSync(old.archivePath),
    "必须沿用同一源压缩包",
  );
  assert.ok(
    fs.existsSync(path.join(old.outputDir, "done-1.txt")),
    "续跑不得删除已解压文件",
  );
});

test("F8 resume rewrites the password file (old one destroyed at worker start)", () => {
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: () => fakeWorker(43000),
  }));
  const old = seedFailedPartialJob(services);

  const result = services.resume({
    jobId: old.id,
    password: "new-secret",
    codePage: "auto",
  });

  const created = services.store.read(result.jobId);
  assert.ok(created.passwordFile, "应重新写 passwordFile");
  assert.equal(fs.readFileSync(created.passwordFile, "utf8"), "new-secret");
});

test("F8 resume queues when slots are full", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(44000 + spawned.length);
    },
  }));
  // 占满 3 个名额（用当前进程 pid，确保 countActive 真计入）
  for (let i = 0; i < 3; i += 1) {
    const j = services.store.create({
      archivePath: "/x.zip",
      outputDir: "/x/out",
      selection: { format: "zip", type: "zip" },
      sevenZipPath: process.execPath,
      sevenZipSource: "test",
      partCount: 1,
      sourceFingerprint: [],
    });
    services.store.update(j.id, (current) => ({
      ...current,
      status: "running",
      startedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));
  }
  const old = seedFailedPartialJob(services);

  const result = services.resume({ jobId: old.id, password: "", codePage: "auto" });

  assert.equal(spawned.length, 0, "满员不应立即 spawn");
  assert.equal(result.queued, true);
  assert.equal(typeof result.queueAhead, "number");
  const created = services.store.read(result.jobId);
  assert.equal(created.status, "queued");
  assert.equal(created.workerPid, null);
  assert.equal(created.conflictPolicy, "skip");
  assert.equal(created.retryOf, old.id);
});

test("F8 resume does not delete old outputDir when a startup step fails", () => {
  // 让 launchWorker 抛错：模拟 spawn 失败路径。resume 的 catch 绝不删旧 outputDir。
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: () => {
      throw new Error("spawn failed");
    },
  }));
  const old = seedFailedPartialJob(services);

  assert.throws(
    () => services.resume({ jobId: old.id, password: "", codePage: "auto" }),
    /spawn failed/,
  );
  assert.ok(
    fs.existsSync(path.join(old.outputDir, "done-1.txt")),
    "续跑启动失败也绝不删旧 outputDir",
  );
});
