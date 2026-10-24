"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  BUILD_VARIANTS,
  PLATFORM_CONFIG,
  packageFileName,
  parseVersion,
} = require("../scripts/build-fpk");

const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "manifest");
const packageJsonPath = path.join(rootDir, "package.json");
const indexPath = path.join(rootDir, "app", "www", "index.html");
const readmePath = path.join(rootDir, "README.md");
const auditPath = path.join(rootDir, "scripts", "audit-fpk.js");
const distDir = path.join(rootDir, "dist");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 版本号没有单一来源，需要手动同步 4 处：manifest / package.json /
// index.html 的 ?v= / audit-fpk 的断言。这个测试把「同步」变成门禁 ——
// 漏改任何一处都会让 npm test 变红（v2.9 就漏改过 package.json，
// 发布后才补上）。
const version = parseVersion(manifestPath);

test("C14 package.json version matches the manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  assert.equal(pkg.version, version);
});

test("C14 every asset cache-busting key matches the manifest version", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  const pattern = /(?:src|href)="([^"]+)\?v=([^"]+)"/g;
  const assetVersionPattern = new RegExp(
    `^${escapeRegExp(version)}(?:-r\\d+)?$`,
  );
  const entries = [];
  let match;
  while ((match = pattern.exec(html))) {
    entries.push({ url: match[1], version: match[2] });
  }

  // 1 个 CSS + 14 个 JS + 1 个品牌图标，共 16 处资产版本缓存键全部与当前版本同步。
  assert.equal(entries.length, 16, "应为 1 个 CSS + 14 个 JS + 1 个品牌图标，共 16 处");

  for (const asset of entries) {
    assert.match(
      asset.version,
      assetVersionPattern,
      `${asset.url} 的 ?v= 应以 ${version} 开头，并可附加 -rN 缓存修订号`,
    );
  }
});

test("C14 the brand icon cache key matches the manifest version", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  const v = escapeRegExp(version);
  assert.match(html, new RegExp(`icon_64\\.png\\?v=${v}(?:-r\\d+)?`));
});

// README 的徽章与安装命令曾经两次落后于实际版本（v3.0 徽章配 3.1 版本、
// v3.1 徽章配 3.2 版本）。它们是用户第一眼看到的东西，纳入门禁。
test("C14 the README badge and install command match the manifest version", () => {
  const readme = fs.readFileSync(readmePath, "utf8");
  const v = escapeRegExp(version);

  assert.match(
    readme,
    new RegExp(`badge/版本-v${v}-`),
    "README 徽章的版本号应与 manifest 一致",
  );
  assert.match(
    readme,
    new RegExp(`CHzip_${v}_<架构>\\.fpk`),
    "README 安装命令里的包名版本应与 manifest 一致",
  );
});

// 产物完整性校验。
//
// 注意这里刻意**不**要求「dist 里必须存在当前版本的产物」：那样会让「升版本」
// 与「打包」之间 npm test 必然变红，而 CONTRIBUTING 的发布顺序正是
// bump -> test -> build。刚 bump、还没重新打包时 dist 里留着上一版产物，
// 是发布流程中途的正常状态。
//
// 「打包出来的产物版本是否与仓库 manifest 一致」由 scripts/audit-fpk.js
// 负责 —— 它读的是 fpk 内部的 manifest，那才是正确的校验时机（构建之后）。
// 这里只保证：一旦 dist 里出现当前版本的产物，两个架构必须齐全。
test("C14 any package in dist follows the derived naming scheme", (context) => {
  if (!fs.existsSync(distDir)) {
    context.skip("dist/ 不存在（尚未打包）");
    return;
  }
  const files = fs.readdirSync(distDir).filter((name) => name.endsWith(".fpk"));
  if (!files.length) {
    context.skip("dist/ 里没有 .fpk");
    return;
  }

  const expected = [];
  for (const variant of BUILD_VARIANTS) {
    for (const platform of Object.keys(PLATFORM_CONFIG)) {
      expected.push(packageFileName(version, variant, platform));
    }
  }
  const present = files.filter((name) => expected.includes(name));
  if (!present.length) {
    context.skip(`dist/ 里还没有 ${version} 的产物（已 bump、未打包）`);
    return;
  }

  assert.deepEqual(
    present.sort(),
    [...expected].sort(),
    `dist/ 里 ${version} 的产物必须两个架构都齐全`,
  );
});

// audit-fpk 曾经硬编码 3 处版本（两个 fileName + 一处 manifest 版本正则），
// 等于给「手动同步 4 处」再加 3 处。这条用例防止它被改回去。
test("C14 audit-fpk derives the version instead of hardcoding it", () => {
  const source = fs.readFileSync(auditPath, "utf8");

  assert.equal(
    source.includes(`CHzip_${version}_`),
    false,
    "包名必须由 packageFileName 推导，不能硬编码版本",
  );
  assert.match(
    source,
    /require\(["']\.\/build-fpk["']\)/,
    "audit-fpk 应复用 build-fpk 的导出",
  );
});

test("C14 project docs avoid known stale implementation claims", () => {
  const readme = fs.readFileSync(readmePath, "utf8");
  const contributing = fs.readFileSync(
    path.join(rootDir, "CONTRIBUTING.md"),
    "utf8",
  );
  const api = fs.readFileSync(path.join(rootDir, "API.md"), "utf8");
  const docs = fs.readFileSync(path.join(rootDir, "docs", "index.html"), "utf8");
  const commentClaim = "The comment is handed to 7-Zip through a temporary file";

  assert.equal(readme.includes("492 个用例"), false);
  assert.equal(readme.includes("（校验和/版本/架构/搜索特性）"), false);
  assert.equal(contributing.includes("`search-fixed`"), false);
  assert.equal(
    contributing.includes("Passwords are never passed via command-line args"),
    false,
  );
  assert.equal(
    api.split(commentClaim).length - 1,
    1,
    "API 注释传递说明不应重复",
  );
  assert.equal(api.includes(`"version": "${version}"`), true);
  assert.equal(docs.includes("包含 492 项严格的单元测试"), false);
  const css = fs.readFileSync(
    path.join(rootDir, "app", "www", "css", "style.css"),
    "utf8",
  );
  assert.match(
    css,
    new RegExp(`InterVariable\\.woff2\\?v=${escapeRegExp(version)}(?:-r\\d+)?`),
  );
});

test("C14 CGI does not let browsers cache same-version stylesheet rebuilds", () => {
  const cgi = fs.readFileSync(
    path.join(rootDir, "app", "ui", "index.cgi"),
    "utf8",
  );
  assert.match(cgi, /html\|htm\|css\|js\)/);
  assert.match(cgi, /Cache-Control: no-cache, no-store, must-revalidate/);
});

test("C14 cache revisions never leak into the displayed brand version", () => {
  const app = fs.readFileSync(
    path.join(rootDir, "app", "www", "js", "app.js"),
    "utf8",
  );
  assert.match(app, /match\[1\]\.replace\(\/-r\\d\+\$\/,\s*""\)/);
});

test("C14 packageFileName follows the fnOS naming scheme", () => {
  assert.equal(
    packageFileName("9.9", "", "x86"),
    "CHzip_9.9_x86_64.fpk",
  );
  assert.equal(
    packageFileName("9.9", "", "arm"),
    "CHzip_9.9_arm64.fpk",
  );
});
