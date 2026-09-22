"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CONFLICT_POLICIES,
  buildExtractArgs,
  normalizeConflictPolicy,
} = require("../app/server/lib/sevenzip");
const { runWorker } = require("../app/server/lib/worker");
const { createServices } = require("../app/server/lib/services");
const { routeRequest } = require("../app/server/api");

const JOB_ID = "a".repeat(32);
const ZIP_SELECTION = { format: "zip", type: "zip" };
const COMMON_EXTRACT = { archivePath: "/data/a.zip", outputDir: "/out" };

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chzip-f1-"));
}

// ------------------------------------------------------------ 参数映射

test("F1 buildExtractArgs maps every conflict policy to its -ao flag", () => {
  const expectations = {
    rename: "-aou",
    overwrite: "-aoa",
    skip: "-aos",
    keepnew: "-aot",
  };
  assert.deepEqual(Object.keys(CONFLICT_POLICIES).sort(),
    Object.keys(expectations).sort(), "白名单与映射表必须一一对应");
  for (const [policy, flag] of Object.entries(expectations)) {
    const args = buildExtractArgs(ZIP_SELECTION, {
      ...COMMON_EXTRACT,
      conflictPolicy: policy,
    });
    const aoFlags = args.filter((arg) => /^-ao/i.test(arg));
    assert.deepEqual(aoFlags, [flag],
      `conflictPolicy=${policy} 应恰好出现一次 ${flag}，实际 ${args.join(" ")}`);
  }
});

test("F1 buildExtractArgs defaults to rename (-aou) when policy is omitted", () => {
  const args = buildExtractArgs(ZIP_SELECTION, COMMON_EXTRACT);
  assert.deepEqual(args.filter((arg) => /^-ao/i.test(arg)), ["-aou"]);
});

test("F1 normalizeConflictPolicy rejects unknown values (CGI whitelist)", () => {
  assert.throws(() => normalizeConflictPolicy("delete-everything"),
    /不支持的解压冲突策略/);
  assert.throws(() => buildExtractArgs(ZIP_SELECTION, {
    ...COMMON_EXTRACT,
    conflictPolicy: "$(rm -rf /)",
  }), /不支持的解压冲突策略/);
  assert.equal(normalizeConflictPolicy("").id, "rename", "空串回落默认");
  assert.equal(normalizeConflictPolicy(undefined).id, "rename");
});

// ------------------------------------------------------------ worker 正式解压

function createWorkerStore(initial = {}) {
  const runtimeRoot = initial.runtimeRoot || makeTempRoot();
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
    selection: ZIP_SELECTION,
    codePage: "auto",
    conflictPolicy: "rename",
    sourceFingerprint: [],
    sevenZipPath: "/nonexistent/7zzs",
    sevenZipSource: "bundled",
    log: "",
    ...initial,
  };
  delete job.runtimeRoot;
  return {
    runtimeRoot,
    read: () => (job ? { ...job } : null),
    dataDir: () => path.join(runtimeRoot, "jobs", `${JOB_ID}.d`),
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
      return { ...job };
    },
  };
}

const SILENT_LOGGER = { write() {}, tail() { return ""; } };

test("F1 worker passes job.conflictPolicy to the real extract buildExtractArgs", async () => {
  const store = createWorkerStore({ conflictPolicy: "overwrite" });
  const phases = [];
  const finalJob = await runWorker(JOB_ID, {
    store,
    logger: SILENT_LOGGER,
    runPhase: (phase, context) => {
      phases.push({ phase, args: [...context.args] });
      return Promise.resolve({ exitCode: 0, log: "" });
    },
    validateListing: () => Promise.resolve({ format: "zip" }),
  });

  assert.equal(finalJob.status, "success", "替身跑通整个状态机");
  const extracting = phases.filter((entry) => entry.phase === "extracting");
  assert.equal(extracting.length, 1, "非嵌套包只正式解压一次");
  assert.deepEqual(
    extracting[0].args.filter((arg) => /^-ao/i.test(arg)),
    ["-aoa"],
    "job.conflictPolicy=overwrite 必须映射成 -aoa",
  );
});

// ------------------------------------------------------------ 红线：嵌套 tar 预解不受策略污染

test("F1 nested-tar pre-extract keeps the default -aou while the real extract honors the policy", async () => {
  const runtimeRoot = makeTempRoot();
  const store = createWorkerStore({
    runtimeRoot,
    conflictPolicy: "skip",
    selection: { kind: "single", format: "gzip", type: "gzip", innerFormat: "tar" },
  });
  const phases = [];
  const finalJob = await runWorker(JOB_ID, {
    store,
    logger: SILENT_LOGGER,
    runPhase: (phase, context) => {
      phases.push({ phase, args: [...context.args] });
      if (phase === "preparing") {
        // 替身不跑真 7z：手动在预解目录放一个 inner.tar，
        // 让 findNestedTar 能找到唯一内部归档，状态机继续走。
        const outArg = context.args.find((arg) => arg.startsWith("-o"));
        const outDir = outArg.slice(2);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "inner.tar"), "fake-tar");
      }
      return Promise.resolve({ exitCode: 0, log: "" });
    },
    validateListing: () => Promise.resolve({ format: "tar" }),
  });

  assert.equal(finalJob.status, "success");
  const preparing = phases.find((entry) => entry.phase === "preparing");
  const extracting = phases.find((entry) => entry.phase === "extracting");
  assert.ok(preparing && extracting, "嵌套 tar 应同时有预解与正式解压");
  assert.deepEqual(
    preparing.args.filter((arg) => /^-ao/i.test(arg)),
    ["-aou"],
    "红线：嵌套 tar 预解（mkdtemp 空目录）必须保持默认 -aou",
  );
  assert.deepEqual(
    extracting.args.filter((arg) => /^-ao/i.test(arg)),
    ["-aos"],
    "正式解压应用 job.conflictPolicy=skip ⇒ -aos",
  );
});

// ------------------------------------------------------------ 红线：services 预览准备目录不受策略污染

function createStubServices(tmpDir, runSync) {
  return createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: process.execPath, source: "test" }),
    runSync,
    discoverRoots: () => [{ path: tmpDir, canBrowse: true, canSelect: true }],
    spawnWorker: () => ({ unref() {} }),
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
  });
}

test("F1 services.withPreparedArchive never forwards conflictPolicy to its extract", () => {
  const tmpDir = makeTempRoot();
  const archivePath = path.join(tmpDir, "nested.tar.gz");
  fs.writeFileSync(archivePath, "fake-nested");

  const LIST_STDOUT = "Type = gzip\n----------\nPath = test.txt\nSize = 100\nAttributes = A\n\n";
  const extractCalls = [];
  const services = createStubServices(tmpDir, (tool, args) => {
    if (args[0] === "x") {
      extractCalls.push([...args]);
      const outDir = args.find((arg) => arg.startsWith("-o")).slice(2);
      // 替身预解：准备一个唯一内部 TAR 让 withPreparedArchive 走完。
      fs.writeFileSync(path.join(outDir, "inner.tar"), "fake-tar");
      return { exitCode: 0, log: "", stdout: "", stderr: "" };
    }
    return { exitCode: 0, log: "", stdout: LIST_STDOUT, stderr: "" };
  });

  // 即使调用方在 input 里塞了 conflictPolicy（预览请求本不该有），
  // withPreparedArchive 的 buildExtractArgs 也不允许把它带进去。
  services.preview({ path: archivePath, conflictPolicy: "overwrite" });

  assert.equal(extractCalls.length, 1, "嵌套 tar 预览应恰好预解一次");
  assert.deepEqual(
    extractCalls[0].filter((arg) => /^-ao/i.test(arg)),
    ["-aou"],
    "红线：withPreparedArchive 必须保持默认 -aou",
  );
});

// ------------------------------------------------------------ services.extract 写库

test("F1 services.extract stores conflictPolicy on the job (default rename)", () => {
  const tmpDir = makeTempRoot();
  const archivePath = path.join(tmpDir, "plain.zip");
  fs.writeFileSync(archivePath, "fake-archive");
  const services = createStubServices(tmpDir, () => ({
    exitCode: 0,
    log: "",
    stdout: "Type = zip\n----------\nPath = test.txt\nSize = 100\nAttributes = A\n\n",
    stderr: "",
  }));

  const defaulted = services.extract({ path: archivePath, destinationRoot: tmpDir });
  assert.equal(services.store.read(defaulted.jobId).conflictPolicy, "rename",
    "缺省必须落 rename");

  const explicit = services.extract({
    path: archivePath,
    destinationRoot: tmpDir,
    conflictPolicy: "keepnew",
  });
  assert.equal(services.store.read(explicit.jobId).conflictPolicy, "keepnew");
  services.store.removeAllFinished();
});

// ------------------------------------------------------------ api 透传

test("F1 api extract route forwards body.conflictPolicy to services.extract", async () => {
  const captured = [];
  const fakeServices = {
    async extract(input) {
      captured.push(input);
      return { jobId: JOB_ID, outputDir: "/out" };
    },
  };

  await routeRequest("extract", {
    query: {},
    body: { path: "/data/a.zip", conflictPolicy: "keepnew" },
    requestId: "",
  }, fakeServices);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].conflictPolicy, "keepnew");

  captured.length = 0;
  await routeRequest("extract", {
    query: {},
    body: { path: "/data/a.zip" },
    requestId: "",
  }, fakeServices);
  assert.equal(captured[0].conflictPolicy, "rename", "body 缺省时回落 rename");
});

// ------------------------------------------------------------ 前端 POST body

test("F1 ui startExtract posts conflictPolicy from the settings select", async () => {
  require("../app/www/js/ui-jobs");
  const { startExtract } = globalThis.CHzipUiJobs;

  const classList = () => ({ toggle() {}, remove() {}, add() {} });
  const state = {
    running: false,
    jobId: "",
    pollTimer: null,
    etaTracker: null,
    previewLimited: false,
    selectedPaths: new Set(),
    allFilePaths: [],
    filePath: "/data/a.zip",
    selectedDirectory: "/data",
    elements: {
      extractBtn: { disabled: false },
      passwordInput: { value: "" },
      codePageSelect: { value: "auto" },
      conflictPolicySelect: { value: "skip" },
      outputPreview: { textContent: "" },
      notice: { className: "", textContent: "" },
      progressFill: { style: {}, classList: classList() },
      progressText: { textContent: "" },
      jobState: { textContent: "" },
      currentFile: { textContent: "" },
      progressEta: { hidden: true, textContent: "" },
      progressTrack: { classList: classList() },
    },
  };
  const posts = [];
  const api = {
    POLL_TIMEOUT_MS: 5000,
    apiUrl(name) { return `/cgi/?api=${name}`; },
    async postApi(name, body) {
      posts.push({ name, body });
      // 返回空 jobId：startExtract 后续的 pollStatus 直接早退，
      // 不需要再模拟完整任务生命周期。
      return { jobId: "", outputDir: "/data/a" };
    },
    async requestJson() {
      throw new Error("测试不驱动常驻监听");
    },
  };

  await startExtract(state, api);

  const extractPost = posts.find((entry) => entry.name === "extract");
  assert.ok(extractPost, "应发出 extract 请求");
  assert.equal(extractPost.body.conflictPolicy, "skip");
  assert.equal(extractPost.body.codePage, "auto");
});
