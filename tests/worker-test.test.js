"use strict";

// F6 完整性体检（kind=test）worker 最小路径测试。
// 注入替身（runPhase/validateListing/spawnWorker 不在此文件用/memory store），
// 不起真实 7z：
// - test 走 verifyFingerprints → runPhase("testing") → success，跳过
//   validateListing / extracting / 嵌套 tar / flatten；
// - buildTestArgs 拼参正确（t/-y/-bsp1 且无 -o）；
// - extractTestFailures 解析 "Data error :"/"CRC failed :" 归因行；
// - wrapTestError 只对 DAMAGED 包装、文案诚实写「疑似」；
// - test 失败不写 partialSuccess、outputDir="" 不被 rmSync；
// - kind 透传到终态 job。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  extractTestFailures,
  runWorker,
  wrapTestError,
} = require("../app/server/lib/worker");
const { buildTestArgs } = require("../app/server/lib/sevenzip");

const JOB_ID = "7".repeat(32);
const DATA_DIR = "/nonexistent/jobs/7.d";

function createMemoryStore(initial = {}) {
  let job = {
    id: JOB_ID,
    kind: "test",
    status: "queued",
    phase: "",
    progress: 0,
    currentFile: "",
    processGroupPid: null,
    cancelRequestedAt: null,
    passwordFile: "",
    selectionFile: "",
    archivePath: "/nonexistent/archive.7z",
    outputDir: "",
    outputOwned: false,
    outputStem: "",
    partialSuccess: false,
    flattened: false,
    flattenNote: "",
    selection: { format: "7z", type: "7z" },
    codePage: "auto",
    sourceFingerprint: [],
    sevenZipPath: "/nonexistent/7zzs",
    sevenZipSource: "bundled",
    log: "",
    ...initial,
  };
  const writes = [];
  return {
    writes,
    read: () => (job ? { ...job } : null),
    dataDir: () => DATA_DIR,
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

function makeRuntimeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chzip-test-job-"));
}

// ------------------------------------------------------------ 最小路径

test("F6 test job runs only the testing phase and succeeds", async () => {
  const store = createMemoryStore();
  const phases = [];
  let validateCalls = 0;

  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot: makeRuntimeRoot(),
    runPhase: async (phase, context) => {
      phases.push({ phase, args: context.args });
      return { exitCode: 0, signal: null, log: "" };
    },
    validateListing: async () => {
      validateCalls += 1;
      return { entryCount: 1, format: "7z" };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.phase, "complete");
  assert.equal(result.progress, 100);
  assert.equal(result.error, null);
  assert.equal(validateCalls, 0, "test 不得触发 validateListing");
  assert.deepEqual(
    phases.map((entry) => entry.phase),
    ["testing"],
    "test 只应跑 testing 一个 phase（无 preparing/extracting）",
  );
  const args = phases[0].args;
  assert.equal(args[0], "t");
  assert.ok(args.includes("-bsp1"));
  assert.ok(
    !args.some((arg) => arg.startsWith("-o")),
    "test 不得带输出目录参数",
  );
  assert.ok(args.includes("/nonexistent/archive.7z"));
});

test("F6 test job kind survives to the terminal record", async () => {
  const store = createMemoryStore();

  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot: makeRuntimeRoot(),
    runPhase: async () => ({ exitCode: 0, signal: null, log: "" }),
    validateListing: async () => ({ entryCount: 0 }),
  });

  assert.equal(result.kind, "test", "kind 必须透传到终态（任务中心靠它出文案）");
});

test("F6 test failure does not touch the filesystem or partialSuccess", async () => {
  const store = createMemoryStore();
  const removed = [];
  const damagedLog = [
    "ERROR: Data Error : docs/report.bin",
    "Sub items Errors: 1",
  ].join("\n");

  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot: makeRuntimeRoot(),
    runPhase: async () => {
      const error = new Error("压缩包已损坏或数据校验失败");
      error.code = "DAMAGED";
      error.log = damagedLog;
      throw error;
    },
    validateListing: async () => ({ entryCount: 0 }),
    remove: (target) => {
      removed.push(target);
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.phase, "failed");
  assert.equal(result.error.code, "DAMAGED");
  assert.match(result.error.message, /疑似/);
  assert.match(result.error.message, /docs\/report\.bin/);
  assert.equal(result.partialSuccess, false, "体检失败不得置 partialSuccess");
  assert.equal(result.outputDir, "");
  assert.ok(
    !removed.some((target) => target === "" || target === "/"),
    "outputDir 为空串时绝不能 rmSync 空路径或根目录",
  );
});

test("F6 test job cancellation during testing lands on cancelled", async () => {
  const store = createMemoryStore();

  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot: makeRuntimeRoot(),
    runPhase: async () => {
      // runPhase 进行中用户点了停止：终态落盘前检测到 cancelRequestedAt。
      store.update(JOB_ID, (current) => ({
        ...current,
        status: "cancelling",
        cancelRequestedAt: new Date().toISOString(),
      }));
      return { exitCode: 0, signal: null, log: "" };
    },
    validateListing: async () => ({ entryCount: 0 }),
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.error, null);
});

// ------------------------------------------------------------ buildTestArgs

test("F6 buildTestArgs builds a read-only streaming test command", () => {
  const args = buildTestArgs(
    { type: "7z", format: "7z" },
    { archivePath: "/data/file.7z", password: "secret", codePage: "auto" },
  );
  assert.deepEqual(args.slice(0, 2), ["t", "-y"]);
  assert.ok(args.includes("-bsp1"), "进度输出与解压同构，前端轮询可复用");
  assert.ok(args.includes("-bb1"));
  assert.ok(args.includes("-sccUTF-8"));
  assert.ok(args.includes("-psecret"));
  assert.ok(!args.some((arg) => arg.startsWith("-o")), "体检只读不写盘");
  assert.equal(args[args.length - 1], "/data/file.7z");
});

test("F6 buildTestArgs applies the rar forced-type red line", () => {
  // 与 list/extract 同一条红线：RAR/RAR5 不强制 -tRar（引擎自动识别更稳）。
  const args = buildTestArgs(
    { type: "rar", format: "rar" },
    { archivePath: "/data/file.part1.rar", password: "", codePage: "auto" },
  );
  assert.ok(!args.some((arg) => arg.startsWith("-t")));
});

// ------------------------------------------------------------ 归因解析

test("F6 extractTestFailures parses Data error and CRC failed lines", () => {
  const log = [
    "7-Zip 26.00 (x64)",
    "Testing archive: a.7z",
    "ERROR: Data Error : photos/IMG_0001.jpg",
    "ERROR: CRC Failed : docs/report final.xlsx",
    "Sub items Errors: 2",
  ].join("\r\n");
  assert.deepEqual(extractTestFailures(log), [
    "photos/IMG_0001.jpg",
    "docs/report final.xlsx",
  ]);
});

test("F6 extractTestFailures matches case-insensitively and dedupes", () => {
  const log = [
    "data error : a.bin",
    "CRC FAILED : b.bin",
    "Data Error : a.bin",
  ].join("\n");
  assert.deepEqual(extractTestFailures(log), ["a.bin", "b.bin"]);
});

test("F6 extractTestFailures returns empty for clean or empty logs", () => {
  assert.deepEqual(extractTestFailures(""), []);
  assert.deepEqual(extractTestFailures(null), []);
  assert.deepEqual(extractTestFailures("Everything is Ok"), []);
});

// ------------------------------------------------------------ 错误包装

test("F6 wrapTestError wraps DAMAGED with an honest suspect list", () => {
  const error = new Error("压缩包已损坏或数据校验失败");
  error.code = "DAMAGED";
  error.log = "ERROR: CRC Failed : movie/part1.mkv";
  error.exitCode = 2;

  const wrapped = wrapTestError(error);

  assert.equal(wrapped.code, "DAMAGED");
  assert.equal(wrapped.exitCode, 2);
  assert.match(wrapped.message, /疑似/);
  assert.match(wrapped.message, /movie\/part1\.mkv/);
  // 诚实红线：7z t 不标卷号，文案不得假装能归因到具体分卷。
  assert.doesNotMatch(wrapped.message, /第\s*\d+\s*卷/);
});

test("F6 wrapTestError passes through non-DAMAGED errors untouched", () => {
  const error = new Error("任务已取消");
  error.code = "CANCELLED";
  assert.equal(wrapTestError(error), error);

  const damagedNoLines = new Error("压缩包已损坏或数据校验失败");
  damagedNoLines.code = "DAMAGED";
  damagedNoLines.log = "Headers Error";
  assert.equal(
    wrapTestError(damagedNoLines),
    damagedNoLines,
    "抓不到归因行时保持原文案",
  );
});

test("F6 wrapTestError caps the suspect list at five entries", () => {
  const lines = [];
  for (let index = 1; index <= 8; index += 1) {
    lines.push(`ERROR: Data Error : file${index}.bin`);
  }
  const error = new Error("x");
  error.code = "DAMAGED";
  error.log = lines.join("\n");

  const wrapped = wrapTestError(error);

  assert.match(wrapped.message, /file5\.bin/);
  assert.doesNotMatch(wrapped.message, /file6\.bin/);
  assert.match(wrapped.message, /等 8 个文件/);
});
