"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");

const {
  createProgressWriter,
  defaultRunPhase,
  defaultValidateListing,
  registerProcessGroup,
} = require("../app/server/lib/worker");

const JOB_ID = "a".repeat(32);

// 记录每一次 store.update 的结果快照，用来断言「写了什么、写了几次」。
function createMemoryStore(initial = {}) {
  let job = {
    id: JOB_ID,
    status: "queued",
    phase: "",
    progress: 0,
    currentFile: "",
    processGroupPid: null,
    cancelRequestedAt: null,
    archivePath: "/tmp/chzip-test/archive.zip",
    outputDir: "/tmp/chzip-test/out",
    selection: { format: "zip", type: "zip" },
    codePage: "auto",
    log: "",
    ...initial,
  };
  const writes = [];
  return {
    writes,
    read: () => ({ ...job }),
    update(jobId, mutator) {
      const next = mutator({ ...job });
      if (!next || next.id !== jobId) {
        throw new Error("任务更新结果无效");
      }
      job = next;
      writes.push({ ...next });
      return { ...job };
    },
  };
}

// 用纯 EventEmitter 冒充子进程，data/close 都是同步触发，测试完全确定。
function createFakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

// ------------------------------------------------------------ B1：进度节流

test("B1 createProgressWriter throttles on percent step and keeps the newest snapshot", () => {
  const store = createMemoryStore();
  const writer = createProgressWriter({
    store,
    jobId: JOB_ID,
    phase: "extracting",
    throttleMs: 60000,
    percentStep: 5,
  });

  for (const percent of [0, 1, 2, 3, 4]) {
    writer.update({ percent, currentFile: "a.txt" });
  }
  assert.equal(store.writes.length, 1, "首次立即落盘，之后跳变 < 5 且未到时间窗");

  writer.update({ percent: 5, currentFile: "b.txt" });
  assert.equal(store.writes.length, 2, "跳变达到 5 应落盘");

  writer.update({ percent: 6, currentFile: "c.txt" });
  writer.update({ percent: 7, currentFile: "d.txt" });
  assert.equal(store.writes.length, 2, "跳变不足且未到时间窗时不应落盘");

  writer.flush();
  assert.equal(store.writes.length, 3, "flush 应把最新快照落盘");
  assert.equal(store.writes[2].progress, 7);
  assert.equal(store.writes[2].currentFile, "d.txt");

  writer.flush();
  assert.equal(store.writes.length, 3, "没有待落盘快照时 flush 不应重复写");
});

test("B1 createProgressWriter flushes every update when the throttle window is zero", () => {
  const store = createMemoryStore();
  const writer = createProgressWriter({
    store,
    jobId: JOB_ID,
    phase: "extracting",
    throttleMs: 0,
    percentStep: 1000,
  });

  writer.update({ percent: 1, currentFile: "a" });
  writer.update({ percent: 2, currentFile: "b" });
  writer.update({ percent: 3, currentFile: "c" });

  assert.equal(store.writes.length, 3);
  assert.equal(store.writes[2].progress, 3);
});

test("B1 createProgressWriter keeps the previous file name when the snapshot has none", () => {
  const store = createMemoryStore({ currentFile: "keep.txt" });
  const writer = createProgressWriter({
    store,
    jobId: JOB_ID,
    phase: "extracting",
    throttleMs: 0,
  });

  writer.update({ percent: 10, currentFile: "" });
  assert.equal(store.writes[0].currentFile, "keep.txt");
});

// ------------------------------------------------------------ B1：取消红线

test("B1 registerProcessGroup persists the pid immediately, outside the throttle", () => {
  const store = createMemoryStore();
  const job = registerProcessGroup(store, JOB_ID, 9876);

  assert.equal(job.processGroupPid, 9876);
  assert.equal(store.read().processGroupPid, 9876, "取消依赖的 pid 必须立刻可见");
  assert.equal(store.read().status, "running");
});

test("B1 defaultRunPhase writes and clears processGroupPid without waiting for the throttle", async () => {
  const child = createFakeChild(1234);
  const store = createMemoryStore();
  const phasePromise = defaultRunPhase("extracting", {
    args: [],
    job: store.read(),
    store,
    tool: { path: "/bin/true" },
    spawnProcess: () => child,
    progressThrottleMs: 60000,
    progressPercentStep: 100,
  });

  assert.equal(
    store.read().processGroupPid,
    1234,
    "还没吐任何进度，pid 就必须已经落盘",
  );

  child.stdout.emit("data", Buffer.from("  50% a.txt\r", "utf8"));
  child.emit("close", 0, null);
  await phasePromise;

  assert.equal(store.read().processGroupPid, null, "进程结束后应清空 pid");
  assert.equal(store.read().progress, 50, "结束时应落最终进度");
});

test("B1 defaultRunPhase persists the final progress even when the throttle blocks it", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const phasePromise = defaultRunPhase("extracting", {
    args: [],
    job: store.read(),
    store,
    tool: { path: "/bin/true" },
    spawnProcess: () => child,
    progressThrottleMs: 60000,
    progressPercentStep: 100,
  });

  // 大量进度都在同一个时间窗内，且跳变都小于 100
  for (let percent = 1; percent <= 60; percent += 1) {
    child.stdout.emit("data", Buffer.from(`  ${percent}% f${percent}.bin\r`, "utf8"));
  }
  const beforeClose = store.writes.length;
  assert.ok(
    beforeClose <= 4,
    `60 次进度更新应被节流压缩到极少落盘，实际 ${beforeClose} 次`,
  );

  child.emit("close", 0, null);
  await phasePromise;

  assert.ok(
    store.writes.length <= beforeClose + 2,
    "close 时只应补写最终进度 + 清空 processGroupPid",
  );
  assert.equal(store.read().progress, 60, "最终进度不得因节流丢失");
  assert.equal(store.read().currentFile, "f60.bin");
  assert.equal(store.read().processGroupPid, null);
});

// ------------------------------------------------------------ B2：解码与日志

test("B2 defaultRunPhase decodes multi-byte names split across chunks", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const phasePromise = defaultRunPhase("extracting", {
    args: [],
    job: store.read(),
    store,
    tool: { path: "/bin/true" },
    spawnProcess: () => child,
    progressThrottleMs: 0,
  });

  const payload = Buffer.from("  42% 中文名.txt\r", "utf8");
  for (const byte of payload) {
    child.stdout.emit("data", Buffer.from([byte]));
  }
  child.emit("close", 0, null);

  const result = await phasePromise;
  assert.equal(result.log, "  42% 中文名.txt\r", "日志不得出现替换字符");
  assert.equal(store.read().currentFile, "中文名.txt");
  assert.equal(store.read().progress, 42);
});

test("B2 defaultRunPhase merges stdout and stderr into one log", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const phasePromise = defaultRunPhase("extracting", {
    args: [],
    job: store.read(),
    store,
    tool: { path: "/bin/true" },
    spawnProcess: () => child,
    progressThrottleMs: 0,
  });

  child.stdout.emit("data", Buffer.from("  10% a.txt\r", "utf8"));
  child.stderr.emit("data", Buffer.from("WARN x\r", "utf8"));
  child.emit("close", 0, null);

  const result = await phasePromise;
  assert.equal(result.log, "  10% a.txt\rWARN x\r");
});

test("B2 defaultRunPhase rejects with a classified error carrying the log", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const phasePromise = defaultRunPhase("extracting", {
    args: [],
    job: store.read(),
    store,
    tool: { path: "/bin/true" },
    spawnProcess: () => child,
    progressThrottleMs: 0,
  });

  child.stderr.emit("data", Buffer.from("Wrong password or CRC failed", "utf8"));
  child.emit("close", 2, null);

  await assert.rejects(
    () => phasePromise,
    (error) => {
      assert.equal(error.code, "PASSWORD");
      assert.equal(error.log, "Wrong password or CRC failed");
      assert.equal(error.exitCode, 2);
      return true;
    },
  );
  assert.equal(store.read().processGroupPid, null, "失败后也要清空 pid");
});

// ------------------------------------------------------------ B3：日志只在终态落盘

test("B3 hot-path progress writes never carry the log payload", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const phasePromise = defaultRunPhase("extracting", {
    args: [],
    job: store.read(),
    store,
    tool: { path: "/bin/true" },
    spawnProcess: () => child,
    progressThrottleMs: 0,
  });

  for (let percent = 1; percent <= 20; percent += 1) {
    child.stdout.emit("data", Buffer.from(`  ${percent}% file${percent}.bin\r`, "utf8"));
  }
  child.emit("close", 0, null);
  await phasePromise;

  assert.ok(store.writes.length > 0);
  for (const write of store.writes) {
    assert.equal(write.log || "", "", "热路径不得把日志写进 job（应在终态写一次）");
  }
});

// ------------------------------------------------------------ B6：进程内列表校验

const LISTING_OUTPUT = "Type = zip\n----------\nPath = a.txt\nSize = 1\n\n";

test("B6 defaultValidateListing validates in-process and returns entryCount/format", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const promise = defaultValidateListing(
    { path: "/bin/true" },
    ["l", "-slt", "x.zip"],
    { cwd: "/tmp", job: store.read(), store, spawnProcess: () => child },
  );

  child.stdout.emit("data", Buffer.from(LISTING_OUTPUT, "utf8"));
  child.emit("close", 0, null);

  const listing = await promise;
  assert.equal(listing.format, "zip");
  assert.equal(listing.entryCount, 1);
  assert.equal(store.read().phase, "validating");
  assert.equal(store.read().processGroupPid, null);
});

test("B6 defaultValidateListing still rejects parent traversal entries", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const promise = defaultValidateListing(
    { path: "/bin/true" },
    ["l", "-slt", "x.zip"],
    { cwd: "/tmp", job: store.read(), store, spawnProcess: () => child },
  );

  child.stdout.emit(
    "data",
    Buffer.from("Type = zip\n----------\nPath = ../evil.txt\nSize = 1\n\n", "utf8"),
  );
  child.emit("close", 0, null);

  await assert.rejects(() => promise, /\.\.|上级|路径/);
});

test("B6 defaultValidateListing still rejects absolute paths inside the archive", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const promise = defaultValidateListing(
    { path: "/bin/true" },
    ["l", "-slt", "x.zip"],
    { cwd: "/tmp", job: store.read(), store, spawnProcess: () => child },
  );

  child.stdout.emit(
    "data",
    Buffer.from("Type = zip\n----------\nPath = /etc/passwd\nSize = 1\n\n", "utf8"),
  );
  child.emit("close", 0, null);

  await assert.rejects(() => promise);
});

test("B6 defaultValidateListing kills 7z when validation fails", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const killed = [];
  child.kill = (signal) => {
    killed.push(signal);
  };

  const promise = defaultValidateListing(
    { path: "/bin/true" },
    ["l", "-slt", "x.zip"],
    { cwd: "/tmp", job: store.read(), store, spawnProcess: () => child },
  );

  child.stdout.emit(
    "data",
    Buffer.from("Type = zip\n----------\nPath = ../evil.txt\nSize = 1\n\n", "utf8"),
  );
  assert.deepEqual(killed, ["SIGTERM"], "校验失败应立即 SIGTERM 7z");

  child.emit("close", 0, null);
  await assert.rejects(() => promise);
});

test("B6 defaultValidateListing classifies a non-zero exit and keeps stderr", async () => {
  const child = createFakeChild();
  const store = createMemoryStore();
  const promise = defaultValidateListing(
    { path: "/bin/true" },
    ["l", "-slt", "x.zip"],
    { cwd: "/tmp", job: store.read(), store, spawnProcess: () => child },
  );

  child.stderr.emit("data", Buffer.from("Enter password", "utf8"));
  child.emit("close", 255, null);

  await assert.rejects(
    () => promise,
    (error) => {
      assert.equal(error.code, "PASSWORD_REQUIRED");
      assert.equal(error.log, "Enter password");
      return true;
    },
  );
});

test("B6 defaultValidateListing reports a cancellation instead of a password error", async () => {
  const child = createFakeChild();
  const store = createMemoryStore({ status: "cancelling" });
  const promise = defaultValidateListing(
    { path: "/bin/true" },
    ["l", "-slt", "x.zip"],
    { cwd: "/tmp", job: store.read(), store, spawnProcess: () => child },
  );

  child.emit("close", 255, null);

  await assert.rejects(() => promise, (error) => error.code === "CANCELLED");
});
