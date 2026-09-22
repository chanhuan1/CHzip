"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-preview");
require("../app/www/js/ui-dialogs");

const { detectMojibake, isMojibakeName } = globalThis.CHzipPreview;
const { buildMissingVolumeNames } = globalThis.CHzipUiDialogs;

// ------------------------------------------------------------ detectMojibake 正例

test("F12 detectMojibake catches UTF-8 bytes mis-decoded as Latin-1/CP1252", () => {
  // 测试 (E6 B5 8B E8 AF 95) 过 CP1252 后的经典形状
  assert.equal(detectMojibake(["æµ‹è¯•.txt"]), "gbk");
  // 繁文 过 CP1252
  assert.equal(detectMojibake(["dir/ç¹æ–‡.doc"]), "gbk");
});

test("F12 detectMojibake catches Big5 bytes mis-decoded as Latin-1", () => {
  // 繁體 Big5 = B1 C5 C5 E9，按 Latin-1 展开为 ±ÅÅé
  const name = String.fromCharCode(0xB1, 0xC5, 0xC5, 0xE9) + ".zip";
  assert.equal(detectMojibake([name]), "gbk");
});

test("F12 detectMojibake catches Shift-JIS bytes mis-decoded as Latin-1", () => {
  // 日本 SJIS = 93 FA 96 7B
  const name = String.fromCharCode(0x93, 0xFA, 0x96, 0x7B) + ".txt";
  assert.equal(detectMojibake([name]), "gbk");
});

test("F12 detectMojibake catches U+FFFD replacement characters", () => {
  assert.equal(detectMojibake(["���.txt"]), "gbk");
  assert.equal(detectMojibake(["normal/�.bin"]), "gbk");
});

test("F12 detectMojibake catches raw C1 control characters", () => {
  // 合法 UTF-8 解码绝不可能产出 U+008B；出现即字节流被 Latin-1 误读
  const name = "abc" + String.fromCharCode(0x8B) + "def.txt";
  assert.equal(detectMojibake([name]), "gbk");
});

test("F12 detectMojibake scans only the first 200 names", () => {
  const clean = Array.from({ length: 300 }, (_, i) => `file-${i}.txt`);
  assert.equal(detectMojibake(clean), false);
  const withMojibakeLate = [...clean, "æµ‹è¯•.txt"];
  assert.equal(detectMojibake(withMojibakeLate), false, "第 301 条超出扫描窗");
  const withMojibakeEarly = ["æµ‹è¯•.txt", ...clean];
  assert.equal(detectMojibake(withMojibakeEarly), "gbk");
});

test("F12 detectMojibake handles non-array and empty input", () => {
  assert.equal(detectMojibake(null), false);
  assert.equal(detectMojibake(undefined), false);
  assert.equal(detectMojibake([]), false);
  assert.equal(detectMojibake("æµ‹è¯•"), false, "字符串不是数组");
});

// ------------------------------------------------------------ detectMojibake 负例（误报红线）

test("F12 detectMojibake never flags plain ASCII names", () => {
  assert.equal(detectMojibake(["readme.txt", "Report 2024 final (v2).xlsx"]), false);
});

test("F12 detectMojibake never flags correctly-decoded CJK names", () => {
  assert.equal(detectMojibake(["测试文件.zip"]), false);
  assert.equal(detectMojibake(["繁體中文檔案.rar"]), false);
  assert.equal(detectMojibake(["日本語ファイル名.txt"]), false);
  assert.equal(detectMojibake(["한국어파일.pdf"]), false);
  assert.equal(detectMojibake(["混合 mixed 名称 123.txt"]), false);
});

test("F12 detectMojibake never flags European diacritics", () => {
  assert.equal(detectMojibake(["Café français.txt"]), false);
  assert.equal(detectMojibake(["naïve façade.doc"]), false);
  assert.equal(detectMojibake(["élève.txt"]), false);
  assert.equal(detectMojibake(["Łódź żółć.txt"]), false, "Latin Extended-A 不计入");
  assert.equal(detectMojibake(["tiếng Việt.md"]), false, "越南文 Latin Extended Additional 不计入");
});

test("F12 detectMojibake never flags Greek or Cyrillic names", () => {
  assert.equal(detectMojibake(["Σύνοψη.pdf"]), false);
  assert.equal(detectMojibake(["Привет мир.doc"]), false);
});

test("F12 detectMojibake tolerates legitimate punctuation runs", () => {
  assert.equal(detectMojibake(["report — final (v2).xlsx"]), false);
  assert.equal(detectMojibake(["a — b — c.txt"]), false, "破折号间有 ASCII 断开");
});

// ------------------------------------------------------------ buildMissingVolumeNames

test("F12 buildMissingVolumeNames renders .001-style split volumes", () => {
  const names = buildMissingVolumeNames({
    kind: "split",
    seriesStem: "movie.7z",
    partWidth: 3,
    missingParts: [2, 5],
    missingTotal: 2,
  });
  assert.deepEqual(names, ["movie.7z.002", "movie.7z.005"]);
});

test("F12 buildMissingVolumeNames renders .partN.rar volumes", () => {
  const names = buildMissingVolumeNames({
    kind: "rar-parts",
    seriesStem: "game",
    partWidth: 1,
    missingParts: [3],
    missingTotal: 1,
  });
  assert.deepEqual(names, ["game.part3.rar"]);
});

test("F12 buildMissingVolumeNames renders .z01-style zip volumes", () => {
  const names = buildMissingVolumeNames({
    kind: "zip-z",
    seriesStem: "photos",
    partWidth: 2,
    missingParts: [1, 12],
    missingTotal: 2,
  });
  assert.deepEqual(names, ["photos.z01", "photos.z12"]);
});

test("F12 buildMissingVolumeNames renders .rNN old-rar volumes (raw numbering)", () => {
  // rar-old 的 missingParts 是原始号：0 = 第二卷（.r00）
  const names = buildMissingVolumeNames({
    kind: "rar-old",
    seriesStem: "archive",
    partWidth: 2,
    missingParts: [0, 2],
    missingTotal: 2,
  });
  assert.deepEqual(names, ["archive.r00", "archive.r02"]);
});

test("F12 buildMissingVolumeNames pads to the selected file's width", () => {
  const names = buildMissingVolumeNames({
    kind: "split",
    seriesStem: "big.zip",
    partWidth: 4,
    missingParts: [7],
    missingTotal: 1,
  });
  assert.deepEqual(names, ["big.zip.0007"]);
});

test("F12 buildMissingVolumeNames degrades gracefully on unknown kind", () => {
  assert.deepEqual(buildMissingVolumeNames({ kind: "single", missingParts: [1] }), []);
  assert.deepEqual(buildMissingVolumeNames(null), []);
  assert.deepEqual(buildMissingVolumeNames({}), []);
});

// ------------------------------------------------------------ 后端 details 透传（源码级对账）

test("F12 services.attachMissingDetails is applied in preview and extract", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "app", "server", "lib", "services.js"),
    "utf8",
  );
  const occurrences = source.split("attachMissingDetails(error, archive)").length - 1;
  assert.ok(
    occurrences >= 2,
    `preview 与 extract 两条 MISSING_VOLUME 路径都应挂 details（找到 ${occurrences} 处）`,
  );
});

test("F12 api.js flattens error.details into the error response", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "app", "server", "api.js"),
    "utf8",
  );
  assert.ok(
    source.includes("...(error.details && typeof error.details === \"object\""),
    "api.js catch 应把 error.details 平铺进响应 error 对象",
  );
});

test("F12 archive-service exposes missingDetails on the inspect result", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { inspectArchive } = require("../app/server/lib/archive-service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-f12-"));
  try {
    for (const name of ["file.7z.001", "file.7z.003"]) {
      fs.writeFileSync(path.join(dir, name), "");
    }
    const archive = inspectArchive(path.join(dir, "file.7z.001"), {
      sevenZip: { path: "/nonexistent/7zzs", source: "bundled" },
    });
    assert.deepEqual(archive.missingParts, [2]);
    assert.equal(archive.missingTotal, 1);
    assert.equal(archive.missingTruncated, false);
    assert.ok(archive.missingDetails, "缺卷时必须带 missingDetails");
    assert.equal(archive.missingDetails.kind, "split");
    assert.equal(archive.missingDetails.seriesStem, "file.7z");
    assert.equal(archive.missingDetails.partWidth, 3);
    assert.equal(archive.missingDetails.firstVolumeName, "file.7z.001");
    assert.deepEqual(archive.missingDetails.missingParts, [2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F12 archive-service leaves missingDetails null when nothing is missing", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { inspectArchive } = require("../app/server/lib/archive-service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-f12-"));
  try {
    fs.writeFileSync(path.join(dir, "a.zip"), "");
    const archive = inspectArchive(path.join(dir, "a.zip"), {
      sevenZip: { path: "/nonexistent/7zzs", source: "bundled" },
    });
    assert.equal(archive.missingDetails, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
