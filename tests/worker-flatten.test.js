"use strict";

// F2 智能拍平测试：worker 成功收尾时，若 outputDir 下只剩一个与 outputStem
// 同名（忽略大小写）的目录，就把这层壳拆掉。注入替身驱动：
// - runWorker 用 memory store + 注入 runPhase/validateListing，不起 7z；
// - flattenSingleRootDirectory 直接注入 fsModule 替身，覆盖所有分支。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  flattenSingleRootDirectory,
  runWorker,
} = require("../app/server/lib/worker");

const JOB_ID = "f".repeat(32);
const DATA_DIR = "/nonexistent/jobs/f.d";

function createMemoryStore(initial = {}) {
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
    outputStem: "archive",
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

function fakeDirent(name, isDir) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

function createFakeFs({ rootEntries = [], innerEntries = [], failOn = null } = {}) {
  const calls = { rename: [], rmdir: [] };
  return {
    calls,
    readdirSync(target) {
      if (target === "/nonexistent/out") {
        return rootEntries;
      }
      if (target === "/nonexistent/out/archive" || target === "/nonexistent/out/Archive") {
        return innerEntries;
      }
      return [];
    },
    renameSync(from, to) {
      if (failOn === "rename") {
        const error = new Error("EEXIST");
        error.code = "EEXIST";
        throw error;
      }
      calls.rename.push([from, to]);
    },
    rmdirSync(target) {
      if (failOn === "rmdir") {
        const error = new Error("ENOTEMPTY");
        error.code = "ENOTEMPTY";
        throw error;
      }
      calls.rmdir.push(target);
    },
  };
}

test("F2 flattens a single same-named root directory", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("archive", true)],
    innerEntries: ["a.txt", "b.txt"],
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "archive" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, true);
  assert.match(result.flattenNote, /archive/);
  assert.deepEqual(fake.calls.rename, [
    ["/nonexistent/out/archive/a.txt", "/nonexistent/out/a.txt"],
    ["/nonexistent/out/archive/b.txt", "/nonexistent/out/b.txt"],
  ]);
  assert.deepEqual(fake.calls.rmdir, ["/nonexistent/out/archive"]);
});

test("F2 ignores case when matching the root directory name", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("Archive", true)],
    innerEntries: ["a.txt"],
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "ARCHIVE" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, true);
});

test("F2 does not flatten when multiple visible entries exist", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("archive", true), fakeDirent("other", true)],
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "archive" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, false);
  assert.equal(fake.calls.rename.length, 0);
});

test("F2 does not flatten a single file", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("archive", false)],
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "archive" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, false);
});

test("F2 does not flatten when directory name differs from outputStem", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("something-else", true)],
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "archive" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, false);
});

test("F2 ignores hidden files when counting visible entries", () => {
  const fake = createFakeFs({
    rootEntries: [
      fakeDirent(".DS_Store", false),
      fakeDirent(".hidden", true),
      fakeDirent("archive", true),
    ],
    innerEntries: ["a.txt"],
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "archive" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, true);
});

test("F2 swallows rename conflicts and reports not-flattened", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("archive", true)],
    innerEntries: ["a.txt"],
    failOn: "rename",
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "archive" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, false);
  assert.equal(result.flattenNote, "");
});

test("F2 swallows rmdir failures and reports not-flattened", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("archive", true)],
    innerEntries: [],
    failOn: "rmdir",
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "archive" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, false);
});

test("F2 returns not-flattened when outputStem is empty", () => {
  const fake = createFakeFs({
    rootEntries: [fakeDirent("archive", true)],
  });
  const result = flattenSingleRootDirectory(
    { outputDir: "/nonexistent/out", outputStem: "" },
    { fsModule: fake },
  );
  assert.equal(result.flattened, false);
});

// 集成：runWorker 成功收尾必须真的调用 flatten，并把 flattened/flattenNote
// 并入 success 终态那**一次** store.update。
test("F2 runWorker flattens a matching single root on success", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-flatten-"));
  const outputDir = path.join(runtimeRoot, "out");
  fs.mkdirSync(path.join(outputDir, "archive"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "archive", "a.txt"), "hello");

  const store = createMemoryStore({ outputDir, outputStem: "archive" });
  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => ({ exitCode: 0, log: "" }),
  });

  assert.equal(result.status, "success");
  assert.equal(result.phase, "complete");
  assert.equal(result.flattened, true);
  assert.match(result.flattenNote, /archive/);
  assert.ok(fs.existsSync(path.join(outputDir, "a.txt")));
  assert.ok(!fs.existsSync(path.join(outputDir, "archive")));
});

test("F2 flatten result rides on the success-terminal update", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-flatten-"));
  const outputDir = path.join(runtimeRoot, "out");
  fs.mkdirSync(path.join(outputDir, "archive"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "archive", "a.txt"), "hello");

  const store = createMemoryStore({ outputDir, outputStem: "archive" });
  await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => ({ exitCode: 0, log: "" }),
  });

  const successWrites = store.writes.filter((w) => w.status === "success");
  // 成功终态应至少落盘一次，且**最终**那次必须带上 flatten 结果
  //（flattened/flattenNote 与 success 并入同一次终态 update）。
  assert.ok(successWrites.length >= 1, "成功终态至少落盘一次");
  const finalSuccess = successWrites[successWrites.length - 1];
  assert.equal(finalSuccess.flattened, true);
  assert.match(finalSuccess.flattenNote, /archive/);
});

// 红线：flatten 内部抛错也绝不影响 success。让 readdirSync 在 outputDir
// 上抛 ENOENT（outputDir 不存在），flatten 必须静默吞掉。
test("F2 runWorker keeps success even if flatten cannot read outputDir", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-flatten-"));
  const outputDir = path.join(runtimeRoot, "missing-out");
  const store = createMemoryStore({ outputDir, outputStem: "archive" });
  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => ({ exitCode: 0, log: "" }),
  });
  assert.equal(result.status, "success");
  assert.equal(result.flattened, false);
  assert.equal(result.flattenNote, "");
});

test("F2 non-matching root keeps flattened=false on success", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-flatten-"));
  const outputDir = path.join(runtimeRoot, "out");
  fs.mkdirSync(path.join(outputDir, "different"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "different", "a.txt"), "hello");

  const store = createMemoryStore({ outputDir, outputStem: "archive" });
  const result = await runWorker(JOB_ID, {
    store,
    runtimeRoot,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => ({ exitCode: 0, log: "" }),
  });

  assert.equal(result.status, "success");
  assert.equal(result.flattened, false);
  assert.equal(result.flattenNote, "");
  assert.ok(fs.existsSync(path.join(outputDir, "different", "a.txt")));
});
