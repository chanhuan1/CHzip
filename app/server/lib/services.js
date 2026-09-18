"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { LIMITS, PERMISSIONS, TIMEOUTS } = require("./constants");
const { inspectArchive } = require("./archive-service");
const {
  findSevenZip,
  runSevenZipSync,
} = require("./engine");
const {
  JobStore,
  requestCancellation,
  TERMINAL_STATUSES,
} = require("./jobs");
const {
  createAuthorizedDirectory,
  createUniqueOutputDir,
  discoverAuthorizedRoots,
  getDirectoryCapabilities,
  isPathInside,
  listAuthorizedDirectory,
  resolveAuthorizedDirectory,
} = require("./paths");
const {
  findNestedTar,
  innerTarSelection,
  isNestedTar,
} = require("./nested");
const {
  detectTechnicalListFormat,
  detectTechnicalListProperties,
  parseTechnicalList,
} = require("./preview");
const {
  validateSelectedPaths,
  writeSelectionFile,
} = require("./selection");
const {
  buildCommentArgs,
  buildExtractArgs,
  buildListArgs,
  buildReadCommentArgs,
  buildStdoutExtractArgs,
} = require("./sevenzip");
const {
  fingerprintFiles,
} = require("./source");
const {
  createDiagnosticLogger,
  redactDiagnosticValue,
} = require("./diagnostics");
const {
  inspectSourceFile,
} = require("./source-access");
const {
  overwriteFileSync,
} = require("./fs-utils");
const {
  createDiagnosticService,
  getPackageVersion,
} = require("./diagnostic-service");

function defaultRuntimeRoot() {
  const candidates = [
    process.env.TRIM_PKGTMP,
    process.env.TRIM_PKGVAR,
    path.join(os.tmpdir(), "CHzip"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch (error) {
      // Try the next runtime directory.
    }
  }
  throw new Error("无法创建 CHzip 运行目录");
}

function requireTool(findTool) {
  const tool = findTool();
  if (!tool) {
    throw new Error("未找到内置或系统 7-Zip 解压引擎");
  }
  return tool;
}

// 对外的任务视图：只暴露前端真正消费的字段。
// 原始 job 还带 log（最大 64KB）、sourceFingerprint、selectionFile、
// passwordFile（绝对路径）等内部状态，status 每秒轮询一次，全量回传既浪费
// 带宽/序列化开销，也会把内部路径泄露给前端。
function toJobView(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase || "",
    progress: job.progress || 0,
    currentFile: job.currentFile || "",
    archivePath: job.archivePath || "",
    archiveName: job.archivePath ? path.basename(job.archivePath) : "",
    outputDir: job.outputDir || "",
    partCount: job.partCount || 1,
    requestId: job.requestId || "",
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
    createdAt: job.createdAt || "",
    error: job.error
      ? { code: job.error.code || "", message: job.error.message || "" }
      : null,
  };
}

function createServices(options = {}) {
  const runtimeRoot = options.runtimeRoot || defaultRuntimeRoot();
  const store = options.store || new JobStore(runtimeRoot);
  const findTool = options.findTool || findSevenZip;
  const runSync = options.runSync || runSevenZipSync;
  const discoverRoots = options.discoverRoots || discoverAuthorizedRoots;
  const getCapabilities = options.getDirectoryCapabilities
    || getDirectoryCapabilities;
  const inspectSource = options.inspectSource || inspectSourceFile;
  const logger = options.logger || createDiagnosticLogger({
    rootDirs: options.logRoot
      ? [options.logRoot]
      : [
        process.env.TRIM_PKGVAR
          ? path.join(process.env.TRIM_PKGVAR, "logs")
          : "",
        path.join(runtimeRoot, "logs"),
      ].filter(Boolean),
  });
  const maxNestedPreviewBytes = options.maxNestedPreviewBytes
    || LIMITS.MAX_NESTED_PREVIEW_BYTES;
  const maxPreviewFileBytes = options.maxPreviewFileBytes
    || LIMITS.MAX_PREVIEW_FILE_BYTES;
  const previewFileTimeoutMs = options.previewFileTimeoutMs
    || TIMEOUTS.PREVIEW_FILE_MS;
  const spawnWorker = options.spawnWorker || ((jobId) => {
    const apiPath = path.resolve(__dirname, "..", "api.js");
    const child = spawn(process.execPath, [apiPath, "--worker", jobId], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CHZIP_RUNTIME_ROOT: runtimeRoot,
      },
      windowsHide: true,
    });
    child.unref();
    return child;
  });
  function withPreparedArchive(archive, input, callback) {
    if (!isNestedTar(archive.selection)) {
      return callback(archive);
    }

    const preparationDir = fs.mkdtempSync(
      path.join(runtimeRoot, "nested-"),
      { encoding: "utf8" },
    );
    try {
      const outerList = runSync(archive.tool, buildListArgs(archive.selection, {
        archivePath: archive.filePath,
        password: input.password || "",
        codePage: input.codePage || "auto",
      }), {
        cwd: archive.directory,
        maxBuffer: LIMITS.MAX_PREVIEW_OUTPUT_BYTES,
      });
      const outerPreview = parseTechnicalList(outerList.stdout);
      const nestedSize = outerPreview.summary.totalSize;
      let availableBytes = Number.POSITIVE_INFINITY;
      if (typeof fs.statfsSync === "function") {
        const statfs = fs.statfsSync(preparationDir);
        availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
      }
      if (
        nestedSize > maxNestedPreviewBytes
        || nestedSize > availableBytes * LIMITS.MAX_NESTED_DISK_USAGE_RATIO
      ) {
        const error = new Error("内部 TAR 归档过大，预览已降级为整包解压");
        error.code = "PREVIEW_LIMIT";
        throw error;
      }
      runSync(archive.tool, buildExtractArgs(archive.selection, {
        archivePath: archive.filePath,
        outputDir: preparationDir,
        selectionFile: "",
        password: input.password || "",
        codePage: input.codePage || "auto",
      }), {
        cwd: archive.directory,
      });
      const innerPath = findNestedTar(preparationDir);
      return callback({
        ...archive,
        filePath: innerPath,
        directory: path.dirname(innerPath),
        selection: innerTarSelection(),
      });
    } finally {
      try {
        fs.rmSync(preparationDir, { recursive: true, force: true });
      } catch (cleanupError) {
        safeDiagnosticWrite(logger, {
          event: "cleanup_error",
          path: preparationDir,
          error: cleanupError.message,
        });
      }
    }
  }

  function info(input) {
    const tool = requireTool(findTool);
    return inspectArchive(input.path, { sevenZip: tool, inspectSource });
  }

  // providedArchive：调用方（extract）已经解析过同一个压缩包时可以直接传入，
  // 避免 inspectArchive 在同一请求内跑两遍（分卷多时这一遍是逐级 stat 的
  // 重活，见 archive-service.inspectArchive → source-access.inspectSourceFile）。
  function preview(input, providedArchive = null) {
    const archive = providedArchive || info(input);
    if (archive.missingParts.length) {
      const error = new Error(archive.warnings[0]);
      error.code = "MISSING_VOLUME";
      throw error;
    }
    return withPreparedArchive(archive, input, (listingArchive) => {
      let result = runSync(listingArchive.tool, buildListArgs(
        listingArchive.selection,
        {
          archivePath: listingArchive.filePath,
          password: input.password || "",
          codePage: input.codePage || "auto",
        },
      ), {
        cwd: listingArchive.directory,
        maxBuffer: LIMITS.MAX_PREVIEW_OUTPUT_BYTES,
        phase: "preview",
        passwordProvided: Boolean(input.password),
      });
      let effectiveSelection = listingArchive.selection;
      let detectedFormat = detectTechnicalListFormat(result.stdout);
      if (!effectiveSelection.format && detectedFormat) {
        effectiveSelection = {
          ...effectiveSelection,
          format: detectedFormat,
        };
        if ((input.codePage || "auto") !== "auto") {
          result = runSync(listingArchive.tool, buildListArgs(effectiveSelection, {
            archivePath: listingArchive.filePath,
            password: input.password || "",
            codePage: input.codePage || "auto",
          }), {
            cwd: listingArchive.directory,
            maxBuffer: LIMITS.MAX_PREVIEW_OUTPUT_BYTES,
            phase: "preview",
            passwordProvided: Boolean(input.password),
          });
          detectedFormat = detectTechnicalListFormat(result.stdout);
        }
      }
      const parsed = parseTechnicalList(result.stdout);
      const passwordRequired = Boolean(parsed.summary.encrypted);
      // 固实标记随列表一起返回：前端据此在预览单文件前给出预警。
      // 固实包取出任一文件都要先解压整包，是"预览小文件却跑满一个核"的根因。
      const properties = detectTechnicalListProperties(result.stdout);
      return {
        ...parsed,
        format: detectedFormat || effectiveSelection.format,
        type: effectiveSelection.type,
        parts: archive.parts,
        passwordRequired,
        passwordVerified: passwordRequired
          ? Boolean(input.password)
          : true,
        solid: properties.solid,
      };
    });
  }

  function directories(input) {
    const archive = inspectArchive(input.archivePath, {
      sevenZip: requireTool(findTool),
    });
    const roots = discoverRoots(archive.filePath);
    if (!input.path) {
      const matchingRoot = roots
        .filter((root) => isPathInside(root.path || root, archive.directory))
        .sort((a, b) => (b.path || b).length - (a.path || a).length)[0];
      const fallbackRoot = roots.find((root) => root.canSelect ?? true);
      let archiveDirectorySelectable = false;
      try {
        archiveDirectorySelectable = getCapabilities(archive.directory).canSelect;
      } catch (error) {
        archiveDirectorySelectable = false;
      }
      return {
        roots,
        defaultPath: matchingRoot && archiveDirectorySelectable
          ? archive.directory
          : (fallbackRoot?.path || fallbackRoot || ""),
        path: "",
        children: [],
      };
    }
    return {
      roots,
      ...listAuthorizedDirectory(input.path, roots),
    };
  }

  function createDirectory(input) {
    const archive = inspectArchive(input.archivePath, {
      sevenZip: requireTool(findTool),
    });
    return createAuthorizedDirectory(
      input.parentPath,
      input.name,
      discoverRoots(archive.filePath),
    );
  }

  function extract(input) {
    const archive = info(input);
    if (archive.missingParts.length) {
      const error = new Error(archive.warnings[0]);
      error.code = "MISSING_VOLUME";
      throw error;
    }

    let previewResult = null;
    if (Array.isArray(input.selectedPaths)) {
      // 复用上面已经解析好的 archive，别再 inspectArchive 一遍。
      previewResult = preview(input, archive);
    }

    const roots = discoverRoots(archive.filePath);
    const destinationRoot = resolveAuthorizedDirectory(
      input.destinationRoot || archive.directory,
      roots,
    );
    const outputDir = createUniqueOutputDir(destinationRoot, archive.outputStem);
    let job;

    try {
      const jobSelection = isNestedTar(archive.selection)
        ? archive.selection
        : {
          ...archive.selection,
          format: previewResult?.format
            || archive.selection.format,
          type: previewResult?.type
            ?? archive.selection.type,
        };
      job = store.create({
        requestId: input.requestId || "",
        archivePath: archive.filePath,
        outputDir,
        outputOwned: true,
        selection: jobSelection,
        sevenZipPath: archive.tool.path,
        sevenZipSource: archive.tool.source,
        codePage: input.codePage || "auto",
        partCount: archive.partCount,
        // info() 已对每卷跑过 realpath+stat（结果在 archive.sources 的
        // .stat 上），直接复用构造指纹；只对没有 stat 的退化路径才
        // 回退 fingerprintFiles（单文件且无 sources 时）。
        sourceFingerprint: (archive.sources && archive.sources.length
          ? archive.sources
          : [{ path: archive.filePath, stat: null }]).map((source) => (
          source.stat
            ? {
              path: source.path,
              dev: source.stat.dev,
              ino: source.stat.ino,
              size: source.stat.size,
              mtimeMs: source.stat.mtimeMs,
            }
            : fingerprintFiles([source.path])[0])),
      });

      let selectionFile = "";
      if (Array.isArray(input.selectedPaths)) {
        const selectedPaths = validateSelectedPaths(
          input.selectedPaths,
          previewResult.entries,
        );
        selectionFile = writeSelectionFile(store.dataDir(job.id), selectedPaths);
      }

      let passwordFile = "";
      if (input.password) {
        passwordFile = path.join(store.dataDir(job.id), "password.txt");
        fs.writeFileSync(passwordFile, input.password, {
          encoding: "utf8",
          mode: PERMISSIONS.MODE_FILE_SECRET,
        });
      }

      job = store.update(job.id, (current) => ({
        ...current,
        selectionFile,
        passwordFile,
      }));

      const worker = spawnWorker(job.id);
      job = store.update(job.id, (current) => ({
        ...current,
        workerPid: worker.pid || null,
      }));
      const failWorker = (workerError, code) => {
        const current = store.read(job.id);
        if (!current || TERMINAL_STATUSES.has(current.status)) {
          return;
        }
        if (current.passwordFile) {
          overwriteFileSync(current.passwordFile);
        }
        for (const filePath of [current.passwordFile, current.selectionFile]) {
          if (filePath) {
            fs.rmSync(filePath, { force: true });
          }
        }
        if (current.outputOwned && current.outputDir) {
          fs.rmSync(current.outputDir, { recursive: true, force: true });
        }
        store.update(job.id, (latest) => ({
          ...latest,
          status: "failed",
          phase: "failed",
          passwordFile: "",
          selectionFile: "",
          workerPid: null,
          finishedAt: new Date().toISOString(),
          error: {
            code,
            message: workerError.message || "Worker 运行失败",
          },
        }));
      };
      if (typeof worker.once === "function") {
        worker.once("error", (workerError) => {
          failWorker(workerError, "WORKER_START");
        });
        worker.once("exit", (exitCode, signal) => {
          if (exitCode !== 0) {
            failWorker(
              new Error(
                `Worker 异常退出${signal ? `（${signal}）` : `（${exitCode}）`}`,
              ),
              "WORKER_EXIT",
            );
          }
        });
      }

      return {
        jobId: job.id,
        outputDir: job.outputDir,
        partCount: job.partCount,
      };
    } catch (error) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      if (job) {
        const current = store.read(job.id);
        if (current?.passwordFile) {
          overwriteFileSync(current.passwordFile);
        }
        for (const filePath of [current?.passwordFile, current?.selectionFile]) {
          if (filePath) {
            fs.rmSync(filePath, { force: true });
          }
        }
        store.update(job.id, (current) => ({
          ...current,
          status: "failed",
          passwordFile: "",
          selectionFile: "",
          error: {
            code: error.code || "START_FAILED",
            message: error.message,
          },
          finishedAt: new Date().toISOString(),
        }));
      }
      throw error;
    }
  }

  function status(input) {
    const job = store.read(input.jobId);
    if (!job) {
      throw new Error("任务不存在或已过期");
    }
    return toJobView(job);
  }

  async function cancel(input) {
    return requestCancellation(store, input.jobId, options.cancellationDependencies);
  }

  const diagnosticService = createDiagnosticService({
    runtimeRoot,
    findTool,
    discoverRoots,
    inspectSource,
    logger,
  });

  function diagnostics(input) {
    return diagnosticService.diagnostics(input);
  }

  function comment(input) {
    const archive = info(input);
    if (input.comment !== undefined) {
      const commentDir = fs.mkdtempSync(path.join(runtimeRoot, "comment-"));
      const commentFile = path.join(commentDir, "comment.txt");
      fs.writeFileSync(commentFile, input.comment, { encoding: "utf8", mode: 0o600 });
      try {
        runSync(archive.tool, buildCommentArgs(archive.selection, {
          archivePath: archive.filePath,
          commentFile,
        }), {
          cwd: archive.directory,
        });
      } finally {
        fs.rmSync(commentDir, { recursive: true, force: true });
      }
      return { success: true };
    }
    const listResult = runSync(archive.tool, buildReadCommentArgs(archive.selection, {
      archivePath: archive.filePath,
    }), {
      cwd: archive.directory,
      maxBuffer: 8 * 1024 * 1024,
    });
    const commentMatch = listResult.stdout.match(/Comment\s*=\s*([\s\S]*?)(?=\n\s*\n|\n[A-Z]|\s*$)/i);
    return { comment: commentMatch ? commentMatch[1].trim() : "" };
  }

  function listJobs() {
    // 历史只保留最近 20 条，超出自动清除最旧（环形覆盖）。
    // listAndTrimHistory 在**一次**目录遍历里同时完成「溢出修剪」与「列出」，
    // 取代原先 removeFinishedOverflow() + list() 各扫一遍目录的做法。
    const { jobs } = store.listAndTrimHistory(20);
    const active = [];
    const history = [];
    for (const job of jobs) {
      const item = toJobView(job);
      if (TERMINAL_STATUSES.has(job.status)) {
        history.push(item);
      } else {
        active.push(item);
      }
    }
    return { active, history: history.slice(0, 20) };
  }

  // 手动清空解压历史：仅移除已结束任务的记录，进行中的任务与
  // 已解压的文件都不受影响。
  function clearHistory() {
    const removed = store.removeAllFinished();
    return { removed: removed.length };
  }

  async function previewFile(input) {
    const archive = info(input);
    const targetPath = input.targetPath;
    if (!targetPath) {
      throw new Error("未指定预览文件路径");
    }
    const previewDir = fs.mkdtempSync(path.join(runtimeRoot, "preview-"));
    const selectionFile = path.join(previewDir, "selection.txt");
    fs.writeFileSync(selectionFile, targetPath, { encoding: "utf8", mode: 0o600 });
    try {
      // 走 runSync（= runSevenZipSync）而不是裸 spawnSync：自动带上超时与
      // 统一的错误分类。此前这里直接调 spawnSync，唯一原因是要 encoding:null
      // 拿二进制（图片预览），代价是把超时一起漏掉了 —— 固实（solid）压缩包
      // 取出单个文件必须解压整包，没有超时就会一直占满一个核。
      // 现在 runSevenZipSync 支持 encoding 选项，两者可以兼得。
      let result;
      try {
        result = runSync(archive.tool, buildStdoutExtractArgs(archive.selection, {
          archivePath: archive.filePath,
          password: input.password || "",
          codePage: input.codePage || "auto",
          selectionFile,
        }), {
          cwd: archive.directory,
          maxBuffer: maxPreviewFileBytes,
          encoding: null,
          timeout: previewFileTimeoutMs,
          // 超时后必须真的把 7z 杀掉，否则它会在后台继续烧 CPU。
          killSignal: "SIGKILL",
        });
      } catch (previewError) {
        // spawnSync 超时会给出 ETIMEDOUT（此时子进程已按 killSignal 被杀）。
        if (previewError.code === "ETIMEDOUT") {
          // 秒数格式化：45s 显示「45 秒」；不足 10s 保留一位小数，
          // 免得短超时（如单测里的 300ms）在文案里显示成「0 秒」。
          const timeoutSeconds = previewFileTimeoutMs / 1000;
          const secondsText = timeoutSeconds >= 10
            ? String(Math.round(timeoutSeconds))
            : String(Math.round(timeoutSeconds * 10) / 10);
          const error = new Error(
            `预览该文件已超过 ${secondsText} 秒，已中止：此压缩包很可能是固实（solid）压缩，`
            + "取出其中任一文件都需先解压整个包，耗时与压缩包体积成正比（与目标文件大小无关）。"
            + "建议直接解压后再查看。",
          );
          error.code = "PREVIEW_TIMEOUT";
          throw error;
        }
        // maxBuffer 触顶时 runSevenZipSync 转成 PREVIEW_LIMIT；
        // 这里换成更具体的 PREVIEW_TOO_LARGE，前端才能提示"文件太大"。
        if (previewError.code === "PREVIEW_LIMIT") {
          const limitMiB = Math.round(maxPreviewFileBytes / 1024 / 1024);
          const error = new Error(`文件超过预览上限（${limitMiB} MiB），无法预览`);
          error.code = "PREVIEW_TOO_LARGE";
          throw error;
        }
        throw previewError;
      }
      // runSevenZipSync 在 encoding:null 下回传 Buffer；这里加一层防御，
      // 万一将来有人改成 utf8，也不会静默产出内容错误的预览。
      const output = Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(String(result.stdout || ""), "utf8");
      const isImage = /\.(png|jpe?g|gif|bmp|webp|ico|tiff?)$/i.test(targetPath);
      if (isImage) {
        return {
          content: output.toString("base64"),
          fileName: path.basename(targetPath),
          encoding: "base64",
        };
      }
      return {
        content: output.toString("utf8"),
        fileName: path.basename(targetPath),
        encoding: "utf8",
      };
    } finally {
      fs.rmSync(previewDir, { recursive: true, force: true });
    }
  }

  return {
    cancel,
    clearHistory,
    comment,
    createDirectory,
    diagnostics,
    directories,
    extract,
    info,
    listJobs,
    preview,
    previewFile,
    status,
    store,
    logger,
  };
}

module.exports = {
  createServices,
  defaultRuntimeRoot,
};
