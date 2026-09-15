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
const { acquireFileLock } = require("./fs-utils");

const TERMINAL_STATUSES = new Set(JOB.TERMINAL_STATUSES);

function nowIso() {
  return new Date().toISOString();
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
    // 直接读，靠 ENOENT 判断不存在；省掉一次 existsSync 的 stat。
    // 注意：只有 ENOENT 返回 null，JSON 损坏等其它错误必须照旧抛出。
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  withLock(jobId, callback) {
    const lockPath = `${this.jobPath(jobId)}.lock`;
    // 复用 fs-utils 的锁实现：它会在 EEXIST 时检查锁文件 mtime，
    // 超过 staleMs 视为陈旧锁回收。原先这里只 sleep 不回收，
    // 一旦 worker 被 SIGKILL，残留的 .lock 会让该任务永久卡死。
    let lock;
    try {
      lock = acquireFileLock(lockPath, {
        maxAttempts: TIMEOUTS.LOCK_MAX_ATTEMPTS,
        retryMs: TIMEOUTS.LOCK_RETRY_MS,
        staleMs: TIMEOUTS.STALE_LOCK_MS,
      });
    } catch (error) {
      if (error.code === "LOCK_BUSY") {
        throw new Error("任务状态文件正忙");
      }
      throw error;
    }
    try {
      return callback();
    } finally {
      lock.release();
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

  // 节流的过期清理：cleanupExpired() 要扫三遍目录 + 逐个读 job，
  // 而 status 是 1s 一次轮询。用 runtimeRoot 下的 cleanup.stamp 记录上次
  // 真正扫描的时间（CGI 每请求一个新进程，内存态无法跨请求，必须落盘），
  // 只有距上次扫描超过 minIntervalMs 才真正执行。
  // 返回 null 表示本次被节流跳过。
  cleanupExpiredIfDue(options = {}) {
    const minIntervalMs = options.minIntervalMs ?? TIMEOUTS.CLEANUP_MIN_INTERVAL_MS;
    const nowMs = options.nowMs ?? Date.now();
    const stampPath = path.join(this.runtimeRoot, "cleanup.stamp");
    let lastRunMs = null;
    try {
      lastRunMs = fs.statSync(stampPath).mtimeMs;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    // minIntervalMs <= 0 表示「禁用节流」：必须显式放行，否则文件系统
    // 时间戳精度可能导致 stamp mtime 略快于 Date.now()，产生负值而误触发。
    if (
      minIntervalMs > 0
      && lastRunMs !== null
      && nowMs - lastRunMs < minIntervalMs
    ) {
      return null;
    }
    const removed = this.cleanupExpired(options);
    try {
      fs.writeFileSync(stampPath, "", {
        encoding: "utf8",
        mode: PERMISSIONS.MODE_FILE_SECRET,
      });
    } catch (error) {
      // 时间戳写失败不影响清理结果本身，下个请求会重试。
    }
    return removed;
  }

  cleanupExpired(options = {}) {
    const now = options.now || new Date();
    const maxAgeMs = options.maxAgeMs || JOB.EXPIRY_MS;
    const batchSize = options.batchSize || LIMITS.MAX_CLEANUP_BATCH_SIZE;
    // 注入点：单测用它模拟「statSync 时条目已被并发删除」这类竞态。
    const fsModule = options.fsModule || fs;
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

    // worker 收尾会同时删除 job JSON、<id>.d 目录与锁文件，过期清理与之并发
    // 时任何一步都可能扑空（ENOENT）；目录权限异常则可能 EPERM/EACCES。
    // 清理是「顺手做」的事，失败必须就地吞掉，不能冒到调用方的请求里。
    const tryRemove = (target, removeOptions) => {
      try {
        fsModule.rmSync(target, removeOptions);
        return true;
      } catch (error) {
        return false;
      }
    };
    const statMtimeMs = (target) => {
      try {
        return fsModule.statSync(target).mtimeMs;
      } catch (error) {
        return null;
      }
    };

    // 一次目录遍历同时完成「过期任务删除」与「残留 lock/tmp/.d 清理」。
    // 原先扫两遍，且第一遍对每个条目无条件 statSync —— worker 收尾可能在
    // readdir 与 stat 之间把条目删掉，ENOENT 就直接冒到请求层。
    for (const entry of fsModule.readdirSync(this.jobsDir, { withFileTypes: true })) {
      const name = entry.name;
      const entryPath = path.join(this.jobsDir, name);

      if (entry.isFile() && /^[a-f0-9]{32}\.json$/.test(name) && processed < batchSize) {
        processed += 1;
        const id = name.slice(0, -5);
        let job = null;
        try {
          job = this.read(id);
        } catch (error) {
          // job JSON 已损坏：跳过，留给人工排查。
        }
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
          tryRemove(job.outputDir, { recursive: true, force: true });
        }
        tryRemove(this.jobPath(id), { force: true });
        tryRemove(this.dataDir(id), { recursive: true, force: true });
        removed.push(id);
        continue;
      }

      // 残留清理：先按名字正则过滤再 stat，避免对无关条目做无谓的 syscall。
      const isOrphanDataDir = entry.isDirectory()
        && /^[a-f0-9]{32}\.d$/.test(name);
      const isStaleArtifact = entry.isFile()
        && (
          /^[a-f0-9]{32}\.json\.lock$/.test(name)
          || /^[a-f0-9]{32}\.json\.\d+\.[a-f0-9]+\.tmp$/.test(name)
        );
      if (!isOrphanDataDir && !isStaleArtifact) {
        continue;
      }
      const mtimeMs = statMtimeMs(entryPath);
      if (mtimeMs === null || now.getTime() - mtimeMs <= maxAgeMs) {
        continue;
      }
      if (
        isOrphanDataDir
        && fsModule.existsSync(
          path.join(this.jobsDir, `${name.slice(0, -2)}.json`),
        )
      ) {
        continue;
      }
      tryRemove(
        entryPath,
        isOrphanDataDir ? { recursive: true, force: true } : { force: true },
      );
    }

    for (const entry of fsModule.readdirSync(this.runtimeRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory()
        || !/^(?:nested|validate)-/.test(entry.name)
      ) {
        continue;
      }
      const directoryPath = path.join(this.runtimeRoot, entry.name);
      const mtimeMs = statMtimeMs(directoryPath);
      if (mtimeMs === null || now.getTime() - mtimeMs <= maxAgeMs) {
        continue;
      }
      tryRemove(directoryPath, { recursive: true, force: true });
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

  // 一次遍历同时完成「已结束任务溢出修剪」与「列表返回」。
  // 语义等同于原先 removeFinishedOverflow(keep) + list() 的组合：
  // 先按 finishedAt||createdAt 升序修剪掉最旧的溢出记录，再返回未过期的任务。
  // 区别只在于目录只扫一遍、每个 job 只读一次。
  listAndTrimHistory(keep = 20, options = {}) {
    const maxAgeMs = options.maxAgeMs || JOB.EXPIRY_MS;
    const now = options.now || new Date();
    const active = [];
    const finished = [];
    for (const name of fs.readdirSync(this.jobsDir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue;
      }
      const job = this.read(name.slice(0, -5));
      if (!job) {
        continue;
      }
      if (TERMINAL_STATUSES.has(job.status)) {
        finished.push(job);
      } else {
        active.push(job);
      }
    }

    finished.sort((a, b) => String(a.finishedAt || a.createdAt || "")
      .localeCompare(String(b.finishedAt || b.createdAt || "")));
    const overflow = Math.max(0, finished.length - keep);
    const removed = [];
    for (let index = 0; index < overflow; index += 1) {
      const job = finished[index];
      fs.rmSync(this.dataDir(job.id), { recursive: true, force: true });
      fs.rmSync(this.jobPath(job.id), { force: true });
      removed.push(job.id);
    }

    const jobs = [...active, ...finished.slice(overflow)].filter((job) => {
      const timestamp = job.finishedAt || job.startedAt || job.createdAt;
      return Boolean(timestamp)
        && now.getTime() - new Date(timestamp).getTime() <= maxAgeMs;
    });
    jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { jobs, removed };
  }

  // 手动清空历史：只删已结束（success/failed/cancelled）的任务记录，
  // 不碰进行中的任务，也不删除已解压出来的文件（outputDir 归用户所有）。
  removeAllFinished() {
    const removed = [];
    for (const name of fs.readdirSync(this.jobsDir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue;
      }
      const id = name.slice(0, -5);
      const job = this.read(id);
      if (!job || !TERMINAL_STATUSES.has(job.status)) {
        continue;
      }
      fs.rmSync(this.dataDir(id), { recursive: true, force: true });
      fs.rmSync(this.jobPath(id), { force: true });
      removed.push(id);
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
