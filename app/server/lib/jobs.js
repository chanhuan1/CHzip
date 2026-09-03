"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  CRYPTO,
  JOB,
  LIMITS,
  PERMISSIONS,
  TIMEOUTS,
} = require("./constants");

const TERMINAL_STATUSES = new Set(JOB.TERMINAL_STATUSES);

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.min(milliseconds, TIMEOUTS.LOCK_RETRY_MS));
}

class JobStore {
  constructor(runtimeRoot) {
    this.runtimeRoot = runtimeRoot;
    this.jobsDir = path.join(runtimeRoot, "jobs");
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
  }

  validateId(jobId) {
    if (!/^[a-f0-9]{32}$/.test(jobId || "")) {
      throw new Error("无效的任务 ID");
    }
  }

  jobPath(jobId) {
    this.validateId(jobId);
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  dataDir(jobId) {
    this.validateId(jobId);
    return path.join(this.jobsDir, `${jobId}.d`);
  }

  read(jobId) {
    const filePath = this.jobPath(jobId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  withLock(jobId, callback) {
    const lockPath = `${this.jobPath(jobId)}.lock`;
    let descriptor;
    for (let attempt = 0; attempt < TIMEOUTS.LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        descriptor = fs.openSync(lockPath, "wx", PERMISSIONS.MODE_FILE_SECRET);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        sleepSync(TIMEOUTS.LOCK_RETRY_MS);
      }
    }
    if (descriptor == null) {
      throw new Error("任务状态文件正忙");
    }
    try {
      return callback();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockPath, { force: true });
    }
  }

  write(job) {
    const filePath = this.jobPath(job.id);
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(job, null, 2), {
      encoding: "utf8",
      mode: PERMISSIONS.MODE_FILE_SECRET,
    });
    fs.renameSync(temporaryPath, filePath);
    return job;
  }

  create(input) {
    const id = crypto.randomBytes(CRYPTO.JOB_ID_BYTES).toString("hex");
    const job = {
      id,
      requestId: input.requestId || "",
      status: "queued",
      archivePath: input.archivePath,
      outputDir: input.outputDir,
      outputOwned: input.outputOwned !== false,
      selection: input.selection || null,
      sevenZipPath: input.sevenZipPath || "",
      sevenZipSource: input.sevenZipSource || "",
      codePage: input.codePage || "auto",
      selectionFile: input.selectionFile || "",
      passwordFile: input.passwordFile || "",
      partCount: input.partCount || 1,
      sourceFingerprint: input.sourceFingerprint || [],
      processGroupPid: null,
      workerPid: null,
      progress: 0,
      currentFile: "",
      log: "",
      error: null,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      createdAt: nowIso(),
    };
    fs.mkdirSync(this.dataDir(id), { recursive: true, mode: PERMISSIONS.MODE_DIR });
    return this.withLock(id, () => this.write(job));
  }

  update(jobId, mutator) {
    return this.withLock(jobId, () => {
      const current = this.read(jobId);
      if (!current) {
        throw new Error("任务不存在或已过期");
      }
      const updated = mutator({ ...current });
      if (!updated || updated.id !== jobId) {
        throw new Error("任务更新结果无效");
      }
      return this.write(updated);
    });
  }

  cleanupExpired(options = {}) {
    const now = options.now || new Date();
    const maxAgeMs = options.maxAgeMs || JOB.EXPIRY_MS;
    const batchSize = options.batchSize || LIMITS.MAX_CLEANUP_BATCH_SIZE;
    const checkProcess = options.processExists || ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    });
    const removed = [];
    let processed = 0;
    for (const name of fs.readdirSync(this.jobsDir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue;
      }
      if (processed >= batchSize) {
        break;
      }
      processed += 1;
      const id = name.slice(0, -5);
      const job = this.read(id);
      if (!job) {
        continue;
      }
      const timestamp = job.finishedAt || job.startedAt || job.createdAt;
      if (
        !timestamp
        || now.getTime() - new Date(timestamp).getTime() <= maxAgeMs
      ) {
        continue;
      }
      if (
        !TERMINAL_STATUSES.has(job.status)
        && (
          (job.workerPid && checkProcess(job.workerPid))
          || (job.processGroupPid && checkProcess(-job.processGroupPid))
        )
      ) {
        continue;
      }
      if (!TERMINAL_STATUSES.has(job.status) && job.outputOwned && job.outputDir) {
        fs.rmSync(job.outputDir, { recursive: true, force: true });
      }
      fs.rmSync(this.jobPath(id), { force: true });
      fs.rmSync(this.dataDir(id), { recursive: true, force: true });
      removed.push(id);
    }
    for (const entry of fs.readdirSync(this.jobsDir, { withFileTypes: true })) {
      const entryPath = path.join(this.jobsDir, entry.name);
      const stat = fs.statSync(entryPath);
      if (now.getTime() - stat.mtimeMs <= maxAgeMs) {
        continue;
      }
      if (
        entry.isDirectory()
        && /^[a-f0-9]{32}\.d$/.test(entry.name)
        && !fs.existsSync(path.join(
          this.jobsDir,
          `${entry.name.slice(0, -2)}.json`,
        ))
      ) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } else if (
        entry.isFile()
        && (
          /^[a-f0-9]{32}\.json\.lock$/.test(entry.name)
          || /^[a-f0-9]{32}\.json\.\d+\.[a-f0-9]+\.tmp$/.test(entry.name)
        )
      ) {
        fs.rmSync(entryPath, { force: true });
      }
    }
    for (const entry of fs.readdirSync(this.runtimeRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory()
        || !/^(?:nested|validate)-/.test(entry.name)
      ) {
        continue;
      }
      const directoryPath = path.join(this.runtimeRoot, entry.name);
      const stat = fs.statSync(directoryPath);
      if (now.getTime() - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    }
    return removed;
  }

  countActive(options = {}) {
    const processExists = options.processExists || ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    });
    const now = options.now || new Date();
    let count = 0;
    for (const name of fs.readdirSync(this.jobsDir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue;
      }
      const job = this.read(name.slice(0, -5));
      if (!job || TERMINAL_STATUSES.has(job.status)) {
        continue;
      }
      const livePid = job.workerPid || job.processGroupPid;
      if (livePid && processExists(livePid)) {
        count += 1;
        continue;
      }
      // Worker 刚起（还没登记 pid）或排队中的任务也算并发，避免瞬时超发；
      // 太久没有存活进程的非终态任务视为已崩溃残留，不计入限流。
      const started = job.startedAt ? new Date(job.startedAt).getTime() : null;
      const created = new Date(job.createdAt).getTime();
      const starting = started
        ? now.getTime() - started < 90 * 1000
        : now.getTime() - created < 5 * 60 * 1000;
      if (starting) {
        count += 1;
      }
    }
    return count;
  }

  list(options = {}) {
    const maxAgeMs = options.maxAgeMs || JOB.EXPIRY_MS;
    const now = options.now || new Date();
    const jobs = [];
    for (const name of fs.readdirSync(this.jobsDir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue;
      }
      const job = this.read(name.slice(0, -5));
      if (!job) {
        continue;
      }
      const timestamp = job.finishedAt || job.startedAt || job.createdAt;
      if (!timestamp || now.getTime() - new Date(timestamp).getTime() > maxAgeMs) {
        continue;
      }
      jobs.push(job);
    }
    return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  removeFinishedOverflow(keep = 20) {
    const finished = [];
    for (const name of fs.readdirSync(this.jobsDir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue;
      }
      const job = this.read(name.slice(0, -5));
      if (!job || !TERMINAL_STATUSES.has(job.status)) {
        continue;
      }
      finished.push({
        id: job.id,
        ts: job.finishedAt || job.createdAt || "",
      });
    }
    finished.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const removed = [];
    for (let index = 0; index < finished.length - keep; index += 1) {
      const entry = finished[index];
      fs.rmSync(this.dataDir(entry.id), { recursive: true, force: true });
      fs.rmSync(this.jobPath(entry.id), { force: true });
      removed.push(entry.id);
    }
    return removed;
  }
}

async function requestCancellation(store, jobId, dependencies = {}) {
  const kill = dependencies.kill || process.kill.bind(process);
  const sleep = dependencies.sleep
    || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let job = store.read(jobId);
  if (!job) {
    throw new Error("任务不存在或已过期");
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    return job;
  }

  job = store.update(jobId, (current) => ({
    ...current,
    status: "cancelling",
    cancelRequestedAt: nowIso(),
  }));

  if (!job.processGroupPid) {
    for (let attempt = 0; attempt < TIMEOUTS.CANCELLATION_MAX_ATTEMPTS; attempt += 1) {
      await sleep(TIMEOUTS.CANCELLATION_WAIT_MS);
      job = store.read(jobId) || job;
      if (TERMINAL_STATUSES.has(job.status) || job.processGroupPid) {
        break;
      }
    }
    if (!job.processGroupPid) {
      return job;
    }
  }

  const pidToKill = job.processGroupPid;
  try {
    kill(-pidToKill, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
    return store.read(jobId) || job;
  }

  for (let attempt = 0; attempt < TIMEOUTS.CANCELLATION_MAX_ATTEMPTS; attempt += 1) {
    let processAlive = false;
    try {
      kill(-pidToKill, 0);
      processAlive = true;
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
    if (!processAlive) {
      return store.read(jobId) || job;
    }
    await sleep(TIMEOUTS.CANCELLATION_WAIT_MS);
  }

  try {
    kill(-pidToKill, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  return store.read(jobId) || job;
}

module.exports = {
  JobStore,
  TERMINAL_STATUSES,
  nowIso,
  requestCancellation,
};
