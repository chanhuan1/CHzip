"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyArchive,
  collectVolumeNames,
  createDetectedSelection,
  detectArchiveFormatByHeader,
} = require("./archive");
const {
  classifySourceError,
  inspectSourceFile,
} = require("./source-access");

function toClientFile(source, index) {
  return {
    index,
    path: source.path,
    name: path.basename(source.path),
    size: source.stat.size,
    modified: source.stat.mtime.toISOString(),
  };
}

const HEADER_SNIFF_BYTES = 512;
const HEADER_SNIFF_LARGE_BYTES = 64 * 1024;
const TAIL_SNIFF_BYTES = 512;

function readArchiveHeader(filePath, fsModule) {
  let fd = null;
  try {
    fd = fsModule.openSync(filePath, "r");
    const stat = fsModule.fstatSync(fd);
    const headerLength = Math.min(
      stat.size,
      HEADER_SNIFF_LARGE_BYTES,
    );
    const tailLength = Math.min(
      stat.size,
      TAIL_SNIFF_BYTES,
    );
    const header = Buffer.alloc(headerLength);
    const tail = Buffer.alloc(tailLength);
    const headerBytesRead = fsModule.readSync(
      fd,
      header,
      0,
      headerLength,
      0,
    );
    const tailBytesRead = fsModule.readSync(
      fd,
      tail,
      0,
      tailLength,
      Math.max(0, stat.size - tailLength),
    );
    return {
      head: header.subarray(0, headerBytesRead),
      tail: tail.subarray(0, tailBytesRead),
    };
  } catch (error) {
    // 文件头探测是增强能力，不能因为它失败而阻断原有后缀识别流程。
    return {
      head: Buffer.alloc(0),
      tail: Buffer.alloc(0),
    };
  } finally {
    if (fd !== null) {
      try {
        fsModule.closeSync(fd);
      } catch (error) {
        // 关闭失败没有可恢复动作，源文件可读性已由 inspectSourceFile 校验。
      }
    }
  }
}

function formatLabel(format) {
  return format === "bzip2"
    ? "BZ2"
    : String(format || "未知").toUpperCase();
}

function inspectArchive(selectedPath, options = {}) {
  if (!selectedPath || typeof selectedPath !== "string" || !path.isAbsolute(selectedPath)) {
    throw new Error("压缩包路径必须是绝对路径");
  }
  const fsModule = options.fsModule || fs;
  // 所有分卷都在同一个目录下（下面的 volumePaths 均由同一个 directory 拼出），
  // 因此祖先目录的 stat/access 校验整趟只需做一次，把结果缓存在这次调用内复用。
  const verifiedComponents = new Map();
  const inspectSource = options.inspectSource
    || ((filePath) => inspectSourceFile(filePath, {
      fsModule,
      verifiedComponents,
    }));
  const selectedSource = inspectSource(selectedPath);
  const selectedRealPath = selectedSource.path;
  const detected = detectArchiveFormatByHeader(
    readArchiveHeader(selectedRealPath, fsModule),
  );
  let selection = classifyArchive(selectedRealPath);
  if (!selection && detected) {
    selection = createDetectedSelection(selectedRealPath, detected);
  }
  if (!selection) {
    throw new Error("当前文件类型不支持");
  }
  let formatMismatch = null;
  if (detected && detected.format !== selection.format) {
    formatMismatch = {
      declaredFormat: selection.format,
      detectedFormat: detected.format,
    };
    selection = {
      ...selection,
      format: detected.format,
      type: detected.type || null,
      innerFormat: detected.innerFormat || null,
      detectedBy: "header",
    };
  }

  const directory = path.dirname(selectedRealPath);
  let directoryNames;
  try {
    directoryNames = fsModule.readdirSync(directory);
  } catch (error) {
    throw classifySourceError(error, directory, "parent");
  }
  const volumeInfo = collectVolumeNames(selection, directoryNames);
  const firstVolumePath = path.join(directory, volumeInfo.firstVolumeName);
  const firstVolumeExists = directoryNames.some(
    (name) => name.toLowerCase() === volumeInfo.firstVolumeName.toLowerCase(),
  );
  const firstSource = selectedRealPath === firstVolumePath
    ? selectedSource
    : (firstVolumeExists ? inspectSource(firstVolumePath) : null);
  const archivePath = firstSource?.path || firstVolumePath;
  const volumePaths = volumeInfo.names.map((name) => path.join(directory, name));
  const volumeSources = volumePaths.map((filePath) => (
    filePath === archivePath ? firstSource : inspectSource(filePath)
  ));
  const missingFirstVolume = !firstVolumeExists
    && (selection.kind === "zip-z" || selection.kind === "rar-old");
  const missingParts = volumeInfo.missingParts;
  const missingTotal = volumeInfo.missingTotal + (missingFirstVolume ? 1 : 0);
  const missingLabels = [
    ...(missingFirstVolume ? [volumeInfo.firstVolumeName] : []),
    ...missingParts,
  ];
  // F12：分卷缺失引导卡需要的结构化信息。此前 missingTotal/missingTruncated
  // 只折进 warnings 文案，前端拿不到；kind/seriesStem/partWidth 是前端按四种
  // 命名规则（.001/.z01/.partN.rar/.rNN）还原缺失文件名所必需的。
  const missingDetails = (missingTotal || missingFirstVolume)
    ? {
      missingParts,
      missingTotal,
      missingTruncated: volumeInfo.missingTruncated,
      kind: selection.kind,
      seriesStem: selection.seriesStem || selection.outputStem,
      partWidth: selection.partWidth || 2,
      firstVolumeName: volumeInfo.firstVolumeName || selection.firstVolumeName,
      format: selection.format || "",
      missingFirstVolume,
    }
    : null;
  const warnings = [];
  if (formatMismatch) {
    warnings.push(
      `扩展名与实际格式不一致：后缀对应 ${formatLabel(formatMismatch.declaredFormat)}`
      + `，已按 ${formatLabel(formatMismatch.detectedFormat)} 识别`,
    );
  }
  if (missingTotal) {
    // 缺失枚举有上界（见 archive.js 的 MAX_MISSING_ENUM / MAX_VOLUME_NUMBER）：
    // 被截断时改报总数，避免把上百个分卷号整串拼进响应。
    warnings.push(volumeInfo.missingTruncated
      ? `检测到分卷缺失：至少 ${missingTotal} 个（前 ${missingLabels.length} 个：${missingLabels.join(", ")}…）`
      : `检测到分卷缺失：${missingLabels.join(", ")}`);
  }

  return {
    filePath: archivePath,
    fileName: path.basename(archivePath),
    selectedFilePath: selectedRealPath,
    selectedFileName: path.basename(selectedRealPath),
    directory,
    outputStem: selection.outputStem,
    selection,
    partCount: volumePaths.length,
    parts: volumeSources.map(toClientFile),
    // sources 是 inspectSourceFile 的原始返回（含 .stat），供 extract 直接
    // 复用构造源文件指纹，避免对同一批分卷再跑一遍 realpath+stat。
    sources: volumeSources,
    missingParts,
    missingTotal,
    missingTruncated: volumeInfo.missingTruncated,
    missingDetails,
    formatMismatch,
    warnings,
    tool: options.sevenZip || null,
  };
}

module.exports = {
  inspectArchive,
};
