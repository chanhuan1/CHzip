"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// ui-dialogs.js 是浏览器 IIFE，导出对象挂在 window/globalThis 上。
require("../app/www/js/ui-dialogs");

const DIALOGS = globalThis.CHzipUiDialogs;

test("CHzipUiDialogs exports recordDiagnosticError (called from app.js)", () => {
  // 回归锁：app.js:549/693 在 catch 路径里调 uiDialogs.recordDiagnosticError，
  // 它曾在导出对象里漏掉 —— 那两条路径会 TypeError，诊断记录本身崩掉。
  assert.equal(typeof DIALOGS.recordDiagnosticError, "function");
});

test("every app.js uiDialogs.* call resolves to an exported function", () => {
  // 通用防回归：扫 app.js 里所有 uiDialogs.X( 调用，逐个断言 X 已导出且
  // 是函数——比逐个硬编码清单更能防下一次漏导出。
  assertExportedCallsResolve("app.js", "uiDialogs", DIALOGS);
});

// 扫指定源文件里所有 `<receiver>.<name>(` 调用，逐个断言已导出。
function assertExportedCallsResolve(sourceName, receiver, exportObject) {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "app", "www", "js", sourceName),
    "utf8",
  );
  const called = new Set();
  const pattern = new RegExp(`\\b${receiver}\\.(\\w+)\\s*\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    called.add(match[1]);
  }
  assert.ok(called.size > 0, `应扫到至少一个 ${receiver}.* 调用`);
  for (const name of called) {
    assert.equal(
      typeof exportObject[name],
      "function",
      `${sourceName} 调用了 ${receiver}.${name}，但它不在导出对象里`,
    );
  }
}

// ------------------------------------------------------------ 其它全局对象同款对账

require("../app/www/js/ui-jobs");
require("../app/www/js/ui-preview");

test("every app.js uiJobs.* call resolves to an exported function", () => {
  assertExportedCallsResolve("app.js", "uiJobs", globalThis.CHzipUiJobs);
});

test("every app.js uiPreview.* call resolves to an exported function", () => {
  assertExportedCallsResolve("app.js", "uiPreview", globalThis.CHzipPreview);
});
