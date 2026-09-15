"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  cleanupJobArtifacts,
  runWorker,
} = require("../app/server/lib/worker");

const JOB_ID = "a".repeat(32);
const DATA_DIR = "/nonexistent/jobs/x.d";

function createStore(initial = {}) {
  let job = {
    id: JOB_ID,
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
    outputOwned: false,
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

function permissionError(code) {
  return Object.assign(new Error(code), { code });
}

// ---------------------------------------------------------------- A3

// 原先 nestedDir 的 rmSync 裸露在机密清理之前：一旦抛 EPERM/EBUSY
// （共享目录里并不罕见），整个 finally 就被中断，密码文件既不覆写也不删除。
test("A3 keeps clearing secrets when a removal throws", () => {
  const store = createStore({
    passwordFile: `${DATA_DIR}/password.txt`,
    selectionFile: `${DATA_DIR}/selection.txt`,
  });
  const overwritten = [];
  const attempts = [];
  const remove = (target) => {
    attempts.push(target);
    throw permissionError("EPERM");
  };

  assert.doesNotThrow(() => {
    cleanupJobArtifacts(JOB_ID, {
      store,
      nestedDir: `${DATA_DIR}/nested`,
      remove,
      overwrite: (filePath) => overwritten.push(filePath),
    });
  });

  assert.deepEqual(
    overwritten,
    [`${DATA_DIR}/password.txt`],
    "删除失败也必须先覆写密码文件",
  );
  assert.equal(attempts.length, 3, "nested 目录 / 密码文件 / 选择文件都要尝试");
  const job = store.current();
  assert.equal(job.passwordFile, "");
  assert.equal(job.selectionFile, "");
});

test("A3 removes the selection file even if the nested dir removal fails", () => {
  const store = createStore({
    selectionFile: `${DATA_DIR}/selection.txt`,
  });
  const removed = [];
  const remove = (target) => {
    if (target.endsWith("nested")) {
      throw permissionError("EBUSY");
    }
    removed.push(target);
  };

  cleanupJobArtifacts(JOB_ID, {
    store,
    nestedDir: `${DATA_DIR}/nested`,
    remove,
    overwrite: () => {},
  });

  assert.deepEqual(removed, [`${DATA_DIR}/selection.txt`]);
  assert.equal(store.current().selectionFile, "");
});

test("A3 tolerates a job removed concurrently", () => {
  const store = {
    read: () => null,
    update() {
      throw new Error("任务不存在或已过期");
    },
  };

  assert.doesNotThrow(() => {
    cleanupJobArtifacts(JOB_ID, { store, nestedDir: "", remove: () => {} });
  });
});

test("A3 tolerates a corrupt job record", () => {
  const store = {
    read() {
      throw new SyntaxError("Unexpected token in JSON");
    },
    update() {
      throw new Error("任务不存在或已过期");
    },
  };

  assert.doesNotThrow(() => {
    cleanupJobArtifacts(JOB_ID, { store, nestedDir: "", remove: () => {} });
  });
});

test("A3 survives a failing store.update", () => {
  const store = createStore({ passwordFile: `${DATA_DIR}/password.txt` });
  store.update = () => {
    throw new Error("任务状态文件正忙");
  };
  const overwritten = [];

  assert.doesNotThrow(() => {
    cleanupJobArtifacts(JOB_ID, {
      store,
      nestedDir: "",
      remove: () => {},
      overwrite: (filePath) => overwritten.push(filePath),
    });
  });

  assert.deepEqual(overwritten, [`${DATA_DIR}/password.txt`]);
});

// 端到端：状态机抛错时 finally 仍必须把机密清干净。
// 注意 runWorker 不 rethrow —— 失败通过 job.status 表达，所以这里断言返回值。
test("A3 runWorker still cleans up when a phase throws", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-cleanup-"));
  const store = createStore({
    passwordFile: `${DATA_DIR}/password.txt`,
    selectionFile: `${DATA_DIR}/selection.txt`,
  });
  const removed = [];

  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => {
      throw new Error("解压失败");
    },
    remove: (target) => {
      removed.push(target);
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.phase, "failed");
  assert.equal(result.passwordFile, "");
  assert.equal(result.selectionFile, "");
  assert.ok(
    removed.includes(`${DATA_DIR}/selection.txt`),
    "finally 必须清掉选择文件",
  );
  assert.equal(store.current().error.message, "解压失败");
});
