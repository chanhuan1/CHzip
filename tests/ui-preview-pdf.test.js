"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-preview");

const {
  isPdfFile,
  isPreviewable,
  getFileType,
  formatPdfPreview,
} = globalThis.CHzipPreview;

// ------------------------------------------------------------------ PDF 判定

test("isPdfFile identifies .pdf case-insensitively", () => {
  assert.equal(isPdfFile("doc.pdf"), true);
  assert.equal(isPdfFile("doc.PDF"), true);
  assert.equal(isPdfFile("doc.pdfx"), false);
  assert.equal(isPdfFile("doc.txt"), false);
});

test("isPreviewable accepts PDF within size limit", () => {
  assert.equal(isPreviewable("doc.pdf", 1024), true);
  assert.equal(isPreviewable("doc.pdf", 10 * 1024 * 1024), true);
  assert.equal(isPreviewable("doc.pdf", 11 * 1024 * 1024), false);
});

test("getFileType returns 'pdf' for PDF files", () => {
  assert.equal(getFileType("doc.pdf"), "pdf");
  assert.equal(getFileType("doc.PDF"), "pdf");
  assert.equal(getFileType("doc.txt"), "text");
  assert.equal(getFileType("doc.png"), "image");
  assert.equal(getFileType("doc.bin"), "unknown");
});

// ------------------------------------------------------------------ PDF 预览元素

test("formatPdfPreview returns an iframe with blob URL in dataset", () => {
  const originalCreate = Object.getOwnPropertyDescriptor(globalThis, "URL");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.URL = {
    createObjectURL() {
      return "blob:fake-pdf";
    },
  };
  // formatPdfPreview 调 document.createElement 造 iframe——Node 测试需替身。
  // 用普通对象即可，断言只读 className/src/title/dataset。
  globalThis.document = {
    createElement() {
      return { className: "", dataset: {}, title: "", src: "", tagName: "IFRAME" };
    },
  };
  try {
    const blob = { type: "application/pdf" };
    const frame = formatPdfPreview(blob, "doc.pdf");
    assert.equal(frame.tagName, "IFRAME");
    assert.equal(frame.className, "preview-pdf");
    assert.equal(frame.src, "blob:fake-pdf");
    assert.equal(frame.dataset.blobUrl, "blob:fake-pdf");
  } finally {
    if (originalCreate) {
      Object.defineProperty(globalThis, "URL", originalCreate);
    } else {
      delete globalThis.URL;
    }
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      delete globalThis.document;
    }
  }
});
