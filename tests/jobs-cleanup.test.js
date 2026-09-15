"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { JobStore } = require("../app/server/lib/jobs");
const { runDueCleanup } = require("../app/server/api");

function makeRuntimeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chzip-jobs-"));
}

function eperm(code = "EPERM") {
  return Object.assign(new Error(code), { code });
}

// 记录每一次 fs 调用，并允许针对特定路径注入故障。
function createSpyFs(overrides = {}) {
  const calls = { readdirSync: [], statSync: [], rmSync: [], existsSync: [] };
  return {
    calls,
    readdirSync(target, options) {
      calls.readdirSync.push(target);
      return fs.readdirSync(target, options);
    },
    statSync(target) {
      calls.statSync.push(target);
      if (overrides.statSync) {
        return overrides.statSync(target, fs.statSync);
      }
      return fs.statSync(target);
    },
    rmSync(target, options) {
      calls.rmSync.push(target);
      if (overrides.rmSync) {
        return overrides.rmSync(target, options, fs.rmSync);
      }
      return fs.rmSync(target, options);
    },
    existsSync(target) {
      calls.existsSync.push(target);
      return fs.existsSync(target);
    },
  };
}

// ------------------------------------------------------------------ A4

// 原先 cleanupExpired 扫两遍 jobsDir：一遍删过期任务，一遍清残留 lock/tmp/.d。
test("A4 scans the jobs directory only once", () => {
  const store = new JobStore(makeRuntimeRoot());
  store.create({ archivePath: "/x/a.zip", outputDir: "/x/out" });
  const spy = createSpyFs();

  store.cleanupExpired({ fsModule: spy, maxAgeMs: -1 });

  const jobsDirScans = spy.calls.readdirSync.filter(
    (target) => target === store.jobsDir,
  );
  assert.equal(jobsDirScans.length, 1, "jobsDir 只应扫一遍");
});

// 原先第二遍对每个条目无条件 statSync，与条目类型无关。
test("A4 filters entries by name before stat", () => {
  const store = new JobStore(makeRuntimeRoot());
  const unrelated = path.join(store.jobsDir, "notes.txt");
  fs.writeFileSync(unrelated, "");
  const spy = createSpyFs();

  store.cleanupExpired({ fsModule: spy, maxAgeMs: -1 });

  assert.equal(
    spy.calls.statSync.includes(unrelated),
    false,
    "名字不匹配的条目不应被 stat",
  );
});

// worker 收尾会在 readdir 与 stat 之间把条目删掉 —— 原先 ENOENT 直接冒到
// 调用方的请求里（cleanupExpiredIfDue 是在 api.js 里内联调用的）。
test("A4 survives an entry deleted between readdir and stat", () => {
  const store = new JobStore(makeRuntimeRoot());
  const orphanDir = path.join(store.jobsDir, `${"b".repeat(32)}.d`);
  fs.mkdirSync(orphanDir, { recursive: true });

  const spy = createSpyFs({
    statSync(target, realStat) {
      if (target === orphanDir) {
        throw eperm("ENOENT");
      }
      return realStat(target);
    },
  });

  assert.doesNotThrow(() => {
    store.cleanupExpired({ fsModule: spy, maxAgeMs: -1 });
  });
});

test("A4 swallows a failing removal", () => {
  const store = new JobStore(makeRuntimeRoot());
  fs.writeFileSync(path.join(store.jobsDir, `${"e".repeat(32)}.json.lock`), "");
  const spy = createSpyFs({
    rmSync() {
      throw eperm("EPERM");
    },
  });

  assert.doesNotThrow(() => {
    store.cleanupExpired({ fsModule: spy, maxAgeMs: -1 });
  });
});

test("A4 tolerates a corrupt job record", () => {
  const store = new JobStore(makeRuntimeRoot());
  fs.writeFileSync(
    path.join(store.jobsDir, `${"f".repeat(32)}.json`),
    "{ 不是合法 JSON",
  );

  assert.doesNotThrow(() => {
    store.cleanupExpired({ maxAgeMs: -1 });
  });
});

test("A4 keeps removing a stale lock when the job JSON is gone", () => {
  const store = new JobStore(makeRuntimeRoot());
  const lockPath = path.join(store.jobsDir, `${"c".repeat(32)}.json.lock`);
  fs.writeFileSync(lockPath, "");

  store.cleanupExpired({ maxAgeMs: -1 });

  assert.equal(fs.existsSync(lockPath), false);
});

test("A4 removes an orphan <id>.d directory", () => {
  const store = new JobStore(makeRuntimeRoot());
  const orphanDir = path.join(store.jobsDir, `${"d".repeat(32)}.d`);
  fs.mkdirSync(orphanDir, { recursive: true });

  store.cleanupExpired({ maxAgeMs: -1 });

  assert.equal(fs.existsSync(orphanDir), false);
});

test("A4 keeps a <id>.d directory whose job JSON still exists", () => {
  const store = new JobStore(makeRuntimeRoot());
  const job = store.create({ archivePath: "/x/a.zip", outputDir: "/x/out" });
  // 只让 .d 目录过期，任务本身保持新鲜。
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(store.dataDir(job.id), past, past);

  store.cleanupExpired({ maxAgeMs: 1000 });

  assert.equal(fs.existsSync(store.dataDir(job.id)), true);
  assert.equal(fs.existsSync(store.jobPath(job.id)), true);
});

test("A4 removes an expired finished job", () => {
  const store = new JobStore(makeRuntimeRoot());
  const job = store.create({ archivePath: "/x/a.zip", outputDir: "/x/out" });
  store.update(job.id, (current) => ({ ...current, status: "success" }));

  const removed = store.cleanupExpired({ maxAgeMs: -1 });

  assert.deepEqual(removed, [job.id]);
  assert.equal(fs.existsSync(store.jobPath(job.id)), false);
});

// ------------------------------------------- A4：调用点不得让清理异常逃逸

test("A4 runDueCleanup never lets a cleanup failure escape", () => {
  const store = {
    cleanupExpiredIfDue() {
      throw eperm("ENOENT");
    },
  };
  const events = [];
  const logger = { write: (event) => events.push(event) };

  assert.equal(runDueCleanup(store, logger), null);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "cleanup_error");
});

test("A4 runDueCleanup passes the removed list through on success", () => {
  const store = { cleanupExpiredIfDue: () => ["a", "b"] };
  assert.deepEqual(runDueCleanup(store, { write: () => {} }), ["a", "b"]);
});

test("A4 runDueCleanup survives a throwing logger", () => {
  const store = {
    cleanupExpiredIfDue() {
      throw new Error("boom");
    },
  };
  const logger = {
    write() {
      throw new Error("日志也坏了");
    },
  };

  assert.equal(runDueCleanup(store, logger), null);
});
