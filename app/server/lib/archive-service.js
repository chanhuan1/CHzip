"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyArchive,
  collectVolumeNames,
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
  const selection = classifyArchive(selectedRealPath);
  if (!selection) {
    throw new Error("当前文件类型不支持");
  }

  const directory = path.dirname(selectedRealPath);
  const firstVolumePath = path.join(directory, selection.firstVolumeName);
  const firstSource = selectedRealPath === firstVolumePath
    ? selectedSource
    : inspectSource(firstVolumePath);
  const archivePath = firstSource.path;
  let directoryNames;
  try {
    directoryNames = fsModule.readdirSync(directory);
  } catch (error) {
    throw classifySourceError(error, directory, "parent");
  }
  const volumeInfo = collectVolumeNames(selection, directoryNames);
  const volumePaths = volumeInfo.names.map((name) => path.join(directory, name));
  const volumeSources = volumePaths.map((filePath) => (
    filePath === archivePath ? firstSource : inspectSource(filePath)
  ));
  const missingParts = volumeInfo.missingParts;
  // F12：分卷缺失引导卡需要的结构化信息。此前 missingTotal/missingTruncated
  // 只折进 warnings 文案，前端拿不到；kind/seriesStem/partWidth 是前端按四种
  // 命名规则（.001/.z01/.partN.rar/.rNN）还原缺失文件名所必需的。
  const missingDetails = missingParts.length
    ? {
      missingParts,
      missingTotal: volumeInfo.missingTotal,
      missingTruncated: volumeInfo.missingTruncated,
      kind: selection.kind,
      seriesStem: selection.seriesStem || selection.outputStem,
      partWidth: selection.partWidth || 2,
      firstVolumeName: volumeInfo.firstVolumeName || selection.firstVolumeName,
      format: selection.format || "",
    }
    : null;
  const warnings = [];
  if (missingParts.length) {
    // 缺失枚举有上界（见 archive.js 的 MAX_MISSING_ENUM / MAX_VOLUME_NUMBER）：
    // 被截断时改报总数，避免把上百个分卷号整串拼进响应。
    warnings.push(volumeInfo.missingTruncated
      ? `检测到分卷缺失：至少 ${volumeInfo.missingTotal} 个（前 ${missingParts.length} 个：${missingParts.join(", ")}…）`
      : `检测到分卷缺失：${missingParts.join(", ")}`);
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
    missingTotal: volumeInfo.missingTotal,
    missingTruncated: volumeInfo.missingTruncated,
    missingDetails,
    warnings,
    tool: options.sevenZip || null,
  };
}

module.exports = {
  inspectArchive,
};
