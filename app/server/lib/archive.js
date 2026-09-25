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
      firstVolumeName: selection.firstVolumeName,
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
      firstVolumeName: selection.firstVolumeName,
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
      const missing = missingRange(parts.map((entry) => entry.part), 1, maxPart);
      return {
        names: [...parts.map((entry) => entry.name), mainName]
          .filter((name) => getLowerCaseIndex().has(name.toLowerCase())),
        missingParts: missing.values,
        missingTotal: missing.total,
        missingTruncated: missing.truncated,
        firstVolumeName: mainName,
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
      const missing = missingRange(parts.map((entry) => entry.part), 0, maxPart);
      return {
        names: [mainName, ...parts.map((entry) => entry.name)]
          .filter((name) => getLowerCaseIndex().has(name.toLowerCase())),
        missingParts: missing.values,
        missingTotal: missing.total,
        missingTruncated: missing.truncated,
        firstVolumeName: mainName,
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
    firstVolumeName: selection.firstVolumeName,
  };
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
  missingRange,
  stripKnownExtension,
};
