"use strict";

const path = require("node:path");

const SINGLE_FORMATS = [
  { pattern: /\.tar\.gz$/i, format: "gzip", innerFormat: "tar" },
  { pattern: /\.tar\.bz2$/i, format: "bzip2", innerFormat: "tar" },
  { pattern: /\.tar\.xz$/i, format: "xz", innerFormat: "tar" },
  { pattern: /\.tar\.(?:zst|zstd)$/i, format: "zstd", innerFormat: "tar" },
  { pattern: /\.7z$/i, format: "7z", type: "7z" },
  { pattern: /\.zip$/i, format: "zip", type: "zip" },
  { pattern: /\.rar$/i, format: "rar", type: "rar" },
  { pattern: /\.tar$/i, format: "tar", type: "tar" },
  { pattern: /\.tgz$/i, format: "gzip", innerFormat: "tar" },
  { pattern: /\.gz$/i, format: "gzip" },
  { pattern: /\.(?:tbz|tbz2)$/i, format: "bzip2", innerFormat: "tar" },
  { pattern: /\.bz2$/i, format: "bzip2" },
  { pattern: /\.txz$/i, format: "xz", innerFormat: "tar" },
  { pattern: /\.xz$/i, format: "xz" },
  { pattern: /\.tzst$/i, format: "zstd", innerFormat: "tar" },
  { pattern: /\.(?:zst|zstd)$/i, format: "zstd" },
  { pattern: /\.cab$/i, format: "cab", type: "cab" },
  { pattern: /\.iso$/i, format: "iso", type: "iso" },
  { pattern: /\.arj$/i, format: "arj", type: "arj" },
  { pattern: /\.(?:lzh|lha)$/i, format: "lzh", type: "lzh" },
  { pattern: /\.cbz$/i, format: "zip", type: "zip" },
  { pattern: /\.cbr$/i, format: "rar", type: "rar" },
  { pattern: /\.epub$/i, format: "zip", type: "zip" },
  { pattern: /\.(?:wim|swm)$/i, format: "wim", type: "wim" },
  { pattern: /\.dmg$/i, format: "dmg" },
];

const HEADER_FORMATS = [
  {
    format: "7z",
    type: "7z",
    signature: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  },
  {
    format: "rar",
    type: "rar",
    signatures: [
      [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00],
      [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00],
    ],
  },
  {
    format: "zip",
    type: "zip",
    signatures: [
      [0x50, 0x4b, 0x03, 0x04],
      [0x50, 0x4b, 0x05, 0x06],
      [0x50, 0x4b, 0x07, 0x08],
    ],
  },
  {
    format: "wim",
    type: "wim",
    signature: [0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00],
  },
  {
    format: "cab",
    type: "cab",
    signature: [0x4d, 0x53, 0x43, 0x46],
  },
  {
    format: "gzip",
    signature: [0x1f, 0x8b],
  },
  {
    format: "bzip2",
    signature: [0x42, 0x5a, 0x68],
  },
  {
    format: "xz",
    signature: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  },
  {
    format: "zstd",
    signature: [0x28, 0xb5, 0x2f, 0xfd],
  },
  {
    format: "arj",
    type: "arj",
    signature: [0x60, 0xea],
  },
];

function startsWithBytes(buffer, signature, offset = 0) {
  if (buffer.length < offset + signature.length) {
    return false;
  }
  return signature.every((value, index) => buffer[offset + index] === value);
}

/**
 * 根据强文件头签名判断真实容器格式。
 *
 * 只识别不会与普通文件轻易冲突的签名；无法确认时返回 null，继续交给后缀
 * 和 7-Zip 自身识别。扩展名写错（例如 RAR5 被命名成 .wim）时，调用方可以
 * 用这里的返回值纠正 selection，避免继续用错误的 -t 类型参数打开。
 */
function detectArchiveFormatByHeader(header) {
  const bytes = Buffer.isBuffer(header)
    ? header
    : Buffer.from(header || []);

  for (const candidate of HEADER_FORMATS) {
    const signatures = candidate.signatures || [candidate.signature];
    if (signatures.some((signature) => startsWithBytes(bytes, signature))) {
      return {
        format: candidate.format,
        type: candidate.type || null,
        innerFormat: candidate.innerFormat || null,
      };
    }
  }

  // TAR 的魔数不在文件开头；512 字节文件头中的偏移 257 足以判断。
  if (bytes.length >= 262 && bytes.toString("ascii", 257, 262) === "ustar") {
    return { format: "tar", type: "tar", innerFormat: null };
  }

  // LZH 的 method 字段位于偏移 2，形如 "-lh" / "-lz"。
  if (
    bytes.length >= 5
    && bytes[2] === 0x2d
    && (bytes[3] === 0x6c)
    && (bytes[4] === 0x68 || bytes[4] === 0x7a)
  ) {
    return { format: "lzh", type: "lzh", innerFormat: null };
  }

  return null;
}

function createDetectedSelection(filePath, detected) {
  const basename = path.basename(filePath);
  return {
    kind: "single",
    format: detected.format,
    type: detected.type || null,
    innerFormat: detected.innerFormat || null,
    basename,
    outputStem: path.parse(basename).name || basename,
    partNumber: 1,
    firstVolumeName: basename,
    detectedBy: "header",
  };
}

function stripKnownExtension(name) {
  for (const entry of SINGLE_FORMATS) {
    if (entry.pattern.test(name)) {
      return name.replace(entry.pattern, "");
    }
  }
  return name;
}

function detectInnerSplitFormat(stem) {
  if (/\.7z$/i.test(stem)) {
    return { format: "7z", type: "7z.split" };
  }
  if (/\.zip$/i.test(stem)) {
    return { format: "zip", type: "zip.split" };
  }
  if (/\.rar$/i.test(stem)) {
    return { format: "rar", type: "rar.split" };
  }
  return { format: null, type: null };
}

function classifyArchive(filePath) {
  const basename = path.basename(filePath);

  const rarParts = basename.match(/^(.*)\.part(\d+)\.rar$/i);
  if (rarParts) {
    const partText = rarParts[2];
    const partNumber = Number(partText);
    if (!isSupportedPartNumber(partNumber)) {
      return null;
    }
    return {
      kind: "rar-parts",
      format: "rar",
      type: "rar",
      basename,
      seriesStem: rarParts[1],
      outputStem: rarParts[1],
      partNumber,
      partWidth: partText.length,
      firstVolumeName: `${rarParts[1]}.part${String(1).padStart(partText.length, "0")}.rar`,
    };
  }

  const numericSplit = basename.match(/^(.*)\.(\d{3,})$/);
  if (numericSplit) {
    const partNumber = Number(numericSplit[2]);
    if (!isSupportedPartNumber(partNumber)) {
      return null;
    }
    const inner = detectInnerSplitFormat(numericSplit[1]);
    return {
      kind: "split",
      format: inner.format,
      type: inner.type,
      basename,
      seriesStem: numericSplit[1],
      outputStem: stripKnownExtension(numericSplit[1]),
      partNumber,
      partWidth: numericSplit[2].length,
      firstVolumeName: `${numericSplit[1]}.${String(1).padStart(numericSplit[2].length, "0")}`,
    };
  }

  const zipPart = basename.match(/^(.*)\.z(\d{2,})$/i);
  if (zipPart) {
    const partNumber = Number(zipPart[2]);
    if (!isSupportedPartNumber(partNumber)) {
      return null;
    }
    return {
      kind: "zip-z",
      format: "zip",
      type: "zip",
      basename,
      seriesStem: zipPart[1],
      outputStem: zipPart[1],
      partNumber,
      partWidth: zipPart[2].length,
      firstVolumeName: `${zipPart[1]}.zip`,
    };
  }

  const oldRarPart = basename.match(/^(.*)\.r(\d{2,})$/i);
  if (oldRarPart) {
    const rawPart = Number(oldRarPart[2]);
    // .r00 是第 2 卷：原始号从 0 起算，因此不能直接用 isSupportedPartNumber
    // （它要求 >= 1），单独判断原始号范围。
    if (
      !Number.isSafeInteger(rawPart)
      || rawPart < 0
      || rawPart + 2 > MAX_VOLUME_NUMBER
    ) {
      return null;
    }
    return {
      kind: "rar-old",
      format: "rar",
      type: "rar",
      basename,
      seriesStem: oldRarPart[1],
      outputStem: oldRarPart[1],
      partNumber: rawPart + 2,
      partWidth: oldRarPart[2].length,
      firstVolumeName: `${oldRarPart[1]}.rar`,
    };
  }

  for (const entry of SINGLE_FORMATS) {
    if (entry.pattern.test(basename)) {
      const outputStem = basename.replace(entry.pattern, "");
      return {
        kind: "single",
        format: entry.format,
        type: entry.type || null,
        innerFormat: entry.innerFormat || null,
        basename,
        outputStem,
        partNumber: 1,
        firstVolumeName: basename,
      };
    }
  }

  return null;
}

// 分卷号与缺失枚举的上界。
//
// 分卷号直接来自目录名里的数字，而下面的正则没有位数上限：一个合法备份名
// （如 backup.20260915）会命中 `\.(\d{3,})$` 被当成 2000 万号分卷，
// missingRange 逐号枚举就会分配 2000 万个元素的数组，而结果还会被 join 进
// warnings 随 info/preview 响应返回 —— 不需要恶意输入就能打挂请求。
const MAX_VOLUME_NUMBER = 10000;
const MAX_MISSING_ENUM = 100;

function isSupportedPartNumber(value) {
  return Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_VOLUME_NUMBER;
}

// 返回 { values, total, truncated }：
//   values    —— 缺失的分卷号，最多 MAX_MISSING_ENUM 个（保持数字数组形状，
//                前端与既有测试都按数字数组消费）
//   total     —— 1..min(end, MAX_VOLUME_NUMBER) 区间内的缺失总数
//   truncated —— 是否被截断（枚举数量或分卷号上界任一触发）
function missingRange(present, start, end) {
  const values = new Set(present);
  const missing = [];
  const boundedEnd = Math.min(end, MAX_VOLUME_NUMBER);
  let total = 0;
  for (let value = start; value <= boundedEnd; value += 1) {
    if (values.has(value)) {
      continue;
    }
    total += 1;
    if (missing.length < MAX_MISSING_ENUM) {
      missing.push(value);
    }
  }
  return {
    values: missing,
    total,
    truncated: total > missing.length || end > boundedEnd,
  };
}

const REGEX_CACHE = new Map();

function getCachedRegExp(pattern, flags) {
  const key = `${pattern}:${flags}`;
  let regex = REGEX_CACHE.get(key);
  if (!regex) {
    regex = new RegExp(pattern, flags);
    REGEX_CACHE.set(key, regex);
  }
  return regex;
}

function collectVolumeNames(selection, directoryNames) {
  if (!selection) {
    return {
      names: [],
      missingParts: [],
      missingTotal: 0,
      missingTruncated: false,
      firstVolumeName: "",
    };
  }

  if (selection.kind === "split") {
    const escaped = escapeRegExp(selection.seriesStem);
    const matcher = getCachedRegExp(`^${escaped}\\.(\\d{3,})$`, "i");
    const matches = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    const maxPart = matches.length ? matches.at(-1).part : 0;
    const missing = missingRange(matches.map((entry) => entry.part), 1, maxPart);
    return {
      names: matches.map((entry) => entry.name),
      missingParts: missing.values,
      missingTotal: missing.total,
      missingTruncated: missing.truncated,
      firstVolumeName: resolveActualName(directoryNames, selection.firstVolumeName),
    };
  }

  if (selection.kind === "rar-parts") {
    const escaped = escapeRegExp(selection.seriesStem);
    const matcher = getCachedRegExp(`^${escaped}\\.part(\\d+)\\.rar$`, "i");
    const matches = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    const maxPart = matches.length ? matches.at(-1).part : 0;
    const missing = missingRange(matches.map((entry) => entry.part), 1, maxPart);
    return {
      names: matches.map((entry) => entry.name),
      missingParts: missing.values,
      missingTotal: missing.total,
      missingTruncated: missing.truncated,
      firstVolumeName: resolveActualName(directoryNames, selection.firstVolumeName),
    };
  }

  const stem = selection.seriesStem || selection.outputStem;
  // lowerCaseIndex 只在 zip-z / rar-old 两个分支用到，lazy 构建——split /
  // rar-parts / 单文件分支走完上面的 early return 根本到不了这里，无需为
  // 它们白建一个 O(目录条目数) 的 Set。
  let lowerCaseIndex = null;
  const getLowerCaseIndex = () => {
    if (!lowerCaseIndex) {
      lowerCaseIndex = new Set(directoryNames.map((name) => name.toLowerCase()));
    }
    return lowerCaseIndex;
  };

  if (selection.format === "zip" && /\.zip$/i.test(selection.firstVolumeName)) {
    const escaped = escapeRegExp(stem);
    const matcher = getCachedRegExp(`^${escaped}\\.z(\\d{2,})$`, "i");
    const parts = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    if (parts.length) {
      const maxPart = parts.at(-1).part;
      const mainName = `${stem}.zip`;
      const actualMainName = resolveActualName(directoryNames, mainName);
      const missing = missingRange(parts.map((entry) => entry.part), 1, maxPart);
      return {
        names: [...parts.map((entry) => entry.name), actualMainName]
          .filter((name) => getLowerCaseIndex().has(name.toLowerCase())),
        missingParts: missing.values,
        missingTotal: missing.total,
        missingTruncated: missing.truncated,
        firstVolumeName: actualMainName,
      };
    }
  }

  if (selection.format === "rar" && /\.rar$/i.test(selection.firstVolumeName)) {
    const escaped = escapeRegExp(stem);
    const matcher = getCachedRegExp(`^${escaped}\\.r(\\d{2,})$`, "i");
    const parts = directoryNames
      .map((name) => {
        const match = name.match(matcher);
        return match ? { name, part: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
    if (parts.length) {
      const maxPart = parts.at(-1).part;
      const mainName = `${stem}.rar`;
      const actualMainName = resolveActualName(directoryNames, mainName);
      const missing = missingRange(parts.map((entry) => entry.part), 0, maxPart);
      return {
        names: [actualMainName, ...parts.map((entry) => entry.name)]
          .filter((name) => getLowerCaseIndex().has(name.toLowerCase())),
        missingParts: missing.values,
        missingTotal: missing.total,
        missingTruncated: missing.truncated,
        firstVolumeName: actualMainName,
      };
    }
  }

  const selectedName = directoryNames.find(
    (name) => name.toLowerCase() === selection.basename.toLowerCase(),
  );
  return {
    names: selectedName ? [selectedName] : [],
    missingParts: [],
    missingTotal: 0,
    missingTruncated: false,
    firstVolumeName: resolveActualName(directoryNames, selection.firstVolumeName),
  };
}

function resolveActualName(directoryNames, expectedName) {
  const expectedLower = String(expectedName || "").toLowerCase();
  return directoryNames.find((name) => name.toLowerCase() === expectedLower)
    || expectedName;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  MAX_MISSING_ENUM,
  MAX_VOLUME_NUMBER,
  SINGLE_FORMATS,
  classifyArchive,
  collectVolumeNames,
  createDetectedSelection,
  detectArchiveFormatByHeader,
  missingRange,
  stripKnownExtension,
};
