"use strict";

// 失败时保留部分成果：PARTIAL_KEEP_CODES 集合内错误码（FILE_NAME_TOO_LONG /
// DAMAGED / MISSING_VOLUME / PERMISSION / ENGINE_INTERRUPTED）必须保留
// outputDir 并在终态写 partialSuccess=true；取消永不保留；test kind 不进入此逻辑。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runWorker } = require("../app/server/lib/worker");

const JOB_ID = "p".repeat(32);
const DATA_DIR = "/nonexistent/jobs/p.d";

function createMemoryStore(initial = {}) {
  let job = {
    id: JOB_ID,
    kind: "extract",
    status: "queued",
    phase: "",
    progress: 0,
    currentFile: "",
    processGroupPid: null,
    cancelRequestedAt: null,
    passwordFile: "",
    selectionFile: "",
    archivePath: "/nonexistent/archive.zip",
    outputDir: "/nonexistent/out",
    outputOwned: true,
    outputStem: "archive",
    partialSuccess: false,
    flattened: false,
    flattenNote: "",
    selection: { format: "zip", type: "zip" },
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

function makeRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chzip-partial-"));
}

// 通用驱动：让 runPhase 抛指定错误码。
async function runWithError(errorCode, storeOverrides = {}) {
  const runtimeRoot = makeRuntime();
  const outputDir = path.join(runtimeRoot, "out");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "partial.txt"), "partial");
  const store = createMemoryStore({ outputDir, ...storeOverrides });
  const err = Object.assign(new Error(`boom ${errorCode}`), { code: errorCode });
  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => {
      throw err;
    },
  });
  return { result, outputDir, store, runtimeRoot };
}

for (const code of [
  "FILE_NAME_TOO_LONG",
  "DAMAGED",
  "MISSING_VOLUME",
  "PERMISSION",
  "ENGINE_INTERRUPTED",
]) {
test(`partial keep: ${code} keeps outputDir and writes partialSuccess=true`, async () => {
    const { result, outputDir } = await runWithError(code);
    assert.equal(result.status, "failed");
    assert.equal(
      result.partialSuccess,
      true,
      `${code} 应在终态落 partialSuccess=true`,
    );
    assert.ok(
      fs.existsSync(path.join(outputDir, "partial.txt")),
      `${code} 应保留已解压输出（不得 cleanupOutput）`,
    );
  });
}

test("generic ENGINE error still cleans outputDir (no partialSuccess)", async () => {
  const { result, outputDir } = await runWithError("ENGINE");
  assert.equal(result.status, "failed");
  assert.equal(result.partialSuccess, false);
  assert.ok(!fs.existsSync(outputDir), "非保留类错误仍应 cleanupOutput");
});

test("cancellation preserves partial output and marks partialSuccess", async () => {
  const runtimeRoot = makeRuntime();
  const outputDir = path.join(runtimeRoot, "out");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "partial.txt"), "partial");
  const store = createMemoryStore({
    outputDir,
    cancelRequestedAt: new Date().toISOString(),
  });
  // 把状态推到 cancelling，让 requireActiveJob 在启动阶段就抛 CANCELLED。
  store.update(JOB_ID, (current) => ({ ...current, status: "cancelling" }));
  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => ({ exitCode: 0, log: "" }),
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.partialSuccess, true, "主动停止解压应标记部分成果");
  assert.ok(fs.existsSync(outputDir), "主动停止解压应保留已解压的文件");
  assert.ok(fs.existsSync(path.join(outputDir, "partial.txt")), "已解压文件应完整保留");
});

test("test kind never sets partialSuccess even for DAMAGED", async () => {
  const runtimeRoot = makeRuntime();
  const store = createMemoryStore({
    kind: "test",
    outputDir: "",
    outputOwned: false,
  });
  const err = Object.assign(new Error("boom DAMAGED"), { code: "DAMAGED" });
  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => {
      throw err;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.partialSuccess, false, "test kind 不进入 partialSuccess 逻辑");
});

test("success terminal does not write partialSuccess", async () => {
  // 防御：success 终态不得带 partialSuccess=true。
  const runtimeRoot = makeRuntime();
  const outputDir = path.join(runtimeRoot, "out");
  fs.mkdirSync(outputDir, { recursive: true });
  const store = createMemoryStore({ outputDir });
  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => ({ exitCode: 0, log: "" }),
  });
  assert.equal(result.status, "success");
  assert.equal(result.partialSuccess, false, "success 终态不得有 partialSuccess=true");
});
