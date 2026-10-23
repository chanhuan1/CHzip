"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServices } = require("../app/server/lib/services");
const { runWorker, removeSourceArchive } = require("../app/server/lib/worker");

const SILENT_LOGGER = {
  write() {},
  tail() { return ""; },
  tailForRequest() { return ""; },
};

const ENCRYPTED_LISTING = [
  "Path = archive.zip",
  "Type = zip",
  "",
  "----------",
  "Path = big.txt",
  "Size = 100",
  "Attributes = A",
  "Encrypted = +",
  "",
  "Path = small.txt",
  "Size = 10",
  "Attributes = A",
  "Encrypted = +",
  "",
].join("\n");

const SOLID_ENCRYPTED_LISTING = [
  "Path = archive.rar",
  "Type = rar",
  "Solid = +",
  "",
  "----------",
  "Path = first-large.bin",
  "Size = 1000",
  "Attributes = A",
  "Encrypted = +",
  "",
  "Path = last-tiny.txt",
  "Size = 1",
  "Attributes = A",
  "Encrypted = +",
  "",
].join("\n");

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-bugfix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeArchive(root, name = "archive.zip") {
  const archivePath = path.join(root, name);
  fs.writeFileSync(archivePath, "fake-archive");
  return archivePath;
}

function inspectSource(filePath) {
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
}

function makeServices(root, overrides = {}) {
  return createServices({
    runtimeRoot: path.join(root, "runtime"),
    logger: SILENT_LOGGER,
    findTool: () => ({ path: process.execPath, source: "test" }),
    inspectSource,
    runSync: () => ({
      exitCode: 0,
      log: "",
      stdout: "Type = zip\n----------\nPath = test.txt\nSize = 1\nAttributes = A\n\n",
      stderr: "",
    }),
    discoverRoots: () => [{ path: root, canBrowse: true, canSelect: true }],
    spawnWorker: () => ({ pid: process.pid, once() {} }),
    ...overrides,
  });
}

test("preview verifies an encrypted member before reporting password success", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  const calls = [];
  const services = makeServices(root, {
    runSync(tool, args) {
      calls.push(args);
      if (calls.length === 1) {
        return { exitCode: 0, log: "", stdout: ENCRYPTED_LISTING, stderr: "" };
      }
      return { exitCode: 0, log: "", stdout: "", stderr: "" };
    },
  });

  const result = services.preview({ path: archivePath, password: "correct" });

  assert.equal(result.passwordVerified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "t");
  assert.ok(calls[1].includes("-spd"));
  assert.ok(calls[1].some((arg) => arg.startsWith("-i@")));
  assert.match(calls[1].find((arg) => arg.startsWith("-i@")), /verify-/);
});

test("preview probes the first member of a solid archive to avoid scanning the tail", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root, "solid.rar");
  const selectedPaths = [];
  const services = makeServices(root, {
    runSync(tool, args) {
      if (args[0] === "l") {
        return { exitCode: 0, log: "", stdout: SOLID_ENCRYPTED_LISTING, stderr: "" };
      }
      const selectionArg = args.find((arg) => arg.startsWith("-i@"));
      selectedPaths.push(fs.readFileSync(selectionArg.slice(3), "utf8").trim());
      return { exitCode: 0, log: "", stdout: "", stderr: "" };
    },
  });

  const result = services.preview({ path: archivePath, password: "correct" });

  assert.equal(result.passwordVerified, true);
  assert.deepEqual(selectedPaths, ["first-large.bin"]);
});

test("password verification timeout offers direct extraction fallback", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  let calls = 0;
  const services = makeServices(root, {
    runSync() {
      calls += 1;
      if (calls === 1) {
        return { exitCode: 0, log: "", stdout: ENCRYPTED_LISTING, stderr: "" };
      }
      throw Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
    },
  });

  assert.throws(
    () => services.preview({ path: archivePath, password: "slow" }),
    (error) => {
      assert.equal(error.code, "PASSWORD_VERIFY_TIMEOUT");
      assert.match(error.message, /直接整包解压/);
      return true;
    },
  );
});

test("preview propagates PASSWORD when the encrypted member rejects the password", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  let calls = 0;
  const services = makeServices(root, {
    runSync() {
      calls += 1;
      if (calls === 1) {
        return { exitCode: 0, log: "", stdout: ENCRYPTED_LISTING, stderr: "" };
      }
      throw Object.assign(new Error("Wrong password"), { code: "PASSWORD" });
    },
  });

  assert.throws(
    () => services.preview({ path: archivePath, password: "wrong" }),
    (error) => error.code === "PASSWORD",
  );
});

test("preview does not claim an encrypted archive is verified without a password", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  let calls = 0;
  const services = makeServices(root, {
    runSync() {
      calls += 1;
      return { exitCode: 0, log: "", stdout: ENCRYPTED_LISTING, stderr: "" };
    },
  });

  const result = services.preview({ path: archivePath });
  assert.equal(result.passwordRequired, true);
  assert.equal(result.passwordVerified, false);
  assert.equal(calls, 1, "没有密码时不应启动无意义的验证进程");
});

test("preview reports a missing zip main volume with structured details", (t) => {
  const root = makeRoot(t);
  const firstPart = path.join(root, "ARCHIVE.Z01");
  const secondPart = path.join(root, "ARCHIVE.Z02");
  fs.writeFileSync(firstPart, "part-one");
  fs.writeFileSync(secondPart, "part-two");
  const services = makeServices(root);

  assert.throws(
    () => services.preview({ path: firstPart }),
    (error) => {
      assert.equal(error.code, "MISSING_VOLUME");
      assert.equal(error.details.missingFirstVolume, true);
      assert.equal(error.details.missingTotal, 1);
      return true;
    },
  );
});

test("comment writes are rejected while the same archive has an active job", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  let runCalls = 0;
  const services = makeServices(root, {
    runSync() {
      runCalls += 1;
      return { exitCode: 0, log: "", stdout: "", stderr: "" };
    },
  });
  const job = services.store.create({
    archivePath,
    outputDir: path.join(root, "out"),
    sevenZipPath: process.execPath,
    selection: { format: "zip", type: "zip" },
    sourceFingerprint: [{
      path: archivePath,
      ...fs.statSync(archivePath),
    }],
  });
  services.store.update(job.id, (current) => ({
    ...current,
    status: "running",
    startedAt: new Date().toISOString(),
    workerPid: process.pid,
  }));

  assert.throws(
    () => services.comment({ path: archivePath, comment: "new comment" }),
    (error) => error.code === "ARCHIVE_BUSY",
  );
  assert.equal(runCalls, 0, "忙碌时不得触碰 7-Zip 或源压缩包");
});

test("extract evaluates the concurrency count while holding the launch lock", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  const runtimeRoot = path.join(root, "runtime");
  const services = makeServices(root);
  const originalCountActive = services.store.countActive.bind(services.store);
  let observedLock = false;
  services.store.countActive = (options) => {
    observedLock = fs.existsSync(path.join(runtimeRoot, "launch.lock"));
    return originalCountActive(options);
  };

  services.extract({ path: archivePath, destinationRoot: root });

  assert.equal(observedLock, true);
});

test("selective extraction performs one preview inside the source lock", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  let listCalls = 0;
  const services = makeServices(root, {
    runSync(tool, args) {
      if (args[0] === "l") {
        listCalls += 1;
      }
      return {
        exitCode: 0,
        log: "",
        stdout: "Type = zip\n----------\nPath = test.txt\nSize = 1\nAttributes = A\n\n",
        stderr: "",
      };
    },
  });

  services.extract({
    path: archivePath,
    destinationRoot: root,
    selectedPaths: ["test.txt"],
  });

  assert.equal(listCalls, 1);
});

test("extract refuses to race a comment write holding the source lock", (t) => {
  const root = makeRoot(t);
  const archivePath = makeArchive(root);
  const runtimeRoot = path.join(root, "runtime");
  const services = makeServices(root);
  const canonicalArchive = fs.realpathSync(archivePath);
  const key = crypto.createHash("sha256")
    .update(canonicalArchive)
    .digest("hex")
    .slice(0, 32);
  const lockDir = path.join(runtimeRoot, "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, `source-${key}.lock`), "");

  assert.throws(
    () => services.extract({ path: archivePath, destinationRoot: root }),
    (error) => error.code === "ARCHIVE_BUSY",
  );
});

function createMemoryStore(initial = {}) {
  let job = {
    id: "r".repeat(32),
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
  return {
    read: () => (job ? { ...job } : null),
    dataDir: () => "/nonexistent/jobs/r.d",
    update(jobId, mutator) {
      const next = mutator({ ...job });
      if (!next || next.id !== jobId) {
        throw new Error("invalid update");
      }
      job = next;
      return { ...job };
    },
  };
}

test("output cleanup failure still writes a terminal failed job", async (t) => {
  const runtimeRoot = makeRoot(t);
  const outputDir = path.join(runtimeRoot, "out");
  fs.mkdirSync(outputDir, { recursive: true });
  const store = createMemoryStore({ outputDir, workerPid: process.pid });
  const result = await runWorker("r".repeat(32), {
    store,
    runtimeRoot,
    logger: SILENT_LOGGER,
    validateListing: async () => ({ entryCount: 1, format: "zip" }),
    runPhase: async () => {
      throw Object.assign(new Error("boom"), { code: "ENGINE" });
    },
    removeOutput() {
      throw Object.assign(new Error("remove denied"), { code: "EACCES" });
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.workerPid, null);
  assert.match(result.error.message, /未能自动清理/);
});

test("cancel returns only the client-facing job view", async (t) => {
  const root = makeRoot(t);
  const services = makeServices(root);
  const job = services.store.create({
    archivePath: "/vol1/share/a.zip",
    outputDir: path.join(root, "out"),
    selection: { kind: "single", format: "zip" },
    sevenZipPath: "/secret/7zzs",
    sourceFingerprint: [{ path: "/vol1/share/a.zip" }],
  });
  fs.mkdirSync(job.outputDir);

  const view = await services.cancel({ jobId: job.id });

  assert.equal(view.id, job.id);
  assert.equal(view.status, "cancelled");
  assert.equal("sourceFingerprint" in view, false);
  assert.equal("sevenZipPath" in view, false);
  assert.equal("selection" in view, false);
});

test("partial source deletion reports volumes that could not be removed", (t) => {
  const root = makeRoot(t);
  const first = path.join(root, "sample.7z.001");
  const second = path.join(root, "sample.7z.002");
  fs.writeFileSync(first, "one");
  fs.writeFileSync(second, "two");
  const fsModule = {
    ...fs,
    rmSync(filePath, options) {
      if (filePath === second) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return fs.rmSync(filePath, options);
    },
  };
  const fingerprint = [first, second].map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  });

  const result = removeSourceArchive({
    kind: "extract",
    deleteSource: true,
    archivePath: first,
    sourceFingerprint: fingerprint,
  }, { fsModule });

  assert.equal(result.deletedCount, 1);
  assert.match(result.deleteNote, /另有 1 个未能删除/);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);
});
