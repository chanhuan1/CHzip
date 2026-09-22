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
const { LIMITS, PERMISSIONS, TIMEOUTS } = require("./constants");
const { JobStore } = require("./jobs");
const { createTechnicalListValidator } = require("./preview");
const {
  buildExtractArgs,
  buildListArgs,
  buildStdoutExtractArgs,
  buildTestArgs,
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

// F8 失败保留部分成果：这些错误码都属于「非源文件问题」（源文件被换 /
// 权限被拒走 SOURCE_* 分支，不在此列），已解压出来的文件仍然有价值，
// 终态时保留 outputDir 并把 partialSuccess 置 true，供「续跑」入口识别。
// 仅 extract kind 走此逻辑；test kind 无 outputDir 产出，不在此集合生效。
const PARTIAL_KEEP_CODES = new Set([
  "FILE_NAME_TOO_LONG",
  "DAMAGED",
  "MISSING_VOLUME",
  "PERMISSION",
  "ENGINE_INTERRUPTED",
]);

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
      progress: snapshot.percent,
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
        }, TIMEOUTS.CANCELLATION_KILL_MS);
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
  fs.mkdirSync(dir, { recursive: true, mode: PERMISSIONS.MODE_DIR_OUTPUT });
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
    const out = fs.createWriteStream(dest, { mode: PERMISSIONS.MODE_FILE_DEFAULT });
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

// 任务收尾清理。
//
// 每一步都必须独立 try/catch：原先 nestedDir 的 rmSync 裸露在机密清理之前，
// 一旦抛 EPERM/EBUSY（共享目录里并不罕见）就会中断整个 finally ——
// selection.txt 残留、job JSON 的 selectionFile 字段也不会被清空。
//
// remove / overwrite 可注入，便于单测在不制造真实权限故障的前提下
// 验证「某一步失败不会吃掉其它步」。
function cleanupJobArtifacts(jobId, options = {}) {
  const {
    store,
    nestedDir = "",
    remove = fs.rmSync,
    overwrite = overwriteFileSync,
  } = options;

  if (nestedDir) {
    try {
      remove(nestedDir, { recursive: true, force: true });
    } catch (error) {
      // 嵌套 tar 的临时目录清不掉不影响机密清理，交给过期清理兜底。
    }
  }

  let current = null;
  try {
    current = store.read(jobId);
  } catch (error) {
    // job JSON 已损坏或被并发删除，没有可清理的文件路径记录。
  }

  if (current?.passwordFile) {
    try {
      overwrite(current.passwordFile);
    } catch (error) {
      // 覆写失败仍要继续尝试删除，不能在这里提前返回。
    }
  }

  for (const filePath of [current?.passwordFile, current?.selectionFile]) {
    if (!filePath) {
      continue;
    }
    try {
      remove(filePath, { force: true });
    } catch (error) {
      // 单个文件删除失败不影响其它文件。
    }
  }

  try {
    store.update(jobId, (latest) => ({
      ...latest,
      passwordFile: "",
      selectionFile: "",
    }));
  } catch (error) {
    // 任务已被并发清理，无需再清字段。
  }
}

function cancellationError() {
  const error = new Error("任务已取消");
  error.code = "CANCELLED";
  return error;
}

// F2 智能拍平：解压成功收尾时，如果 outputDir 下只剩一个目录（隐藏文件如
// .DS_Store 忽略），且这个目录名与 job.outputStem 大小写不敏感相等，就把这层
// 壳拆掉——目录里的所有条目 renameSync 上移一级，空壳 rmdirSync。
//
// 设计要点：
// - 整个 flatten 走独立 try/catch：rename 冲突（EINVAL/EEXIST/ENOTEMPTY）、
//   EPERM、EACCES 都必须静默吞掉，返回 { flattened:false }。成功终态绝不能
//   因拍平失败变成 failed。
// - 不动 job.outputDir：拍平后 outputDir 仍然是用户看到的「解压目标」，
//   只是内容少了一层壳。前端只根据 flattened/flattenNote 切文案。
// - 仅在「唯一可见条目是一个目录」时触发；唯一文件、多目录、目录名不同
//   都不动。
// - 大小写不敏感比较：归档内目录项与文件名主干大小写可能不同，忽略大小写
//   更贴近用户预期。
// - fsModule 可注入，便于单测在不真动文件的前提下驱动所有分支。
function flattenSingleRootDirectory(job, options = {}) {
  const fsModule = options.fsModule || fs;
  const result = { flattened: false, flattenNote: "" };
  if (!job || !job.outputDir) {
    return result;
  }
  const stem = String(job.outputStem || "").trim();
  if (!stem) {
    return result;
  }
  try {
    const entries = fsModule.readdirSync(job.outputDir, { withFileTypes: true });
    const visible = entries.filter((entry) => !entry.name.startsWith("."));
    if (visible.length !== 1) {
      return result;
    }
    const sole = visible[0];
    const isDir = typeof sole.isDirectory === "function"
      ? sole.isDirectory()
      : false;
    if (!isDir) {
      return result;
    }
    if (sole.name.toLowerCase() !== stem.toLowerCase()) {
      return result;
    }
    const inner = path.join(job.outputDir, sole.name);
    const innerEntries = fsModule.readdirSync(inner);
    for (const name of innerEntries) {
      fsModule.renameSync(
        path.join(inner, name),
        path.join(job.outputDir, name),
      );
    }
    fsModule.rmdirSync(inner);
    result.flattened = true;
    result.flattenNote = `已拍平同名一层目录：${sole.name}`;
    return result;
  } catch (error) {
    // 任何失败（rename 冲突 / EPERM / 目录已被并发改动）都静默吞掉：
    // 拍平只是 UX 优化，绝不能让 success 变 failed。
    return { flattened: false, flattenNote: "" };
  }
}

// F6：从 `7z t` 的输出里抓坏文件归因行。
//
// 7-Zip 校验失败时对每个坏文件各打一行（通常在 stderr，与 stdout 合并进 log）：
//   ERROR: Data Error : path/to/file.bin        —— 数据块解不出来
//   ERROR: CRC Failed : path/to/file.bin        —— 解出来了但 CRC 对不上
// 行首的 "ERROR: " 前缀与冒号两侧空白都可能随版本微调，正则只锚定
// "Data Error"/"CRC Failed" 关键字（大小写不敏感），路径取到行尾。
//
// 诚实性红线：`7z t` 的输出**不标卷号**——多分卷包里它只说哪个内部文件坏了，
// 不说坏在第几卷。因此调用方文案只能说「疑似」，绝不能假装能归因到分卷。
//
// 返回去重后的内部路径数组；一行都抓不到时返回空数组（调用方回落通用文案）。
function extractTestFailures(log) {
  const pattern = /(?:Data Error|CRC Failed)\s*:\s*([^\r\n]+)/gi;
  const found = [];
  const seen = new Set();
  const text = String(log || "");
  let match;
  while ((match = pattern.exec(text))) {
    const target = match[1].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      found.push(target);
    }
  }
  return found;
}

// F6：test 任务失败时的错误包装。DAMAGED（CRC/数据错误）且能抓到归因行时，
// 把坏文件清单折进 message——这是用户在任务中心唯一能看到的文本。
// 文案刻意写「疑似」：7z t 不标卷号，多分卷场景下无法指出坏在哪一卷。
function wrapTestError(error) {
  if (!error || error.code !== "DAMAGED") {
    return error;
  }
  const failures = extractTestFailures(error.log);
  if (!failures.length) {
    return error;
  }
  const shown = failures.slice(0, 5);
  const more = failures.length > shown.length
    ? ` 等 ${failures.length} 个文件`
    : "";
  const wrapped = new Error(
    `完整性校验失败，疑似损坏的文件：${shown.join("、")}${more}。`
    + "压缩包数据已损坏，请重新获取完整副本后重试。",
  );
  wrapped.code = error.code;
  wrapped.exitCode = error.exitCode;
  wrapped.signal = error.signal;
  wrapped.log = error.log;
  return wrapped;
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

// 启动前段失败时的终态落盘。
//
// worker 是 `spawn(..., { detached: true, stdio: "ignore" })` 起的：异常信息
// 传不回父进程，父进程只靠退出码判断成败。如果这里不写终态，任务会永远停在
// queued —— 前端每秒轮询 status 永远等不到结果，界面上表现为「任务已排队」卡死。
function markStartupFailure(store, jobId, error) {
  try {
    store.update(jobId, (current) => ({
      ...current,
      status: "failed",
      phase: "failed",
      processGroupPid: null,
      workerPid: null,
      currentFile: "",
      passwordFile: "",
      selectionFile: "",
      finishedAt: new Date().toISOString(),
      error: {
        code: error?.code || "WORKER_START",
        message: error?.message || "Worker 启动失败",
      },
    }));
  } catch (updateError) {
    // 任务可能已被并发清理（过期清理 / 用户清空历史），此时没有可写的终态。
  }
}

async function runWorker(jobId, options = {}) {
  const runtimeRoot = options.runtimeRoot
    || options.store?.runtimeRoot
    || process.env.CHZIP_RUNTIME_ROOT;
  const store = options.store || new JobStore(runtimeRoot);
  const runPhase = options.runPhase || defaultRunPhase;
  const validateListing = options.validateListing || defaultValidateListing;
  // 删除函数可注入，供单测制造「某一步删除失败」的场景。
  const remove = options.remove || fs.rmSync;
  const logger = options.logger || createDiagnosticLogger({
    rootDirs: [
      process.env.TRIM_PKGVAR
        ? path.join(process.env.TRIM_PKGVAR, "logs")
        : "",
      path.join(runtimeRoot, "logs"),
    ].filter(Boolean),
  });

  // 启动前段（读任务 / 取密码 / 开源文件 fd）必须单独包一层 try：
  // 这里的异常发生在下面的状态机之外，不落终态就会让任务永久卡在 queued。
  let job;
  let password = "";
  let sourceDescriptors = [];
  let nestedDir = "";
  try {
    job = store.read(jobId);
    if (!job) {
      throw new Error("任务不存在或已过期");
    }
    password = readAndRemoveSecret(job.passwordFile);
    nestedDir = path.join(store.dataDir(jobId), "nested");
    sourceDescriptors = openSourceDescriptors(job.sourceFingerprint);
  } catch (startupError) {
    markStartupFailure(store, jobId, startupError);
    throw startupError;
  }

  const tool = {
    path: job.sevenZipPath,
    source: job.sevenZipSource,
  };

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

    // F6 完整性体检：kind=test 走最小路径——指纹校验后只跑一个 `7z t` phase
    // 就出终态。跳过嵌套 tar 预解（体检目标是压缩包本身）、validateListing
    // （不校验落盘路径安全性，因为根本不写盘）、cleanupOutput/rescue（没有
    // 输出目录，cleanupOutput 的 outputOwned/outputDir 双守卫本来也是空转）。
    if ((job.kind || "extract") === "test") {
      const testArgs = buildTestArgs(job.selection, {
        archivePath: job.archivePath,
        password,
        codePage: job.codePage,
      });
      await runPhase("testing", {
        args: testArgs,
        job,
        store,
        tool,
        passwordProvided: Boolean(password),
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
          finishedAt: new Date().toISOString(),
          error: null,
        };
      });
      safeDiagnosticWrite(logger, {
        event: "worker",
        status: "success",
        requestId: job.requestId || "",
        jobId,
        kind: "test",
      });
      return store.read(jobId);
    }

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
      // F1：正式解压应用用户选择的冲突策略；旧 job JSON 没有该字段时
      // normalizeConflictPolicy(undefined) 回落 rename，与以前行为一致。
      conflictPolicy: job.conflictPolicy,
    });
    const extractResult = await runPhase("extracting", {
      args: extractArgs,
      job,
      store,
      tool,
      passwordProvided: Boolean(extractionPassword),
    });

    // F2 智能拍平：必须在落 success 终态**之前**尝试，把结果（flattened /
    // flattenNote）并入同一次 store.update。flatten 内部失败已在其自带
    // try/catch 里吞掉，这里拿到的只是 {flattened:false}，不影响终态本身。
    const flattenResult = flattenSingleRootDirectory(job, { fsModule: fs });
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
        finishedAt: new Date().toISOString(),
        error: null,
        flattened: Boolean(flattenResult.flattened),
        flattenNote: flattenResult.flattenNote || "",
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
    // F6：test 任务的 DAMAGED 错误先包一层归因文案（疑似坏文件清单）。
    // 非 test / 非 DAMAGED 原样透传，行为与以前一致。
    if ((job.kind || "extract") === "test") {
      error = wrapTestError(error);
    }
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
    // F8：PARTIAL_KEEP_CODES 全部保留 outputDir（不再只 FILE_NAME_TOO_LONG）。
    // 限定条件：extract kind（test 无产出）+ 非取消 + 错误码在集合内。
    const isExtractKind = (job.kind || "extract") === "extract";
    const keepPartial = !cancelled
      && isExtractKind
      && PARTIAL_KEEP_CODES.has(error.code);
    if (!keepPartial) {
      cleanupOutput(job);
    }
    const finalOk = Boolean(rescuedNote) && !cancelled;
    // partialSuccess 仅在「failed 且保留了部分成果」时落 true：
    // - cancelled 永不保留（用户主动停止，已清干净）；
    // - finalOk（救援成功→success）不算部分成果，整体已成功；
    // - test kind 不进入此逻辑（isExtractKind 已过滤）。
    const partialSuccess = !cancelled && !finalOk && keepPartial;
    store.update(jobId, (current) => ({
      ...current,
      status: cancelled ? "cancelled" : finalOk ? "success" : "failed",
      phase: cancelled ? "cancelled" : finalOk ? "complete" : "failed",
      processGroupPid: null,
      currentFile: "",
      progress: finalOk ? 100 : current.progress,
      finishedAt: new Date().toISOString(),
      partialSuccess,
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
    cleanupJobArtifacts(jobId, { store, nestedDir, remove });
  }

  return store.read(jobId);
}

module.exports = {
  cleanupJobArtifacts,
  createProgressWriter,
  defaultRunPhase,
  defaultValidateListing,
  extractTestFailures,
  flattenSingleRootDirectory,
  markStartupFailure,
  registerProcessGroup,
  runWorker,
  wrapTestError,
};
