"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServices } = require("../app/server/lib/services");
const { JobStore } = require("../app/server/lib/jobs");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-queue-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 与 integration.test.js 同一套桩：inspect/runSync/discoverRoots 全 fake，
// 不真的起 7z。
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
  // EventEmitter 形状的 stub：launchWorker 只调 .pid 和 .once。
  return {
    pid,
    once() {},
  };
}

function writeArchive(name = "a.zip") {
  const archivePath = path.join(tmpDir, name);
  fs.writeFileSync(archivePath, "fake-archive");
  return archivePath;
}

// ------------------------------------------------------------ 排队与唤起

test("extract spawns immediately when a slot is free", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(10000 + spawned.length);
    },
  }));
  const archivePath = writeArchive();

  const result = services.extract({ path: archivePath, destinationRoot: tmpDir });

  assert.equal(spawned.length, 1, "有名额应立即启动");
  assert.equal(spawned[0], result.jobId);
  assert.equal(result.queued, undefined, "立即启动不带 queued 标记");
  assert.equal(result.queueAhead, undefined);
  const job = services.store.read(result.jobId);
  assert.ok(job.workerPid > 0, "workerPid 应已登记");
});

test("extract keeps the job queued when slots are full", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(20000 + spawned.length);
    },
  }));
  // 手动塞满 3 个活跃任务（用真活着的进程 pid 让 countActive 计入）
  for (let index = 0; index < 3; index += 1) {
    const job = services.store.create({
      archivePath: "/x.zip",
      outputDir: "/x/out",
      selection: { format: "zip", type: "zip" },
      sevenZipPath: process.execPath,
      sevenZipSource: "test",
      partCount: 1,
      sourceFingerprint: [],
    });
    services.store.update(job.id, (current) => ({
      ...current,
      status: "running",
      startedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));
  }
  const archivePath = writeArchive();

  const result = services.extract({ path: archivePath, destinationRoot: tmpDir });

  assert.equal(spawned.length, 0, "满员不应立即 spawn");
  assert.equal(result.queued, true);
  assert.equal(typeof result.queueAhead, "number");
  assert.equal(result.queueAhead, 0, "队列里只有它自己，前面 0 个");
  const job = services.store.read(result.jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.workerPid, null, "排队任务不应登记 workerPid");
});

test("extract reports queueAhead counting only earlier queued jobs", () => {
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: () => fakeWorker(30000),
  }));
  // 3 个活跃（占满名额）
  for (let index = 0; index < 3; index += 1) {
    const job = services.store.create({
      archivePath: "/x.zip",
      outputDir: "/x/out",
      selection: { format: "zip", type: "zip" },
      sevenZipPath: process.execPath,
      sevenZipSource: "test",
      partCount: 1,
      sourceFingerprint: [],
    });
    services.store.update(job.id, (current) => ({
      ...current,
      status: "running",
      startedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));
  }
  // 先排 2 个队列任务
  const archive1 = writeArchive("a1.zip");
  const archive2 = writeArchive("a2.zip");
  services.extract({ path: archive1, destinationRoot: tmpDir });
  // 人为把第一个排队任务的 createdAt 改早，确保严格时序
  const jobs1 = fs.readdirSync(services.store.jobsDir)
    .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
    .map((name) => services.store.read(name.slice(0, -5)))
    .filter((job) => job && job.status === "queued");
  // 第一个 queued
  const first = jobs1[0];
  services.store.update(first.id, (current) => ({
    ...current,
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  }));

  const result = services.extract({ path: archive2, destinationRoot: tmpDir });

  assert.equal(result.queued, true);
  assert.equal(result.queueAhead, 1, "前面应有 1 个排队任务");
});

test("spawnQueued launches pending jobs in createdAt order while slots free", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(40000 + spawned.length);
    },
  }));
  // 造 2 个排队任务：old（5 分钟前创建）和 newer（刚刚）
  const old = services.store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });
  services.store.update(old.id, (current) => ({
    ...current,
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  const newer = services.store.create({
    archivePath: "/y.zip",
    outputDir: "/y/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });

  services.spawnQueued();

  assert.deepEqual(spawned, [old.id, newer.id], "按 createdAt 升序唤起");
  assert.ok(services.store.read(old.id).workerPid > 0);
  assert.ok(services.store.read(newer.id).workerPid > 0);
});

test("spawnQueued stops launching when slots fill up", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(50000 + spawned.length);
    },
  }));
  // 用**真实存活**的当前进程 pid 占满全部 3 个名额。
  // （用不存在的假 pid 会被 countActive 当作「已崩溃残留」不计入并发，
  //   名额判定就会失真——这里必须让名额真的占满。）
  for (let index = 0; index < 3; index += 1) {
    const job = services.store.create({
      archivePath: "/x.zip",
      outputDir: "/x/out",
      selection: { format: "zip", type: "zip" },
      sevenZipPath: process.execPath,
      sevenZipSource: "test",
      partCount: 1,
      sourceFingerprint: [],
    });
    services.store.update(job.id, (current) => ({
      ...current,
      status: "running",
      startedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));
  }
  // 排 1 个等待
  const q1 = services.store.create({
    archivePath: "/a.zip",
    outputDir: "/a/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });

  services.spawnQueued();

  assert.equal(spawned.length, 0, "名额已满，一个排队任务都不唤起");
  assert.equal(services.store.read(q1.id).status, "queued");
  assert.equal(services.store.read(q1.id).workerPid, null);
});

test("spawnQueued skips jobs with cancelRequestedAt", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(60000);
    },
  }));
  const cancelled = services.store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });
  services.store.update(cancelled.id, (current) => ({
    ...current,
    cancelRequestedAt: new Date().toISOString(),
  }));

  services.spawnQueued();

  assert.equal(spawned.length, 0, "已请求取消的排队任务不应被唤起");
});

test("spawnQueued swallows internal errors", () => {
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: () => {
      throw new Error("spawn failed");
    },
  }));
  services.store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });

  assert.doesNotThrow(() => services.spawnQueued());
});

// ------------------------------------------------------------ countActive 启发式

test("countActive does not starve a zombie queued job forever", () => {
  // 场景：worker 启动即崩溃（从未写 startedAt/workerPid），job 永远停在 queued。
  // 原始启发式：created<5min 计入并发 → 5 分钟后不再计入 → spawnQueued 能唤起它。
  const store = new JobStore(tmpDir);
  const zombie = store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });
  // 把 createdAt 改到 6 分钟前（超过 5min starting 窗口）
  store.update(zombie.id, (current) => ({
    ...current,
    createdAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
  }));

  // processExists 永远 false（模拟无存活进程）
  const active = store.countActive({ processExists: () => false });
  assert.equal(active, 0, "超过 starting 窗口的僵尸 queued 不计入并发");
});

test("countActive counts a fresh queued job as active (starting window)", () => {
  const store = new JobStore(tmpDir);
  store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });

  const active = store.countActive({ processExists: () => false });
  assert.equal(active, 1, "5 分钟内的 queued 任务按 starting 计入并发（防超发）");
});

// ------------------------------------------------------------ launchWorker 竞态

test("launchWorker is idempotent when called concurrently on the same job", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(70000 + spawned.length);
    },
  }));
  const job = services.store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });

  services.launchWorker(job.id);
  services.launchWorker(job.id);
  services.launchWorker(job.id);

  assert.equal(spawned.length, 1, "同一 job 重复调用只启动一次");
  assert.equal(services.store.read(job.id).workerPid, 70001);
});

test("launchWorker refuses to start a job that is not queued", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(80000);
    },
  }));
  const job = services.store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });
  services.store.update(job.id, (current) => ({
    ...current,
    status: "running",
    workerPid: 12345,
  }));

  services.launchWorker(job.id);

  assert.equal(spawned.length, 0, "非 queued 不应再启动");
});

// ------------------------------------------------------------ status/listJobs 顺带唤起

test("status triggers spawnQueued before reading", () => {
  const spawned = [];
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: (jobId) => {
      spawned.push(jobId);
      return fakeWorker(90000);
    },
  }));
  const queued = services.store.create({
    archivePath: "/x.zip",
    outputDir: "/x/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });
  // 先把 createdAt 改老，确保不落入 starting 窗口（不影响 spawnQueued 本身，
  // 但让断言更干净）
  services.store.update(queued.id, (current) => ({
    ...current,
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  }));

  const view = services.status({ jobId: queued.id });

  assert.equal(spawned.length, 1, "status 应顺带唤起排队任务");
  assert.equal(spawned[0], queued.id);
  assert.equal(view.id, queued.id);
});

test("listJobs surfaces queueAhead for waiting jobs", () => {
  const services = createServices(makeStubs({
    runtimeRoot: tmpDir,
    spawnWorker: () => fakeWorker(99999),
  }));
  // 占满 3 个
  for (let index = 0; index < 3; index += 1) {
    const job = services.store.create({
      archivePath: "/x.zip",
      outputDir: "/x/out",
      selection: { format: "zip", type: "zip" },
      sevenZipPath: process.execPath,
      sevenZipSource: "test",
      partCount: 1,
      sourceFingerprint: [],
    });
    services.store.update(job.id, (current) => ({
      ...current,
      status: "running",
      startedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));
  }
  // 排 2 个（前一个早一点）
  const q1 = services.store.create({
    archivePath: "/a.zip",
    outputDir: "/a/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });
  services.store.update(q1.id, (current) => ({
    ...current,
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  }));
  const q2 = services.store.create({
    archivePath: "/b.zip",
    outputDir: "/b/out",
    selection: { format: "zip", type: "zip" },
    sevenZipPath: process.execPath,
    sevenZipSource: "test",
    partCount: 1,
    sourceFingerprint: [],
  });

  const { active } = services.listJobs();
  const view1 = active.find((j) => j.id === q1.id);
  const view2 = active.find((j) => j.id === q2.id);
  assert.equal(view1.queueAhead, 0);
  assert.equal(view2.queueAhead, 1);
});

// ------------------------------------------------------------ api.js 429 已删

test("api main no longer rejects extract with TOO_MANY_REQUESTS", () => {
  const apiPath = path.resolve(__dirname, "..", "app", "server", "api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  assert.equal(
    source.includes("当前解压任务过多"),
    false,
    "api.js 不应再包含 429 拒绝文案",
  );
  assert.equal(
    source.includes("TOO_MANY_REQUESTS"),
    false,
    "api.js 不应再抛 TOO_MANY_REQUESTS",
  );
});
