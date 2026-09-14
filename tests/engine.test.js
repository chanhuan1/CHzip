"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  classifySevenZipError,
  createProgressTracker,
  findSevenZip,
  parseProgress,
  resetSevenZipCache,
} = require("../app/server/lib/engine");

// 覆盖既有用例 + chunk 边界敏感的场景。逐字节喂入时任何边界都会被切到，
// 包括切断 \r、切断 \r\n、切断多字节 UTF-8 字符。
const PROGRESS_VECTORS = [
  "",
  "  42% file.txt\n",
  "  150% file.txt\n",
  "  0% a.txt\r  37% b.txt\r  99% c.txt\r",
  "  0%  1%  3%  5%  6%  8%  10%  11%  13%  15%  16%  18%  20%",
  "  0% a.txt\r  37% b.txt\r  99% c.txt\r  12%  18%",
  "  42% 折扣50%.mp4\n",
  "  0%  5%  12% - file.txt\n",
  "  1% 5 + folder/子目录/文件.txt\r 50% 5 + other.bin\r100% 5 + done.bin\r",
  "  12",
  "  12%",
  "  1% a\r\n  2% b\r\n",
  "\r\r\n\n",
  "no percent at all\n",
  "  7% 文件.txt  8% 另一个.txt\r  9% 第三个.txt\r",
];

test("classifySevenZipError detects password required", () => {
  const result = classifySevenZipError("Enter password", 255, {
    passwordProvided: false,
  });
  assert.equal(result.code, "PASSWORD_REQUIRED");
});

test("classifySevenZipError detects wrong password", () => {
  const result = classifySevenZipError("Wrong password or CRC failed", 255, {
    passwordProvided: true,
  });
  assert.equal(result.code, "PASSWORD");
});

test("classifySevenZipError detects missing volume", () => {
  const result = classifySevenZipError("Unexpected end of archive", 2, {});
  assert.equal(result.code, "MISSING_VOLUME");
});

test("classifySevenZipError detects permission denied", () => {
  const result = classifySevenZipError("Permission denied", 2, {});
  assert.equal(result.code, "PERMISSION");
});

test("classifySevenZipError detects damaged archive", () => {
  const result = classifySevenZipError("Data error in file", 2, {});
  assert.equal(result.code, "DAMAGED");
});

test("classifySevenZipError detects unsupported format", () => {
  const result = classifySevenZipError("Can not open as archive", 2, {});
  assert.equal(result.code, "UNSUPPORTED");
});

test("classifySevenZipError handles cancellation", () => {
  const result = classifySevenZipError("", 255, { cancelled: true });
  assert.equal(result.code, "CANCELLED");
});

test("classifySevenZipError returns generic ENGINE for unknown", () => {
  const result = classifySevenZipError("some random error", 2, {});
  assert.equal(result.code, "ENGINE");
});

test("parseProgress extracts percent and current file", () => {
  const log = "  42% file.txt\n";
  const result = parseProgress(log);
  assert.equal(result.percent, 42);
  assert.equal(result.currentFile, "file.txt");
});

test("parseProgress caps at 100%", () => {
  const log = "  150% file.txt\n";
  const result = parseProgress(log);
  assert.equal(result.percent, 100);
});

test("parseProgress returns zero for empty", () => {
  const result = parseProgress("");
  assert.equal(result.percent, 0);
  assert.equal(result.currentFile, "");
});

test("parseProgress takes the latest carriage-return snapshot", () => {
  const log = "  0% a.txt\r  37% b.txt\r  99% c.txt\r";
  const result = parseProgress(log);
  assert.equal(result.percent, 99);
  assert.equal(result.currentFile, "c.txt");
});

test("parseProgress takes the last percent when updates share one line", () => {
  const log = "  0%  1%  3%  5%  6%  8%  10%  11%  13%  15%  16%  18%  20%";
  const result = parseProgress(log);
  assert.equal(result.percent, 20);
  assert.equal(result.currentFile, "");
});

test("parseProgress keeps the previous file when a packed line has no name", () => {
  const log = "  0% a.txt\r  37% b.txt\r  99% c.txt\r  12%  18%";
  const result = parseProgress(log);
  assert.equal(result.percent, 18);
  assert.equal(result.currentFile, "c.txt");
});

test("parseProgress ignores percent inside a file name", () => {
  const result = parseProgress("  42% 折扣50%.mp4\n");
  assert.equal(result.percent, 42);
  assert.equal(result.currentFile, "折扣50%.mp4");
});

test("parseProgress handles a packed line followed by a name", () => {
  const result = parseProgress("  0%  5%  12% - file.txt\n");
  assert.equal(result.percent, 12);
  assert.equal(result.currentFile, "- file.txt");
});

test("classifySevenZipError detects overlong filename", () => {
  const result = classifySevenZipError(
    "ERROR: Cannot open output file : errno=36 : File name too long : /x/很长的.mp4",
    2,
  );
  assert.equal(result.code, "FILE_NAME_TOO_LONG");
});

function withEnv(name, value, callback) {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

test("findSevenZip caches the probe result inside the process", () => {
  resetSevenZipCache();
  try {
    const first = withEnv("CHZIP_SEVENZIP_PATH", "/bin/sh", () => findSevenZip());
    assert.equal(first.path, "/bin/sh");

    // 环境变量已经撤掉，但缓存已建立 —— 仍应返回首次结果，证明没有再探测。
    const second = findSevenZip();
    assert.equal(second.path, "/bin/sh");
    assert.equal(second, first, "第二次调用应复用同一缓存对象");

    // 清掉缓存后重新探测，环境已变，结果也应随之改变。
    resetSevenZipCache();
    const third = findSevenZip();
    assert.notEqual(third?.path, "/bin/sh");
  } finally {
    resetSevenZipCache();
  }
});

test("findSevenZip with explicit options bypasses the cache", () => {
  resetSevenZipCache();
  try {
    const explicit = findSevenZip({ envPath: "/bin/sh" });
    assert.equal(explicit.path, "/bin/sh");

    // 带覆盖参数的调用不写缓存，因此随后的默认调用必须真实探测。
    const defaults = withEnv("CHZIP_SEVENZIP_PATH", undefined, () => findSevenZip());
    assert.notEqual(defaults?.path, "/bin/sh");
  } finally {
    resetSevenZipCache();
  }
});

test("createProgressTracker matches parseProgress byte-for-byte at every chunk boundary", () => {
  for (const vector of PROGRESS_VECTORS) {
    const expected = parseProgress(vector);
    const tracker = createProgressTracker();
    const bytes = Buffer.from(vector, "utf8");
    for (const byte of bytes) {
      tracker.write(Buffer.from([byte]));
    }
    tracker.flush();
    assert.deepEqual(
      tracker.state(),
      expected,
      `逐字节喂入结果应与整段解析一致：${JSON.stringify(vector)}`,
    );
  }
});

test("createProgressTracker matches parseProgress for random chunk splits", () => {
  for (const vector of PROGRESS_VECTORS) {
    const expected = parseProgress(vector);
    const bytes = Buffer.from(vector, "utf8");
    // 用几组不同的固定块长切分，覆盖「一行跨多个 chunk」与「一个 chunk 多行」
    for (const size of [1, 2, 3, 5, 7, 13]) {
      const tracker = createProgressTracker();
      for (let offset = 0; offset < bytes.length; offset += size) {
        tracker.write(bytes.subarray(offset, offset + size));
      }
      tracker.flush();
      assert.deepEqual(
        tracker.state(),
        expected,
        `块长 ${size} 时应与整段解析一致：${JSON.stringify(vector)}`,
      );
    }
  }
});

test("createProgressTracker returns the decoded text for each write", () => {
  const tracker = createProgressTracker();
  const bytes = Buffer.from("  42% 中文名.txt\r", "utf8");
  let text = "";
  for (const byte of bytes) {
    text += tracker.write(Buffer.from([byte])).text;
  }
  text += tracker.flush().text;
  assert.equal(text, "  42% 中文名.txt\r", "拼接各次 write 的 text 应还原原文，不得出现替换字符");
  assert.deepEqual(tracker.state(), { percent: 42, currentFile: "中文名.txt" });
});

test("createProgressTracker flush is idempotent", () => {
  const tracker = createProgressTracker();
  tracker.write(Buffer.from("  55% a.txt\r", "utf8"));
  const first = tracker.flush();
  const second = tracker.flush();
  assert.deepEqual(first, second);
  assert.equal(second.text, "");
});


