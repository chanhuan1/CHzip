"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createServices } = require("../app/server/lib/services");
const { runSevenZipSync } = require("../app/server/lib/engine");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chzip-pdf-preview-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFakeTool(name, body) {
  const scriptPath = path.join(tmpDir, name);
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeArchive(name = "a.zip") {
  const archivePath = path.join(tmpDir, name);
  fs.writeFileSync(archivePath, "fake-archive");
  return archivePath;
}

function createPreviewServices(toolPath, overrides = {}) {
  return createServices({
    runtimeRoot: tmpDir,
    findTool: () => ({ path: toolPath, source: "test" }),
    runSync: runSevenZipSync,
    discoverRoots: () => [{ path: tmpDir, canBrowse: true, canSelect: true }],
    ...overrides,
  });
}

test("previewFile returns base64 encoding for PDF files", async () => {
  const tool = writeFakeTool("pdf.sh", "printf '\\x25\\x50\\x44\\x46'"); // %PDF
  const archivePath = writeArchive();
  const services = createPreviewServices(tool, { previewFileTimeoutMs: 10 * 1000 });

  const result = await services.previewFile({
    path: archivePath,
    targetPath: "inner.pdf",
  });
  assert.equal(result.encoding, "base64");
  assert.equal(Buffer.from(result.content, "base64").toString("utf8"), "%PDF");
});

test("previewFile keeps binary PDF bytes intact (encoding null)", async () => {
  const tool = writeFakeTool("pdfbin.sh", "printf '\\x25\\x50\\x44\\x46\\x00\\xFF'");
  const archivePath = writeArchive();
  const services = createPreviewServices(tool, { previewFileTimeoutMs: 10 * 1000 });

  const result = await services.previewFile({
    path: archivePath,
    targetPath: "inner.pdf",
  });
  assert.equal(result.encoding, "base64");
  assert.equal(
    Buffer.from(result.content, "base64").toString("hex"),
    "2550444600ff",
  );
});
