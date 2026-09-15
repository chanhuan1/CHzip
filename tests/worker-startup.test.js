"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  markStartupFailure,
  runWorker,
} = require("../app/server/lib/worker");

const API_PATH = path.resolve(__dirname, "..", "app", "server", "api.js");
const JOB_ID = "a".repeat(32);

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chzip-startup-"));
}

// 只实现 runWorker 启动前段真正用到的几个方法。
function createMemoryStore(initial = {}) {
  let job = {
    id: JOB_ID,
    status: "queued",
    phase: "",
    passwordFile: "",
    selectionFile: "",
    sevenZipPath: "/nonexistent/7zzs",
    sevenZipSource: "bundled",
    archivePath: "/nonexistent/archive.zip",
    outputDir: "/nonexistent/out",
    selection: { format: "zip", type: "zip" },
    codePage: "auto",
    sourceFingerprint: [],
    ...initial,
  };
  const writes = [];
  return {
    writes,
    runtimeRoot: "/tmp/chzip-startup-memory",
    read: () => (job ? { ...job } : null),
    dataDir: () => "/tmp/chzip-startup-memory/jobs/x.d",
    current: () => (job ? { ...job } : null),
    update(jobId, mutator) {
      if (!job) {
        throw new Error("任务不存在或已过期");
      }
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

// ------------------------------------------------------------------ A1

// worker 是 detached + stdio:"ignore" 起的，父进程只靠退出码判断成败。
// 退出码为 0 时 services.spawnWorker 的 exit 处理器不会落终态，
// 任务会永远停在 queued（前端表现为「任务已排队」卡死）。
test("A1 a failing worker exits with a non-zero code", () => {
  const runtimeRoot = makeTempRoot();
  const result = spawnSync(
    process.execPath,
    [API_PATH, "--worker", JOB_ID],
    {
      encoding: "utf8",
      env: { ...process.env, CHZIP_RUNTIME_ROOT: runtimeRoot },
      timeout: 30000,
    },
  );

  assert.equal(result.status, 1, "worker 失败必须以 1 退出");
  assert.match(result.stderr, /CHzip worker 失败/);
  assert.match(result.stderr, /任务不存在或已过期/);
  assert.equal(result.stdout, "", "worker 分支不应往 stdout 写 CGI 响应");
});

// 启动前段抛错（源文件在 extract 与 worker 启动之间被删/改名）时，
// 任务必须被写成终态，而不是留在 queued。
test("A1 an unreadable source marks the job failed instead of leaving it queued", async () => {
  const store = createMemoryStore({
    sourceFingerprint: [
      {
        path: "/nonexistent/chzip-missing-archive.zip",
        dev: 1,
        ino: 1,
        size: 1,
        mtimeMs: 1,
      },
    ],
  });

  await assert.rejects(
    runWorker(JOB_ID, {
      store,
      runPhase: () => {
        throw new Error("状态机不应被启动前段的失败触发");
      },
    }),
  );

  const job = store.current();
  assert.equal(job.status, "failed");
  assert.equal(job.phase, "failed");
  assert.equal(job.processGroupPid, null);
  assert.equal(job.workerPid, null);
  assert.equal(job.passwordFile, "");
  assert.equal(job.selectionFile, "");
  assert.ok(job.finishedAt, "终态必须带 finishedAt");
  assert.ok(job.error && job.error.code, "终态必须带错误码");
  assert.ok(job.error.message);
});

// 任务可能已被并发清理（过期清理 / 用户清空历史），此时没有可写的终态，
// markStartupFailure 必须静默返回而不是把原始异常盖掉。
test("A1 markStartupFailure tolerates a job removed concurrently", () => {
  const removedStore = {
    update() {
      throw new Error("任务不存在或已过期");
    },
  };
  assert.doesNotThrow(() => {
    markStartupFailure(removedStore, JOB_ID, new Error("boom"));
  });
});

test("A1 markStartupFailure falls back to WORKER_START without an error code", () => {
  const store = createMemoryStore();
  markStartupFailure(store, JOB_ID, new Error("没有 code 的异常"));
  assert.equal(store.current().error.code, "WORKER_START");
});

// 回归锁：普通 CGI 请求的错误约定（HTTP 200 + body success:false，进程退出码 0）
// 是刻意的，不能因为 worker 分支要非 0 退出码而被带偏。
test("A1 a CGI request still answers success:false with exit code 0", () => {
  const runtimeRoot = makeTempRoot();
  const result = spawnSync(process.execPath, [API_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      QUERY_STRING: "api=no-such-endpoint",
      TRIM_PKGTMP: runtimeRoot,
    },
    timeout: 30000,
  });

  assert.equal(result.status, 0, "CGI 请求失败仍以 0 退出（错误走响应体）");
  assert.match(result.stdout, /^Status: 404$/m);
  assert.match(result.stdout, /"success":false/);
  assert.match(result.stdout, /"code":"NOT_FOUND"/);
  assert.equal(result.stderr, "", "CGI 分支不应往 stderr 写内容");
});
