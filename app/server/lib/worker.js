"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  classifySevenZipError,
  createProgressTracker,
  spawnSevenZip,
} = require("./engine");
const { LIMITS } = require("./constants");
const { JobStore } = require("./jobs");
const { createTechnicalListValidator } = require("./preview");
const {
  buildExtractArgs,
  buildListArgs,
  buildStdoutExtractArgs,
} = require("./sevenzip");
const {
  findNestedTar,
  innerTarSelection,
  isNestedTar,
} = require("./nested");
const {
  closeSourceDescriptors,
  openSourceDescriptors,
  verifyFingerprints,
} = require("./source");
const {
  createDiagnosticLogger,
  safeDiagnosticWrite,
} = require("./diagnostics");
const {
  overwriteFileSync,
  truncateUtf8Name,
} = require("./fs-utils");

// 进度回写节流参数：距上次落盘 >= 200ms，或百分比跳变 >= 1 才落盘。
const PROGRESS_THROTTLE_MS = 200;
const PROGRESS_PERCENT_STEP = 1;

// 进度回写节流器。
//
// 7-Zip 在高频吐进度（-bsp1），原实现每收到一个 chunk 就做一次
// 「加锁 → 读整个 job JSON → JSON.parse → JSON.stringify(job, null, 2) → rename」，
// 单次约 6~7 个同步 syscall。同步 IO 会占住事件循环，stdout 管道来不及 drain，
// 反过来把 7-Zip 的写入阻塞住，直接拖慢解压吞吐。
//
// 这里把落盘频率压到「每 200ms 或百分比变化 1」一次，并在 phase 切换、
// 进程结束、终态之前强制 flush，保证不丢最终进度。
//
// 红线：processGroupPid 的写入**不经过**这里（registerProcessGroup /
// clearProcessGroup 直接 store.update），取消能力不受节流影响。
function createProgressWriter({
  store,
  jobId,
  phase,
  throttleMs = PROGRESS_THROTTLE_MS,
  percentStep = PROGRESS_PERCENT_STEP,
}) {
  let lastWriteMs = 0;
  let lastPercent = null;
  let pending = null;

  const flush = () => {
    if (!pending) {
      return;
    }
    const snapshot = pending;
    pending = null;
    lastWriteMs = Date.now();
    lastPercent = snapshot.percent;
    store.update(jobId, (job) => ({
      ...job,
      phase,
      progress: phase === "testing"
        ? Math.min(snapshot.percent, 5)
        : snapshot.percent,
      currentFile: snapshot.currentFile || job.currentFile,
    }));
  };

  return {
    update(snapshot) {
      pending = snapshot;
      const percentMoved = lastPercent === null
        || Math.abs(snapshot.percent - lastPercent) >= percentStep;
      if (percentMoved || Date.now() - lastWriteMs >= throttleMs) {
        flush();
      }
    },
    flush,
  };
}

function registerProcessGroup(
  store,
  jobId,
  processGroupPid,
  kill = process.kill.bind(process),
) {
  const job = store.update(jobId, (current) => ({
    ...current,
    status: current.status === "cancelling" ? "cancelling" : "running",
    processGroupPid,
    startedAt: current.startedAt || new Date().toISOString(),
  }));
  if (job.status === "cancelling" || job.cancelRequestedAt) {
    try {
      kill(-processGroupPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  return job;
}

function defaultRunPhase(phase, context) {
  return new Promise((resolve, reject) => {
    // spawnProcess 可注入，便于单测在不启动真实 7-Zip 的情况下驱动状态机。
    const spawnProcess = context.spawnProcess || spawnSevenZip;
    const child = spawnProcess(context.tool, context.args, {
      cwd: path.dirname(context.job.archivePath),
      detached: true,
    });

    registerProcessGroup(
      context.store,
      context.job.id,
      child.pid,
      context.kill,
    );
    context.store.update(context.job.id, (job) => ({
      ...job,
      phase,
    }));

    let log = "";
    // 解码器 + 增量进度解析都在 tracker 里：chunk 边界切断多字节字符时
    // 不会出现乱码（原实现用 chunk.toString("utf8")，会偶发替换字符），
    // 并且不再对整段日志重复 split/正则。
    const tracker = createProgressTracker();
    const progressWriter = createProgressWriter({
      store: context.store,
      jobId: context.job.id,
      phase,
      throttleMs: context.progressThrottleMs,
      percentStep: context.progressPercentStep,
    });
    const append = (chunk) => {
      const snapshot = tracker.write(chunk);
      if (snapshot.text) {
        log = `${log}${snapshot.text}`.slice(-LIMITS.MAX_LOG_TAIL_BYTES);
      }
      progressWriter.update(snapshot);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const clearProcessGroup = () => {
      context.store.update(context.job.id, (job) => ({
        ...job,
        processGroupPid: null,
      }));
    };
    child.once("error", (error) => {
      progressWriter.flush();
      clearProcessGroup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      // 冲刷解码器残留的半个多字节字符，并把最后一帧进度落盘。
      const tail = tracker.flush();
      if (tail.text) {
        log = `${log}${tail.text}`.slice(-LIMITS.MAX_LOG_TAIL_BYTES);
      }
      progressWriter.update(tail);
      progressWriter.flush();
      clearProcessGroup();
      if (exitCode === 0) {
        resolve({ exitCode, signal, log });
        return;
      }
      const current = context.store.read(context.job.id);
      const classified = classifySevenZipError(log, exitCode, {
        phase,
        passwordProvided: Boolean(context.passwordProvided),
        cancelled: current?.status === "cancelling"
          || Boolean(current?.cancelRequestedAt),
      });
      const error = new Error(classified.message);
      error.code = classified.code;
      error.exitCode = exitCode;
      error.signal = signal;
      error.log = log;
      reject(error);
    });
  });
}

// 校验压缩包列表：直接在 worker 进程内 spawn 7z，把 stdout 流式喂给
// createTechnicalListValidator。
//
// 原实现要多起一个 node 子进程（listing-validator.js），由它再 spawn 7z，
// 把结果 JSON 化后经 stdout 回传，worker 再 JSON.parse —— 每个任务多一次
// node 启动 + 一次 64KB 级别的序列化往返。
//
// 安全语义完整保留：createTechnicalListValidator 逐条调用 normalizeEntryPath，
// 拦截 `..` / 绝对路径 / 盘符 / NUL，并保留 maxLineBytes / maxRecordLines /
// maxRecordBytes 上限。校验失败时立即 SIGTERM（3s 后 SIGKILL）7z。
function defaultValidateListing(tool, args, context) {
  return new Promise((resolve, reject) => {
    const spawnProcess = context.spawnProcess || spawn;
    const child = spawnProcess(tool.path, args, {
      cwd: context.cwd || undefined,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    registerProcessGroup(
      context.store,
      context.job.id,
      child.pid,
      context.kill,
    );
    context.store.update(context.job.id, (job) => ({
      ...job,
      phase: "validating",
    }));

    const validator = createTechnicalListValidator();
    let stderr = "";
    let validationError = null;
    let killTimer = null;

    child.stdout.on("data", (chunk) => {
      if (validationError) {
        return;
      }
      try {
        validator.write(chunk);
      } catch (error) {
        validationError = error;
        try {
          child.kill("SIGTERM");
        } catch (killError) {
          // 子进程可能已经退出，忽略。
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch (killError) {
            // 子进程已经退出。
          }
        }, 3000);
        killTimer.unref?.();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`
        .slice(-LIMITS.MAX_LOG_TAIL_BYTES);
    });
    const clearProcessGroup = () => {
      context.store.update(context.job.id, (job) => ({
        ...job,
        processGroupPid: null,
      }));
    };
    child.once("error", (error) => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
      clearProcessGroup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
      clearProcessGroup();
      if (validationError) {
        reject(validationError);
        return;
      }
      if (exitCode !== 0) {
        const current = context.store.read(context.job.id);
        const classified = classifySevenZipError(stderr, exitCode, {
          phase: "validating",
          passwordProvided: args.some((argument) => /^-p./s.test(argument)),
          cancelled: current?.status === "cancelling"
            || Boolean(current?.cancelRequestedAt),
        });
        const error = new Error(classified.message);
        error.code = classified.code;
        error.exitCode = exitCode;
        error.signal = signal;
        error.log = stderr;
        reject(error);
        return;
      }
      try {
        resolve(validator.end());
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readAndRemoveSecret(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    const value = fs.readFileSync(filePath, "utf8");
    overwriteFileSync(filePath);
    fs.rmSync(filePath, { force: true });
    return value;
  } catch (error) {
    return "";
  }
}

function cleanupOutput(job) {
  if (job.outputOwned && job.outputDir) {
    fs.rmSync(job.outputDir, { recursive: true, force: true });
  }
}

function internalPathFromTarget(target, outputDir) {
  const out = `${path.resolve(outputDir)}${path.sep}`;
  const value = String(target || "");
  if (value.startsWith(out)) {
    return value.slice(out.length);
  }
  return value.replace(/^[/\\]+/, "");
}

function uniqueRescuePath(outputDir, internal) {
  const parsed = path.parse(internal);
  const dir = path.join(outputDir, parsed.dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  let base = truncateUtf8Name(parsed.base, 230);
  let candidate = path.join(dir, base);
  let index = 2;
  while (fs.existsSync(candidate)) {
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    candidate = path.join(dir, `${stem} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

function streamSingleToFile(tool, args, dest) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(tool.path, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let errorText = "";
    let settled = false;
    const out = fs.createWriteStream(dest, { mode: 0o644 });
    child.stderr.on("data", (chunk) => {
      errorText = `${errorText}${chunk.toString("utf8")}`.slice(-8192);
    });
    child.stdout.pipe(out);
    child.once("error", (error) => {
      settled = true;
      out.destroy();
      reject(error);
    });
    out.on("error", (error) => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
      }
      reject(error);
    });
    child.once("close", (code) => {
      out.end(() => {
        if (code !== 0) {
          try {
            fs.rmSync(dest, { force: true });
          } catch (cleanupError) {
            // ignore
          }
          const error = new Error(errorText || `7-Zip 退出码 ${code}`);
          error.code = "RESCUE_FAILED";
          error.log = errorText;
          error.exitCode = code;
          reject(error);
          return;
        }
        resolve(dest);
      });
    });
  });
}

async function rescueTooLongNameFiles({
  tool,
  job,
  log,
  password = "",
}) {
  const re = /File name too long :\s*([^\r\n]+)/g;
  const targets = new Set();
  const text = String(log || "");
  let match;
  while ((match = re.exec(text))) {
    const target = match[1].trim();
    if (target) {
      targets.add(target);
    }
  }
  const rescued = [];
  const failed = [];
  for (const target of targets) {
    const internal = internalPathFromTarget(target, job.outputDir);
    if (!internal) {
      failed.push(target);
      continue;
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-rescue-"));
    const listFile = path.join(tempDir, "list.txt");
    const dest = uniqueRescuePath(job.outputDir, internal);
    try {
      fs.writeFileSync(listFile, `${internal}\n`, { encoding: "utf8" });
      const args = buildStdoutExtractArgs(job.selection, {
        archivePath: job.archivePath,
        password,
        codePage: job.codePage || "auto",
        selectionFile: listFile,
      });
      await streamSingleToFile(tool, args, dest);
      rescued.push(dest);
    } catch (error) {
      failed.push(internal);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  return { rescued, failed };
}

function cancellationError() {
  const error = new Error("任务已取消");
  error.code = "CANCELLED";
  return error;
}

function requireActiveJob(store, jobId) {
  const job = store.read(jobId);
  if (!job) {
    throw new Error("任务不存在或已过期");
  }
  if (job.status === "cancelling" || job.cancelRequestedAt) {
    throw cancellationError();
  }
  return job;
}

async function runWorker(jobId, options = {}) {
  const runtimeRoot = options.runtimeRoot
    || options.store?.runtimeRoot
    || process.env.CHZIP_RUNTIME_ROOT;
  const store = options.store || new JobStore(runtimeRoot);
  const runPhase = options.runPhase || defaultRunPhase;
  const validateListing = options.validateListing || defaultValidateListing;
  const logger = options.logger || createDiagnosticLogger({
    rootDirs: [
      process.env.TRIM_PKGVAR
        ? path.join(process.env.TRIM_PKGVAR, "logs")
        : "",
      path.join(runtimeRoot, "logs"),
    ].filter(Boolean),
  });
  let job = store.read(jobId);
  if (!job) {
    throw new Error("任务不存在或已过期");
  }

  const password = readAndRemoveSecret(job.passwordFile);
  const tool = {
    path: job.sevenZipPath,
    source: job.sevenZipSource,
  };
  const nestedDir = path.join(store.dataDir(jobId), "nested");
  const sourceDescriptors = openSourceDescriptors(job.sourceFingerprint);

  safeDiagnosticWrite(logger, {
    event: "worker",
    status: "started",
    requestId: job.requestId || "",
    jobId,
    archivePath: job.archivePath,
  });

  try {
    verifyFingerprints(job.sourceFingerprint, sourceDescriptors);
    requireActiveJob(store, jobId);
    job = store.update(jobId, (current) => ({
      ...current,
      status: current.status === "cancelling" ? "cancelling" : "running",
      startedAt: current.startedAt || new Date().toISOString(),
      passwordFile: "",
    }));

    verifyFingerprints(job.sourceFingerprint, sourceDescriptors);
    job = requireActiveJob(store, jobId);

    let extractionSelection = job.selection;
    let extractionArchivePath = job.archivePath;
    let extractionPassword = password;
    let extractionCodePage = job.codePage;
    if (isNestedTar(job.selection)) {
      requireActiveJob(store, jobId);
      fs.mkdirSync(nestedDir, { recursive: true, mode: 0o700 });
      const prepareArgs = buildExtractArgs(job.selection, {
        archivePath: job.archivePath,
        outputDir: nestedDir,
        selectionFile: "",
        password,
        codePage: job.codePage,
      });
      await runPhase("preparing", {
        args: prepareArgs,
        job,
        store,
        tool,
        passwordProvided: Boolean(password),
      });
      verifyFingerprints(job.sourceFingerprint, sourceDescriptors);
      requireActiveJob(store, jobId);
      extractionArchivePath = findNestedTar(nestedDir);
      extractionSelection = innerTarSelection();
      extractionPassword = "";
      extractionCodePage = "auto";
      requireActiveJob(store, jobId);
    }

    let listingArgs = buildListArgs(extractionSelection, {
      archivePath: extractionArchivePath,
      password: extractionPassword,
      codePage: extractionCodePage,
    });
    let listing = await validateListing(tool, listingArgs, {
      cwd: path.dirname(extractionArchivePath),
      job,
      store,
    });
    if (!extractionSelection.format && listing.format) {
      extractionSelection = {
        ...extractionSelection,
        format: listing.format,
      };
      if (extractionCodePage !== "auto") {
        listingArgs = buildListArgs(extractionSelection, {
          archivePath: extractionArchivePath,
          password: extractionPassword,
          codePage: extractionCodePage,
        });
        listing = await validateListing(tool, listingArgs, {
          cwd: path.dirname(extractionArchivePath),
          job,
          store,
        });
      }
    }
    verifyFingerprints(job.sourceFingerprint, sourceDescriptors);
    requireActiveJob(store, jobId);

    const extractArgs = buildExtractArgs(extractionSelection, {
      archivePath: extractionArchivePath,
      outputDir: job.outputDir,
      selectionFile: job.selectionFile,
      password: extractionPassword,
      codePage: extractionCodePage,
    });
    const extractResult = await runPhase("extracting", {
      args: extractArgs,
      job,
      store,
      tool,
      passwordProvided: Boolean(extractionPassword),
    });

    store.update(jobId, (current) => {
      if (current.status === "cancelling" || current.cancelRequestedAt) {
        throw cancellationError();
      }
      return {
        ...current,
        status: "success",
        phase: "complete",
        processGroupPid: null,
        progress: 100,
        currentFile: "",
        // job.log 只在终态写一次。热路径上不再反复序列化最多 64KB 的日志，
        // 同时仍保留一份日志尾部供事后诊断（前端不消费该字段）。
        log: String(extractResult?.log || "").slice(-LIMITS.MAX_LOG_TAIL_BYTES),
        finishedAt: new Date().toISOString(),
        error: null,
      };
    });
    safeDiagnosticWrite(logger, {
      event: "worker",
      status: "success",
      requestId: job.requestId || "",
      jobId,
      outputDir: job.outputDir,
    });
  } catch (error) {
    job = store.read(jobId) || job;
    const cancelled = job.status === "cancelling"
      || Boolean(job.cancelRequestedAt)
      || error.code === "CANCELLED";
    // 文件名过长属于“个别文件写不进”的环境限制：保留已解压输出，
    // 并尝试把超长文件按“截断后的文件名”单条救回来。
    let rescuedNote = "";
    if (error.code === "FILE_NAME_TOO_LONG") {
      try {
        const { rescued } = await rescueTooLongNameFiles({
          tool,
          job,
          log: error.log || "",
          password,
        });
        if (rescued.length) {
          rescuedNote = `已把 ${rescued.length} 个超长文件名文件按截断后的名称保存。`;
        }
      } catch (rescueError) {
        // 救援失败按普通失败处理，但仍保留已解压的输出
      }
    }
    const keepPartial = error.code === "FILE_NAME_TOO_LONG";
    if (!keepPartial) {
      cleanupOutput(job);
    }
    const finalOk = Boolean(rescuedNote) && !cancelled;
    store.update(jobId, (current) => ({
      ...current,
      status: cancelled ? "cancelled" : finalOk ? "success" : "failed",
      phase: cancelled ? "cancelled" : finalOk ? "complete" : "failed",
      processGroupPid: null,
      currentFile: "",
      progress: finalOk ? 100 : current.progress,
      // 终态才写日志尾部，与成功路径一致。
      log: String(error.log || "").slice(-LIMITS.MAX_LOG_TAIL_BYTES),
      finishedAt: new Date().toISOString(),
      note: rescuedNote || current.note || "",
      error: cancelled || finalOk
        ? null
        : {
          code: error.code || "ENGINE",
          message: error.message || "解压失败",
        },
    }));
    safeDiagnosticWrite(logger, {
      event: "worker",
      status: cancelled ? "cancelled" : finalOk ? "success" : "failed",
      requestId: job.requestId || "",
      jobId,
      note: rescuedNote || "",
      error: cancelled || finalOk
        ? null
        : {
          code: error.code || "ENGINE",
          message: error.message || "解压失败",
          errno: error.errno ?? null,
          syscall: error.syscall || "",
          exitCode: error.exitCode ?? null,
          signal: error.signal || "",
          logTail: String(error.log || "").slice(-8192),
        },
    });
  } finally {
    closeSourceDescriptors(sourceDescriptors);
    fs.rmSync(nestedDir, { recursive: true, force: true });
    const current = store.read(jobId);
    if (current?.passwordFile) {
      overwriteFileSync(current.passwordFile);
    }
    for (const filePath of [current?.passwordFile, current?.selectionFile]) {
      if (filePath) {
        fs.rmSync(filePath, { force: true });
      }
    }
    if (current) {
      store.update(jobId, (latest) => ({
        ...latest,
        passwordFile: "",
        selectionFile: "",
      }));
    }
  }

  return store.read(jobId);
}

module.exports = {
  createProgressWriter,
  defaultRunPhase,
  defaultValidateListing,
  registerProcessGroup,
  runWorker,
};
