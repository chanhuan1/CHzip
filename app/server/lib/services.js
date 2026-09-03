"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { LIMITS, PERMISSIONS } = require("./constants");
const { inspectArchive } = require("./archive-service");
const {
  findSevenZip,
  runSevenZipSync,
  runSevenZipValidateSync,
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

function createServices(options = {}) {
  const runtimeRoot = options.runtimeRoot || defaultRuntimeRoot();
  const store = options.store || new JobStore(runtimeRoot);
  const findTool = options.findTool || findSevenZip;
  const runSync = options.runSync || runSevenZipSync;
  const validateListing = options.validateListing || runSevenZipValidateSync;
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

  const validateArchive = options.validateArchive || ((archive, input) => {
    return withPreparedArchive(archive, input, (listingArchive) => {
      let effectiveSelection = listingArchive.selection;
      let args = buildListArgs(effectiveSelection, {
        archivePath: listingArchive.filePath,
        password: input.password || "",
        codePage: input.codePage || "auto",
      });
      let validation = validateListing(listingArchive.tool, args, {
        cwd: listingArchive.directory,
      });
      if (!effectiveSelection.format && validation.format) {
        effectiveSelection = {
          ...effectiveSelection,
          format: validation.format,
        };
        if ((input.codePage || "auto") !== "auto") {
          args = buildListArgs(effectiveSelection, {
            archivePath: listingArchive.filePath,
            password: input.password || "",
            codePage: input.codePage || "auto",
          });
          validation = validateListing(listingArchive.tool, args, {
            cwd: listingArchive.directory,
          });
        }
      }
      return {
        format: effectiveSelection.format,
        type: effectiveSelection.type,
        entryCount: validation.entryCount,
      };
    });
  });

  function info(input) {
    const tool = requireTool(findTool);
    return inspectArchive(input.path, { sevenZip: tool });
  }

  function preview(input) {
    const archive = info(input);
    if (archive.missingParts.length) {
      const error = new Error(archive.warnings[0]);
      error.code = "MISSING_VOLUME";
      throw error;
    }
    const args = buildListArgs(archive.selection, {
      archivePath: archive.filePath,
      password: input.password || "",
      codePage: input.codePage || "auto",
    });
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
      return {
        ...parsed,
        format: detectedFormat || effectiveSelection.format,
        type: effectiveSelection.type,
        parts: archive.parts,
        passwordRequired,
        passwordVerified: passwordRequired
          ? Boolean(input.password)
          : true,
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
      previewResult = preview(input);
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
        sourceFingerprint: fingerprintFiles(
          (archive.parts.length ? archive.parts : [{ path: archive.filePath }])
            .map((part) => part.path),
        ),
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
    return job;
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
    const jobs = store.list();
    const active = [];
    const recent = [];
    for (const job of jobs) {
      const item = {
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
      (TERMINAL_STATUSES.has(job.status) ? recent : active).push(item);
    }
    return { active, recent: recent.slice(0, 10) };
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
      const result = spawnSync(archive.tool, buildStdoutExtractArgs(archive.selection, {
        archivePath: archive.filePath,
        password: input.password || "",
        codePage: input.codePage || "auto",
        selectionFile,
      }), {
        cwd: archive.directory,
        maxBuffer: LIMITS.MAX_PREVIEW_OUTPUT_BYTES,
        encoding: null,
      });
      if (result.status !== 0) {
        const error = new Error(String(result.stderr || "预览文件失败"));
        error.code = "PREVIEW_FAILED";
        throw error;
      }
      const output = result.stdout || Buffer.alloc(0);
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
