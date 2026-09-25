"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { LIMITS, TIMEOUTS } = require("./constants");

const SYSTEM_COMMANDS = ["7zzs", "7zz", "7z", "7za", "7zr"];

function executableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    fs.accessSync(filePath, fs.constants.X_OK);
    return stat.isFile();
  } catch (error) {
    return false;
  }
}

function locateSevenZip(options = {}) {
  const envPath = options.envPath || process.env.CHZIP_SEVENZIP_PATH;
  if (envPath && executableFile(envPath)) {
    return { path: envPath, source: "env" };
  }

  const vendorRoot = options.vendorRoot
    || path.resolve(__dirname, "..", "..", "vendor", "7zip");
  const archDir = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  for (const binary of ["7zzs", "7zz"]) {
    const bundledPath = path.join(vendorRoot, archDir, binary);
    if (executableFile(bundledPath)) {
      return { path: bundledPath, source: "bundled" };
    }
  }

  for (const command of SYSTEM_COMMANDS) {
    const result = spawnSync("sh", ["-c", `command -v ${command}`], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return {
        path: result.stdout.trim().split(/\r?\n/)[0],
        source: "system",
      };
    }
  }

  return null;
}

// 进程内缓存。CGI 下每个请求是一个独立进程，所以缓存的生命周期天然就是
// 「单次请求」——不会出现「换了 7z 却读到旧路径」的陈旧问题。
// 一次 extract 请求里 findSevenZip 会被调 2~3 次，兜底分支每次最多起 5 个
// `sh -c command -v`，重复探测纯属浪费。
// 只有使用默认参数的调用才走缓存；带 vendorRoot/envPath 覆盖的调用
// （测试注入）必须每次真实探测。
let cachedSevenZip;
let hasCachedSevenZip = false;

function findSevenZip(options = {}) {
  const cacheable = Object.keys(options).length === 0;
  if (cacheable && hasCachedSevenZip) {
    return cachedSevenZip;
  }
  const result = locateSevenZip(options);
  if (cacheable) {
    cachedSevenZip = result;
    hasCachedSevenZip = true;
  }
  return result;
}

// 仅供测试：清空进程内探测缓存。
function resetSevenZipCache() {
  cachedSevenZip = undefined;
  hasCachedSevenZip = false;
}

function classifySevenZipError(log, exitCode, context = {}) {
  const text = String(log || "").toLowerCase();
  if (exitCode === 255 && context.cancelled) {
    return { code: "CANCELLED", message: "任务已取消" };
  }
  if (
    !context.passwordProvided
    && (
      /enter password|password.*required|can not open encrypted/.test(text)
      || (exitCode === 255 && /password/.test(text))
    )
  ) {
    return { code: "PASSWORD_REQUIRED", message: "压缩包需要密码" };
  }
  if (/wrong password|password is incorrect|encrypted.*password|can not open encrypted/.test(text)) {
    return { code: "PASSWORD", message: "密码错误或压缩包需要密码" };
  }
  if (/missing volume|unexpected end of archive|can't open as archive: 1/.test(text)) {
    return { code: "MISSING_VOLUME", message: "分卷缺失或顺序不完整" };
  }
  if (/permission denied|errno=13|access is denied/.test(text)) {
    return { code: "PERMISSION", message: "应用没有读取或写入权限" };
  }
  if (/can not open.*as archive|is not archive|unsupported method/.test(text)) {
    return { code: "UNSUPPORTED", message: "文件格式不受支持或扩展名不正确" };
  }
  if (/data error|crc failed|headers error|unexpected end of data/.test(text)) {
    return { code: "DAMAGED", message: "压缩包已损坏或数据校验失败" };
  }
  if (/file name too long|errno\s*=\s*36|name too long/.test(text)) {
    return {
      code: "FILE_NAME_TOO_LONG",
      message: "压缩包内有文件因文件名过长（超出文件系统 255 字节限制）无法写入；其余文件已尽量解压，输出目录已保留",
    };
  }
  if (exitCode === 255) {
    if (context.phase === "preview") {
      return {
        code: "PREVIEW_INTERRUPTED",
        message: "压缩包预览被系统中断，可尝试整包解压",
      };
    }
    return {
      code: "ENGINE_INTERRUPTED",
      message: "7-Zip 进程被系统中断",
    };
  }
  return {
    code: "ENGINE",
    message: `7-Zip 执行失败${exitCode == null ? "" : `（退出码 ${exitCode}）`}`,
  };
}

// carry 上限：正常 7-Zip 进度行都很短，这里只是防御「整段输出没有任何
// 换行/回车」的病态输入导致 carry 无限增长。保留尾部是因为我们只取
// 「最后一个」百分比/文件名。
const PROGRESS_CARRY_LIMIT = 64 * 1024;

// 进度百分比 token：**前后都必须是「行首 / 空白」**。
//
// 两边边界都要判：
//   · 后面不是空白（`折扣50%.mp4`）→ 那是文件名里的 %，不是进度；
//   · 前面不是空白（`折扣50%`）→ 同理。
// 少了前边界，一个以 % 结尾的文件名就会被当成进度，percent 跳到错的数字。
const PROGRESS_PERCENT_TOKEN = /(?<=^|\s)(\d{1,3})\s*%(?=\s|$)/g;

function percentTokensOf(line) {
  return [...line.matchAll(PROGRESS_PERCENT_TOKEN)];
}

// 从「扣掉所有进度百分比之后」的残余文本里取文件名。
//
// 不能只看「第一个百分比之后」或「最后一个百分比之前」：7-Zip 在管道（非 TTY）
// 下会把 -bb1 的文件名行与 -bsp1 的进度行挤在同一行且没有 \r 分隔，于是同一行
// 里既可能「名字在百分比之前」（`- a.txt  0%  1%  …`），也可能「名字夹在百分比
// 中间」（`  0% - a.txt  1%  3%  …`）。抠掉百分比后剩下的才是候选；
// 挤在一起的多段更新之间是连续空白，取最后一段。
function extractProgressName(line) {
  const stripped = line.replace(PROGRESS_PERCENT_TOKEN, "").trim();
  if (!stripped) {
    return "";
  }
  const segment = stripped.split(/\s{2,}/).filter(Boolean).at(-1) || "";
  const separator = segment.lastIndexOf(" - ");
  const name = (separator >= 0 ? segment.slice(separator + 3) : segment).trim()
    // 7-Zip 用 \b（退格）+ 空格做原地覆盖刷新，文件名前会带一串 \b；
    // 真机日志实测："\b\b\b\b\b\b- JD633/x.mp4"。这类控制字符（含 \r\n）
    // 不是文件名的一部分，剥掉——否则前端文件树匹配路径必然 NONE。
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .trim();
  // 单文件流式格式（.gz/.bz2/.xz 等）的 -bsp1 进度是「  1」「  2」…这样的
  // 已处理文件计数，7-Zip 不输出文件名。若把这个序号当 currentFile 传下去，
  // 前端文件树会拿 "1"/"2" 去匹配路径（永远 NONE），实时高亮失效、进度条
  // 下方还会显示一个莫名其妙的数字。纯数字序号不是文件名，丢弃。
  if (/^\d+$/.test(name)) {
    return "";
  }
  return name;
}

// 7-Zip 的进度用回车符 \r 原地覆盖（不换行），因此要按行分段并取
// “最后一个”快照，才能拿到最新百分比；否则会一直停在最早的低值（0%）。
//
// 这里做成**增量**解析器：原实现每个 chunk 都把整段累积日志（最多 64KB）
// split 一遍再逐行正则，整体是 O(chunk 数 × 日志长度)，随解压推进越来越慢；
// 增量版每次只处理新到的字节 + 当前那一行。
//
// 语义与「一次性扫描整段日志」完全一致：percent 取最后一个带百分比的片段，
// currentFile 取最后一个带非空文件名的片段。
//
// 解码器内置在这里，因为 chunk 边界可能切断多字节 UTF-8 字符；
// write() 会返回本次真正解出的文本，调用方用它拼日志，避免二次解码。
function createProgressTracker() {
  const decoder = new StringDecoder("utf8");
  // committed 只由「已完整结束的行」推进；未完成的行每次都从 committed
  // 重新算一遍（不累积），否则一个尚未收尾的部分行会把中间态写进状态，
  // 而后续补齐又因为 tail 为空不回写，导致残留一个错误的文件名。
  const committed = { percent: 0, currentFile: "" };
  let carry = "";
  let ended = false;

  const applyLineTo = (state, raw) => {
    const line = String(raw).trim();
    const tokens = percentTokensOf(line);
    if (!tokens.length) {
      return;
    }
    // 取最后一个：挤在一行里的多次更新，最后那个才是最新进度。
    state.percent = Math.min(100, Number(tokens[tokens.length - 1][1]));
    const name = extractProgressName(line);
    if (name) {
      state.currentFile = name;
    }
  };

  const consumeCompleteLines = () => {
    let index;
    // \r\n / \r / \n 都当分隔符：\r\n 会多切出一个空片段，
    // 而空片段不产生任何匹配，等价于原实现按 /\r\n|\r|\n/ 切分。
    while ((index = carry.search(/[\r\n]/)) >= 0) {
      applyLineTo(committed, carry.slice(0, index));
      carry = carry.slice(index + 1);
    }
  };

  const absorb = (text) => {
    if (!text) {
      return;
    }
    carry += text;
    consumeCompleteLines();
    if (carry.length > PROGRESS_CARRY_LIMIT) {
      carry = carry.slice(-PROGRESS_CARRY_LIMIT);
    }
  };

  // 当前可观测状态 = 已提交状态 + 当前这一行（尚未收尾）的贡献。
  const snapshot = () => {
    if (!carry) {
      return { percent: committed.percent, currentFile: committed.currentFile };
    }
    const state = {
      percent: committed.percent,
      currentFile: committed.currentFile,
    };
    applyLineTo(state, carry);
    return state;
  };

  return {
    write(chunk) {
      const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      absorb(text);
      return { ...snapshot(), text };
    },
    // 流结束时调用，冲刷解码器里可能残留的半个多字节字符。
    flush() {
      if (ended) {
        return { ...snapshot(), text: "" };
      }
      ended = true;
      const text = decoder.end();
      absorb(text);
      return { ...snapshot(), text };
    },
    state() {
      return snapshot();
    },
  };
}

function parseProgress(log) {
  const tracker = createProgressTracker();
  tracker.write(String(log || ""));
  tracker.flush();
  return tracker.state();
}

// 把 spawnSync 的输出统一成字符串。encoding:"utf8" 时本来就是 string；
// encoding:null（二进制预览）时是 Buffer，必须先显式解码再参与拼接/分类。
function toText(value) {
  if (value == null) {
    return "";
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function runSevenZipSync(tool, args, options = {}) {
  // encoding 默认 utf8，保持所有既有调用点逐字节不变；
  // 传 null 时 stdout/stderr 是 Buffer —— 预览图片需要原始字节，不能先过
  // 一次 UTF-8 解码（那会把二进制内容替换成 U+FFFD）。
  const encoding = options.encoding === undefined ? "utf8" : options.encoding;
  const result = spawnSync(tool.path, args, {
    cwd: options.cwd,
    encoding,
    timeout: options.timeout || TIMEOUTS.SEVENZIP_SYNC_MS,
    maxBuffer: options.maxBuffer || LIMITS.MAX_PREVIEW_OUTPUT_BYTES,
    windowsHide: true,
  });
  // encoding 为 null 时 stdout/stderr 是 Buffer：直接塞进模板字符串会走
  // Buffer.toString() 的默认 utf8，二进制会被替换字符污染。日志只用于错误
  // 分类，所以这里显式解码。
  const log = toText(result.stdout) + toText(result.stderr);
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      const error = new Error("压缩包预览输出超过大小限制");
      error.code = "PREVIEW_LIMIT";
      error.cause = result.error;
      throw error;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const classified = classifySevenZipError(log, result.status, {
      ...options,
      passwordProvided: options.passwordProvided
        ?? args.some((argument) => /^-p./s.test(argument)),
    });
    const error = new Error(classified.message);
    error.code = classified.code;
    error.exitCode = result.status;
    error.log = log;
    throw error;
  }
  return {
    exitCode: result.status,
    log,
    stdout: result.stdout == null ? "" : result.stdout,
    stderr: result.stderr == null ? "" : result.stderr,
  };
}

function spawnSevenZip(tool, args, options = {}) {
  return spawn(tool.path, args, {
    cwd: options.cwd,
    detached: options.detached !== false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

module.exports = {
  classifySevenZipError,
  createProgressTracker,
  executableFile,
  findSevenZip,
  locateSevenZip,
  parseProgress,
  resetSevenZipCache,
  runSevenZipSync,
  spawnSevenZip,
};
