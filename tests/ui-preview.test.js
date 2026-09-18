"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-preview");

const {
  MAX_HIGHLIGHT_LINES,
  MAX_PREVIEW_LINES,
  escapeHtml,
  formatTextPreview,
  getFileType,
  isPreviewable,
  revokeBlobUrl,
} = globalThis.CHzipPreview;

// ------------------------------------------------------------ escapeHtml

test("escapeHtml escapes markup but deliberately leaves quotes alone", () => {
  assert.equal(
    escapeHtml("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("1 < 2 > 0"), "1 &lt; 2 &gt; 0");
  // 引号必须保持原样：高亮的字符串字面量正则依赖它，
  // 一旦变成实体就再也匹配不到 "..." / '...' / `...`。
  assert.equal(escapeHtml('"quoted"'), '"quoted"');
  assert.equal(escapeHtml("it's"), "it's");
  assert.equal(escapeHtml("a\u00A0b"), "a&nbsp;b");
});

test("escapeHtml is a pure string transform and needs no DOM", () => {
  // 原实现每次都要 document.createElement("div")；这里在 Node 下无 document
  // 也必须能正常工作。
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(escapeHtml("plain"), "plain");
});

// ------------------------------------------------------------ 注入防护

test("formatTextPreview cannot be used to inject markup", () => {
  const html = formatTextPreview("<img src=x onerror=alert(1)>");
  assert.equal(html.includes("<img"), false, "不得输出未转义的标签");
  assert.equal(html.includes("onerror="), true, "文本内容本身应保留");
  assert.ok(html.includes("&lt;img"));
});

test("formatTextPreview neutralises a closing-span injection attempt", () => {
  const html = formatTextPreview('</span><script>alert("x")</script>');
  assert.equal(html.includes("<script"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("highlightSyntax keeps highlighting string literals after escaping", () => {
  const html = formatTextPreview('const name = "hello";');
  assert.ok(html.includes("syntax-keyword"), "const 应被识别为关键字");
  assert.ok(html.includes("syntax-string"), "字符串字面量仍应被高亮");
  assert.ok(html.includes('"hello"'));
});

// ------------------------------------------------------------ 行号与截断

test("formatTextPreview numbers lines with the original 4-width padding", () => {
  const html = formatTextPreview("a\nb");
  const rows = html.split("\n");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith('<span class="line-number">   1</span>'));
  assert.ok(rows[1].startsWith('<span class="line-number">   2</span>'));
});

test("formatTextPreview handles empty and nullish content", () => {
  assert.equal(formatTextPreview(""), "");
  assert.equal(formatTextPreview(null), "");
  assert.equal(formatTextPreview(undefined), "");
});

test("formatTextPreview truncates very large files and says so", () => {
  const content = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
  const html = formatTextPreview(content, { maxLines: 10, maxHighlightLines: 2 });
  const rows = html.split("\n");

  assert.equal(rows.length, 11, "10 行内容 + 1 行截断提示");
  assert.ok(rows[10].includes("仅显示前 10 行"));
  assert.ok(rows[10].includes("共 50 行"));
  assert.ok(rows[10].includes("复制按钮仍可复制全文"));
});

test("formatTextPreview does not truncate when the content fits", () => {
  const content = ["a", "b", "c"].join("\n");
  const html = formatTextPreview(content, { maxLines: 10 });
  assert.equal(html.split("\n").length, 3);
  assert.equal(html.includes("仅显示前"), false);
});

test("formatTextPreview only syntax-highlights the leading lines", () => {
  const content = ["const a = 1;", "const b = 2;"].join("\n");
  const html = formatTextPreview(content, { maxLines: 0, maxHighlightLines: 1 });
  const rows = html.split("\n");

  assert.ok(rows[0].includes("syntax-keyword"), "首行应高亮");
  assert.equal(rows[1].includes("syntax-keyword"), false, "超出高亮上限的行不应高亮");
  assert.ok(rows[1].includes("const b = 2;"), "但内容必须完整保留");
});

test("formatTextPreview defaults bound both lines and highlighting", () => {
  assert.ok(MAX_PREVIEW_LINES > 0 && MAX_PREVIEW_LINES <= 50000);
  assert.ok(MAX_HIGHLIGHT_LINES > 0 && MAX_HIGHLIGHT_LINES <= MAX_PREVIEW_LINES);
});

// ------------------------------------------------------------ 既有判定逻辑不受影响

test("file type helpers keep their behaviour", () => {
  assert.equal(getFileType("a.txt"), "text");
  assert.equal(getFileType("a.png"), "image");
  assert.equal(getFileType("a.bin"), "unknown");
  assert.equal(isPreviewable("a.txt", 1024), true);
  assert.equal(isPreviewable("a.txt", 11 * 1024 * 1024), false);
});

// ------------------------------------------------------------ blob URL 回收

test("revokeBlobUrl revokes the URL recorded on the preview image", () => {
  const revoked = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "URL");
  globalThis.URL = {
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  try {
    const container = {
      querySelector(selector) {
        return selector === ".preview-image"
          ? { dataset: { blobUrl: "blob:fake-1" } }
          : null;
      },
    };
    revokeBlobUrl(container);
    assert.deepEqual(revoked, ["blob:fake-1"]);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "URL", original);
    } else {
      delete globalThis.URL;
    }
  }
});

test("revokeBlobUrl is a no-op without a blob URL", () => {
  const revoked = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "URL");
  globalThis.URL = {
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  try {
    // 无图片（文本预览子树）
    revokeBlobUrl({ querySelector() { return null; } });
    // 有图片但没记 blobUrl
    revokeBlobUrl({ querySelector() { return { dataset: {} }; } });
    assert.deepEqual(revoked, []);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "URL", original);
    } else {
      delete globalThis.URL;
    }
  }
});

test("app.js revokes the previous blob URL before replacing preview content", () => {
  // 回归锁：previewFile 的两处 replaceChildren（图片/文本分支）之前必须
  // 先 revokeBlobUrl，否则连续预览图片每次都泄漏一个 blob URL。
  // 不模拟整个 app.js IIFE，直接锁源码顺序，比 DOM 仿真更稳。
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "app", "www", "js", "app.js"),
    "utf8",
  );
  const revokeAt = source.indexOf("uiPreview.revokeBlobUrl(els.previewBody)");
  const replaceAt = source.indexOf("els.previewBody.replaceChildren(container)");
  assert.ok(revokeAt !== -1, "previewFile 必须调用 revokeBlobUrl");
  assert.ok(replaceAt !== -1, "应存在图片分支的 replaceChildren");
  assert.ok(revokeAt < replaceAt, "revoke 必须在 replaceChildren 之前");
});
