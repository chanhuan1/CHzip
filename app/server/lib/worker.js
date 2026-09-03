"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  classifySevenZipError,
  parseProgress,
  spawnSevenZip,
} = require("./engine");
const { JobStore } = require("./jobs");
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

function appendJobLog(store, jobId, chunk, phase) {
  const text = chunk.toString("utf8");
  store.update(jobId, (job) => {
    const log = `${job.log || ""}${text}`.slice(-65536);
    const progress = parseProgress(log);
    return {
      ...job,
      phase,
      log,
      progress: phase === "testing"
        ? Math.min(progress.percent, 5)
        : progress.percent,
      currentFile: progress.currentFile || job.currentFile,
    };
  });
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
    const child = spawnSevenZip(context.tool, context.args, {
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
    const append = (chunk) => {
      log = `${log}${chunk.toString("utf8")}`.slice(-65536);
      appendJobLog(context.store, context.job.id, chunk, phase);
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
      clearProcessGroup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
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

function defaultValidateListing(tool, args, context) {
  return new Promise((resolve, reject) => {
    const spawnProcess = context.spawnProcess || spawn;
    const helperPath = path.join(__dirname, "listing-validator.js");
    const child = spawnProcess(process.execPath, [
      helperPath,
      tool.path,
      context.cwd || "",
      ...args,
    ], {
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

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-65536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65536);
    });
    const clearProcessGroup = () => {
      context.store.update(context.job.id, (job) => ({
        ...job,
        processGroupPid: null,
      }));
    };
    child.once("error", (error) => {
      clearProcessGroup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearProcessGroup();
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
        resolve(JSON.parse(stdout || "{}"));
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
    await runPhase("extracting", {
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
  appendJobLog,
  defaultRunPhase,
  defaultValidateListing,
  registerProcessGroup,
  runWorker,
};
