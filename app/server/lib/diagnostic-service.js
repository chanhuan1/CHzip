"use strict";

const path = require("node:path");
const {
  findSevenZip,
} = require("./engine");
const {
  discoverAuthorizedRoots,
} = require("./paths");
const {
  inspectSourceFile,
} = require("./source-access");
const {
  createDiagnosticLogger,
  redactDiagnosticValue,
} = require("./diagnostics");

let cachedVersion = null;

const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "..", "manifest");

function getPackageVersion() {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const fsModule = require("node:fs");
    const manifest = fsModule.readFileSync(MANIFEST_PATH, "utf8");
    const match = manifest.match(/^version\s*=\s*(\S+)/m);
    cachedVersion = match ? match[1] : "1.0.0";
  } catch (error) {
    cachedVersion = "1.0.0";
  }
  return cachedVersion;
}

function createDiagnosticService(options = {}) {
  const findTool = options.findTool || findSevenZip;
  const discoverRoots = options.discoverRoots || discoverAuthorizedRoots;
  const inspectSource = options.inspectSource || inspectSourceFile;
  const logger = options.logger || createDiagnosticLogger({
    rootDirs: [
      process.env.TRIM_PKGVAR
        ? path.join(process.env.TRIM_PKGVAR, "logs")
        : "",
      path.join(options.runtimeRoot || "/tmp", "logs"),
    ].filter(Boolean),
  });

  function requireTool() {
    const tool = findTool();
    if (!tool) {
      throw new Error("未找到内置或系统 7-Zip 解压引擎");
    }
    return tool;
  }

  function diagnostics(input) {
    let source = null;
    let sourceError = null;
    let roots = [];
    try {
      roots = discoverRoots(input.path);
    } catch (error) {
      roots = [];
    }
    try {
      source = inspectSource(input.path);
    } catch (error) {
      const diagnostic = error.diagnostic || {};
      const fileComponent = diagnostic.components
        ?.find((component) => component.type === "file");
      source = {
        path: error.path || input.path || "",
        readable: false,
        mode: fileComponent?.mode || "",
        uid: fileComponent?.uid ?? null,
        gid: fileComponent?.gid ?? null,
        size: null,
        modified: "",
        application: diagnostic.application || {
          uid: process.getuid?.() ?? null,
          gid: process.getgid?.() ?? null,
          groups: process.getgroups?.() || [],
        },
        components: diagnostic.components || [],
      };
      sourceError = {
        code: error.code || "SOURCE_DIAGNOSTIC_FAILED",
        message: error.message,
        errno: error.errno ?? null,
        syscall: error.syscall || "",
        path: error.path || input.path || "",
      };
    }
    let tool = null;
    try {
      tool = requireTool();
    } catch (error) {
      tool = {
        path: "",
        source: "missing",
        error: error.message,
      };
    }
    const diagnosticRequestId = /^[a-f0-9]{16}$/.test(input.requestId || "")
      ? input.requestId
      : "";
    let logTail = "";
    try {
      logTail = logger.tailForRequest(diagnosticRequestId);
    } catch (error) {
      logTail = "";
    }
    const report = {
      generatedAt: new Date().toISOString(),
      version: getPackageVersion(),
      requestId: diagnosticRequestId,
      source: {
        path: source.path,
        readable: source.readable,
        mode: source.mode,
        uid: source.uid,
        gid: source.gid,
        size: source.size,
        modified: source.modified,
        application: source.application,
        components: source.components,
      },
      sourceError,
      authorizedRoots: roots,
      engine: tool,
      runtimeRoot: options.runtimeRoot || "",
      logTail,
    };
    return redactDiagnosticValue(report);
  }

  return {
    diagnostics,
    logger,
  };
}

module.exports = {
  createDiagnosticService,
  getPackageVersion,
};
