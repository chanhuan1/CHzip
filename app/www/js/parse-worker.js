"use strict";

function parseRecord(lines) {
  const record = {};
  for (const line of lines) {
    const separator = line.indexOf(" = ");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 3);
    record[key] = value;
  }
  return record;
}

function normalizeEntryPath(value) {
  const raw = String(value || "");
  if (!raw || /[\0\r\n]/.test(raw)) {
    throw new Error("压缩包包含格式不安全的文件名");
  }
  const normalized = raw.replace(/\\/g, "/");
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").includes("..")
  ) {
    throw new Error(`压缩包包含不安全路径：${raw}`);
  }
  return normalized.replace(/^\.\//, "");
}

function toNumber(value) {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

function normalizeTechnicalFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  return format && format !== "split" ? format : null;
}

self.onmessage = function (event) {
  const { requestId, text, maxEntries, maxBytes } = event.data;
  try {
    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > maxBytes) {
      self.postMessage({ requestId, error: "压缩包预览输出超过大小限制" });
      return;
    }
    const lines = String(text).split(/\n/);
    const separatorIndex = lines.findIndex((line) => line.trim() === "----------");
    if (separatorIndex < 0) {
      self.postMessage({
        requestId,
        result: {
          entries: [],
          summary: { fileCount: 0, directoryCount: 0, totalSize: 0, encrypted: false },
        },
      });
      return;
    }
    const records = [];
    let current = [];
    for (const line of lines.slice(separatorIndex + 1)) {
      if (line === "") {
        if (current.length) {
          records.push(parseRecord(current));
          current = [];
        }
        continue;
      }
      current.push(line);
    }
    if (current.length) {
      records.push(parseRecord(current));
    }
    if (records.length > maxEntries) {
      self.postMessage({ requestId, error: "压缩包文件数量超过预览限制" });
      return;
    }
    const entries = records
      .filter((record) => record.Path)
      .map((record) => {
        const entryPath = normalizeEntryPath(record.Path);
        const slashIndex = entryPath.lastIndexOf("/");
        const attributes = String(record.Attributes || "");
        const isDirectory = record.Folder === "+"
          || /^D(?:\s|$)/i.test(attributes);
        return {
          path: entryPath,
          name: entryPath.slice(entryPath.lastIndexOf("/") + 1),
          parentPath: slashIndex >= 0 ? entryPath.slice(0, slashIndex) : "",
          type: isDirectory ? "directory" : "file",
          size: toNumber(record.Size),
          packedSize: toNumber(record["Packed Size"]),
          modified: record.Modified || "",
          encrypted: record.Encrypted === "+",
        };
      });
    const summary = entries.reduce(
      (result, entry) => {
        if (entry.type === "directory") {
          result.directoryCount += 1;
        } else {
          result.fileCount += 1;
          result.totalSize += entry.size;
        }
        result.encrypted ||= entry.encrypted;
        return result;
      },
      { fileCount: 0, directoryCount: 0, totalSize: 0, encrypted: false },
    );
    self.postMessage({ requestId, result: { entries, summary } });
  } catch (error) {
    self.postMessage({ requestId, error: error.message });
  }
};
