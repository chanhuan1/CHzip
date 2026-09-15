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
const auditPath = path.join(rootDir, "scripts", "audit-fpk.js");
const distDir = path.join(rootDir, "dist");

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
  const entries = [];
  let match;
  while ((match = pattern.exec(html))) {
    entries.push({ url: match[1], version: match[2] });
  }

  // 品牌图标刻意保持 ?v=1.0.0：图标文件没改则缓存键无需变，不要「顺手统一」。
  const assets = entries.filter((entry) => !entry.url.endsWith("icon_64.png"));
  assert.equal(assets.length, 13, "应为 1 个 CSS + 12 个 JS");

  for (const asset of assets) {
    assert.equal(
      asset.version,
      version,
      `${asset.url} 的 ?v= 应等于 ${version}`,
    );
  }
});

test("C14 the brand icon keeps its own cache key", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  assert.match(html, /icon_64\.png\?v=1\.0\.0/);
});

test("C14 dist artifacts match the names derived from build-fpk", (context) => {
  if (!fs.existsSync(distDir)) {
    context.skip("dist/ 不存在（尚未打包）");
    return;
  }
  for (const variant of BUILD_VARIANTS) {
    for (const platform of Object.keys(PLATFORM_CONFIG)) {
      const name = packageFileName(version, variant, platform);
      assert.equal(
        fs.existsSync(path.join(distDir, name)),
        true,
        `dist/ 缺少 ${name}`,
      );
    }
  }
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

test("C14 packageFileName follows the fnOS naming scheme", () => {
  assert.equal(
    packageFileName("9.9", "search-fixed", "x86"),
    "CHzip_9.9_search-fixed_x86_64.fpk",
  );
  assert.equal(
    packageFileName("9.9", "search-fixed", "arm"),
    "CHzip_9.9_search-fixed_arm64.fpk",
  );
});
