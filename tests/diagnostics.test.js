"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DiagnosticLogger,
  NullDiagnosticLogger,
  createDiagnosticLogger,
  redactDiagnosticValue,
  safeDiagnosticWrite,
} = require("../app/server/lib/diagnostics");

function makeLoggerRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chzip-diag-"));
}

// ------------------------------------------------------------ A5：脱敏正确性

// 回归锁：isSensitiveKey 曾用子串匹配，而 SENSITIVE_KEYS 含 "auth"，
// 于是 "authorizedroots".includes("auth") 为真 —— 诊断报告里最关键的
// authorizedRoots 字段恒被抹成 "[REDACTED]"，而该报告的核心用途恰恰是
// 排查目录授权问题。
test("A5 keeps authorizedRoots intact in a diagnostic report", () => {
  const out = redactDiagnosticValue({
    generatedAt: "2026-09-15T00:00:00.000Z",
    version: "3.1",
    authorizedRoots: [
      { path: "/vol1/share", canBrowse: true, canSelect: true },
    ],
  });

  assert.deepEqual(out.authorizedRoots, [
    { path: "/vol1/share", canBrowse: true, canSelect: true },
  ]);
});

test("A5 still redacts genuinely sensitive keys", () => {
  const out = redactDiagnosticValue({
    Password: "hunter2",
    my_token: "abc",
    authToken: "abc",
    credential: "abc",
    privateKey: "abc",
    auth: "abc",
    authorization: "Bearer abc",
    authorizedRoots: ["/vol1/share"],
    logTail: "keep me",
  });

  for (const key of [
    "Password",
    "my_token",
    "authToken",
    "credential",
    "privateKey",
    "auth",
    "authorization",
  ]) {
    assert.equal(out[key], "[REDACTED]", `${key} 应被脱敏`);
  }
  assert.deepEqual(out.authorizedRoots, ["/vol1/share"]);
  assert.equal(out.logTail, "keep me");
});

test("A5 redacts a 7z password argument", () => {
  const out = redactDiagnosticValue({
    logTail: "7z x -pSecret123 /vol1/share/a.7z",
  });
  assert.equal(out.logTail, "7z x[REDACTED] /vol1/share/a.7z");
});

// 原密码字符集 [\w!@#$%^&*+\-.] 不含中文，-p密码 完全抹不掉。
test("A2 redacts a non-ASCII (Chinese) password", () => {
  const out = redactDiagnosticValue({
    logTail: "7z x -p密码abc /vol1/share/a.7z",
  });
  assert.equal(out.logTail, "7z x[REDACTED] /vol1/share/a.7z");
});

// 含空格的密码只能抹到空格前（与「密码 + 路径」的空白分隔无法区分），
// 但 -p 前缀必须被抹掉，剩余部分不构成完整密码。
test("A2 redacts the password prefix even when the password has a space", () => {
  const out = redactDiagnosticValue({
    logTail: "7z x -pmy pass /vol1/share/a.7z",
  });
  assert.equal(out.logTail, "7z x[REDACTED] pass /vol1/share/a.7z");
  assert.ok(!out.logTail.includes("-pmy"));
});

// 密码后紧跟路径时，后边界 (?=[\s"']|$) 防止把路径吞进同一匹配。
test("A2 does not swallow the trailing path after the password", () => {
  const out = redactDiagnosticValue({
    logTail: "-pSecret /vol1/share/a.7z -o/out",
  });
  assert.equal(out.logTail, "[REDACTED] /vol1/share/a.7z -o/out");
});

// -p 正则曾带 \b 分支，而词字符与 `-` 之间本身就构成词边界，
// 于是含 `-p` 的路径被误伤成 my[REDACTED]，诊断报告里的路径随之失真。
test("A5 keeps paths containing a dash-p segment", () => {
  const out = redactDiagnosticValue({
    source: { path: "/vol1/share/my-project/a.7z" },
    authorizedRoots: [{ path: "/var/apps/CHzip/authorized-paths.json" }],
  });

  assert.equal(out.source.path, "/vol1/share/my-project/a.7z");
  assert.equal(
    out.authorizedRoots[0].path,
    "/var/apps/CHzip/authorized-paths.json",
  );
});

test("A5 redacts a long base64-looking token", () => {
  const out = redactDiagnosticValue({
    logTail: `token ${"A".repeat(40)} end`,
  });
  assert.equal(out.logTail, "token[REDACTED] end");
});

test("A5 redacts nested objects and arrays", () => {
  const out = redactDiagnosticValue({
    error: { detail: [{ password: "x", note: "ok" }] },
  });
  assert.deepEqual(out.error.detail, [{ password: "[REDACTED]", note: "ok" }]);
});

test("A5 passes numbers, booleans and null through unchanged", () => {
  const out = redactDiagnosticValue({ n: 1, b: true, z: null, f: false });
  assert.equal(out.n, 1);
  assert.equal(out.b, true);
  assert.equal(out.z, null);
  assert.equal(out.f, false);
});

// -------------------------------------------------------- safeDiagnosticWrite

test("C13 safeDiagnosticWrite returns the record on success", () => {
  const record = safeDiagnosticWrite(
    { write: () => ({ ok: true }) },
    { event: "api_request" },
  );
  assert.deepEqual(record, { ok: true });
});

test("C13 safeDiagnosticWrite swallows a failing logger", () => {
  const logger = {
    write() {
      throw new Error("磁盘满了");
    },
  };
  assert.equal(safeDiagnosticWrite(logger, { event: "x" }), null);
});

test("C13 safeDiagnosticWrite tolerates a missing logger", () => {
  assert.equal(safeDiagnosticWrite(null, { event: "x" }), null);
  assert.equal(safeDiagnosticWrite(undefined, { event: "x" }), null);
});

// ------------------------------------------------------------ DiagnosticLogger

test("C13 DiagnosticLogger writes redacted JSON with 0600/0700 modes", () => {
  const root = makeLoggerRoot();
  const logger = new DiagnosticLogger({ rootDir: root });

  const record = logger.write({ event: "api_request", password: "hunter2" });

  assert.equal(record.password, "[REDACTED]");
  assert.ok(record.timestamp);

  const logPath = path.join(root, "chzip.log");
  const parsed = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(parsed.event, "api_request");
  assert.equal(parsed.password, "[REDACTED]");
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
});

test("C13 DiagnosticLogger removes its lock file after writing", () => {
  const root = makeLoggerRoot();
  const logger = new DiagnosticLogger({ rootDir: root });
  logger.write({ event: "api_request" });

  assert.equal(fs.existsSync(path.join(root, "chzip.log.lock")), false);
});

test("C13 DiagnosticLogger rotates and caps the number of backups", () => {
  const root = makeLoggerRoot();
  const logger = new DiagnosticLogger({
    rootDir: root,
    maxBytes: 120,
    backups: 2,
  });
  for (let index = 0; index < 12; index += 1) {
    logger.write({ event: "e", index });
  }

  const logPath = path.join(root, "chzip.log");
  assert.ok(
    fs.statSync(logPath).size <= 240,
    "单行超出上限时最多再多一行，不应无限增长",
  );
  assert.equal(fs.existsSync(`${logPath}.1`), true);
  assert.equal(fs.existsSync(`${logPath}.2`), true);
  assert.equal(fs.existsSync(`${logPath}.3`), false, "backups 上限是 2");
});

test("C13 DiagnosticLogger.tail returns the trailing bytes", () => {
  const root = makeLoggerRoot();
  const logger = new DiagnosticLogger({ rootDir: root });
  logger.write({ event: "first" });
  logger.write({ event: "second" });

  const tail = logger.tail(200);
  assert.ok(tail.length <= 200);
  assert.match(tail, /"event":"second"/);
});

test("C13 DiagnosticLogger.tail returns an empty string when the log is missing", () => {
  const logger = new DiagnosticLogger({ rootDir: makeLoggerRoot() });
  assert.equal(logger.tail(100), "");
});

test("C13 DiagnosticLogger.tailForRequest matches only the exact request id", () => {
  const root = makeLoggerRoot();
  const logger = new DiagnosticLogger({ rootDir: root });
  logger.write({ event: "api_request", requestId: "aaaa1111" });
  logger.write({ event: "api_request", requestId: "bbbb2222" });
  logger.write({ event: "api_request", requestId: "aaaa1111" });

  const tail = logger.tailForRequest("aaaa1111");
  assert.equal(tail.split("\n").length, 2);
  assert.equal(tail.includes("bbbb2222"), false);
});

test("C13 DiagnosticLogger.tailForRequest returns an empty string without a request id", () => {
  const root = makeLoggerRoot();
  const logger = new DiagnosticLogger({ rootDir: root });
  logger.write({ event: "api_request", requestId: "aaaa1111" });

  assert.equal(logger.tailForRequest(""), "");
});

test("C13 DiagnosticLogger.tailForRequest skips unparsable lines", () => {
  const root = makeLoggerRoot();
  const logger = new DiagnosticLogger({ rootDir: root });
  logger.write({ event: "api_request", requestId: "aaaa1111" });
  // 含引号包裹的 requestId（能通过 includes 预筛）但不是合法 JSON。
  fs.appendFileSync(
    path.join(root, "chzip.log"),
    "这不是 JSON 但含 \"aaaa1111\"\n",
  );

  const tail = logger.tailForRequest("aaaa1111");
  assert.equal(tail.split("\n").length, 1);
  assert.match(tail, /"event":"api_request"/);
});

// ------------------------------------------------------ createDiagnosticLogger

test("C13 createDiagnosticLogger falls back to the next usable root", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-diag-"));
  const blocked = path.join(parent, "not-a-dir");
  fs.writeFileSync(blocked, "");
  const usable = path.join(parent, "logs");

  const logger = createDiagnosticLogger({ rootDirs: [blocked, usable] });

  assert.equal(logger instanceof DiagnosticLogger, true);
  assert.equal(logger.rootDir, usable);
});

test("C13 createDiagnosticLogger returns a null logger when no root is usable", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-diag-"));
  const blocked = path.join(parent, "not-a-dir");
  fs.writeFileSync(blocked, "");

  const logger = createDiagnosticLogger({ rootDirs: [blocked] });

  assert.equal(logger instanceof NullDiagnosticLogger, true);
  assert.equal(logger.write({ event: "x" }), undefined);
  assert.equal(logger.tail(), "");
  assert.equal(logger.tailForRequest("x"), "");
});
