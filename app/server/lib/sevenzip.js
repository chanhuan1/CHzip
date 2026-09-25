"use strict";

const CODE_PAGES = Object.freeze({
  auto: null,
  utf8: 65001,
  gbk: 936,
  big5: 950,
  shift_jis: 932,
  korean: 949,
});

function normalizeCodePage(value = "auto") {
  const id = String(value || "auto").toLowerCase();
  if (!Object.hasOwn(CODE_PAGES, id)) {
    throw new Error("不支持的代码页选项");
  }
  return { id, codePage: CODE_PAGES[id] };
}

// 解压冲突策略：覆盖已存在文件时的行为。键一律小写（normalize 里会 toLowerCase）。
//   rename    —— 自动重命名新文件为 "name (2).ext"（-aou，默认，保持现状）
//   overwrite —— 无条件覆盖（-aoa）
//   skip      —— 跳过已存在文件（-aos）
//   keepnew   —— 保留较新：新文件占原名、旧文件改名（-aot）
// 与 normalizeCodePage 同款白名单：CGI 参数直通 spawn，未知值立刻 throw，
// 不给命令注入留缝。策略仅此一处定义，不要再造第二个 overwriteMode。
const CONFLICT_POLICIES = Object.freeze({
  rename: Object.freeze({ flag: "-aou", label: "自动重命名" }),
  overwrite: Object.freeze({ flag: "-aoa", label: "覆盖已存在文件" }),
  skip: Object.freeze({ flag: "-aos", label: "跳过已存在文件" }),
  keepnew: Object.freeze({ flag: "-aot", label: "保留较新文件" }),
});

function normalizeConflictPolicy(value = "rename") {
  const id = String(value || "rename").toLowerCase();
  if (!Object.hasOwn(CONFLICT_POLICIES, id)) {
    throw new Error("不支持的解压冲突策略");
  }
  return { id, ...CONFLICT_POLICIES[id] };
}

// 7-Zip 26.x 对 RAR5 多分卷（Volume Locator）在强制 -tRar 时反而 Open ERROR，
// RAR/RAR5 一律交给引擎自动识别更稳；`.split` 是内部伪类型，也不下发。
// comment 读/写与 list/extract 共用同一条红线。
function appendForcedType(args, selection) {
  const forcedType = selection.type;
  const forceable = forcedType
    && forcedType !== "rar"
    && !/\.split$/i.test(forcedType);
  if (forceable) {
    args.push(`-t${forcedType}`);
  }
}

function appendArchiveOptions(args, selection, options) {
  appendForcedType(args, selection);

  const codePage = normalizeCodePage(options.codePage);
  if (selection.format === "zip" && codePage.codePage) {
    args.push(`-mcp=${codePage.codePage}`);
  }

  if (options.password) {
    args.push(`-p${options.password}`);
  }
}

function buildListArgs(selection, options) {
  const args = ["l", "-slt", "-sccUTF-8"];
  appendArchiveOptions(args, selection, options);
  args.push(options.archivePath);
  return args;
}

function buildExtractArgs(selection, options) {
  const args = [
    "x",
    "-y",
    // 冲突策略来自 job.conflictPolicy（F1），默认 rename 维持现状。
    // 注意：嵌套 tar 预解与预览准备目录是 mkdtemp 出来的空目录，
    // 必须继续传默认 -aou，不能让用户策略污染那条路径。
    normalizeConflictPolicy(options.conflictPolicy).flag,
    "-mmt=on",
    "-bsp1",
    "-bb1",
    "-sccUTF-8",
  ];
  appendArchiveOptions(args, selection, options);

  if (options.selectionFile) {
    args.push(
      "-scsUTF-8",
      "-spd",
      `-i@${options.selectionFile}`,
    );
  }

  args.push(`-o${options.outputDir}`, options.archivePath);
  return args;
}

function buildStdoutExtractArgs(selection, options) {
  const args = [
    "e",
    "-so",
    "-sccUTF-8",
    "-scsUTF-8",
    "-spd",
  ];
  appendArchiveOptions(args, selection, options);
  if (options.selectionFile) {
    args.push(`-i@${options.selectionFile}`);
  }
  args.push(options.archivePath);
  return args;
}

function buildCommentArgs(selection, options) {
  const args = ["c", "-sccUTF-8"];
  appendForcedType(args, selection);
  if (options.commentFile) {
    args.push(`-z${options.commentFile}`);
  }
  args.push(options.archivePath);
  return args;
}

function buildReadCommentArgs(selection, options) {
  const args = ["l", "-slt", "-sccUTF-8"];
  appendForcedType(args, selection);
  args.push(options.archivePath);
  return args;
}

// 完整性体检（F6）：`7z t` 流式校验整个压缩包的 CRC。
// 与 x 的关键差别：只读不写盘（无 -o），因此对固实包、大归档都是安全预检；
// -bsp1 让进度行与解压同构，前端轮询同一套解析即可复用。
// 密码与代码页走与 list/extract 相同的 appendArchiveOptions（含 -p 临时文件语义
// 由调用方保证；这里只拼参数）。
function buildTestArgs(selection, options = {}) {
  const args = ["t", "-y", "-bsp1", "-bb1", "-sccUTF-8"];
  appendArchiveOptions(args, selection, options);
  args.push(options.archivePath);
  return args;
}

module.exports = {
  CODE_PAGES,
  CONFLICT_POLICIES,
  buildCommentArgs,
  buildExtractArgs,
  buildListArgs,
  buildReadCommentArgs,
  buildStdoutExtractArgs,
  buildTestArgs,
  normalizeCodePage,
  normalizeConflictPolicy,
};
