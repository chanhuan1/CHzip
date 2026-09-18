"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const MODULE_PATH = require.resolve("../app/server/lib/diagnostic-service");

// 模块级 cachedVersion 会跨用例残留，每个用例都拿一份全新模块。
function freshService() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

function fakeFs(files) {
  return {
    readFileSync(filePath) {
      if (Object.prototype.hasOwnProperty.call(files, filePath)) {
        const value = files[filePath];
        if (value instanceof Error) {
          throw value;
        }
        return value;
      }
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = "ENOENT";
      throw error;
    },
  };
}

// 与模块内部 MANIFEST_CANDIDATES 相同的两个解析结果（基于模块真实位置
// app/server/lib/）：2 级 = app/server/manifest（安装布局 target/manifest
// 的对应物），3 级 = 仓库根 manifest（开发树）。
const MODULE_DIR = path.dirname(MODULE_PATH);
const INSTALLED_CANDIDATE = path.resolve(MODULE_DIR, "..", "..", "manifest");
const REPO_ROOT_CANDIDATE = path.resolve(MODULE_DIR, "..", "..", "..", "manifest");

test("getPackageVersion prefers the installed-layout manifest (2 levels up)", () => {
  const { getPackageVersion } = freshService();
  const fsModule = fakeFs({
    [INSTALLED_CANDIDATE]: "appname = CHzip\nversion = 9.9\n",
    [REPO_ROOT_CANDIDATE]: "appname = CHzip\nversion = 3.3\n",
  });
  assert.equal(getPackageVersion(fsModule), "9.9", "安装布局候选必须优先命中");
});

test("getPackageVersion falls back to the repo-root manifest (3 levels up)", () => {
  const { getPackageVersion } = freshService();
  const fsModule = fakeFs({
    [REPO_ROOT_CANDIDATE]: "appname = CHzip\nversion = 3.3\n",
  });
  assert.equal(getPackageVersion(fsModule), "3.3", "开发树布局走第二候选");
});

test("getPackageVersion returns 1.0.0 only when every candidate misses", () => {
  const { getPackageVersion } = freshService();
  const fsModule = fakeFs({});
  assert.equal(getPackageVersion(fsModule), "1.0.0");
});

test("getPackageVersion skips a candidate that exists but has no version line", () => {
  const { getPackageVersion } = freshService();
  const fsModule = fakeFs({
    [INSTALLED_CANDIDATE]: "appname = CHzip\n",
    [REPO_ROOT_CANDIDATE]: "appname = CHzip\nversion = 3.3\n",
  });
  assert.equal(getPackageVersion(fsModule), "3.3", "无 version 行的候选要跳过");
});
