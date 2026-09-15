"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  closeSourceDescriptors,
  fingerprintFiles,
  openSourceDescriptors,
  verifyFingerprints,
} = require("../app/server/lib/source");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chzip-source-"));
}

function writeFile(dir, name, content = "payload") {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function isSourceChanged(error) {
  return error.code === "SOURCE_CHANGED";
}

// ---------------------------------------------------------------- C13

test("C13 fingerprintFiles records dev/ino/size/mtime on the real path", () => {
  const dir = makeTempDir();
  const filePath = writeFile(dir, "a.7z", "hello");
  const linkPath = path.join(dir, "link.7z");
  fs.symlinkSync(filePath, linkPath);

  const [fingerprint] = fingerprintFiles([linkPath]);
  const stat = fs.statSync(filePath);

  assert.equal(fingerprint.path, fs.realpathSync(filePath), "符号链接要解析成真实路径");
  assert.equal(fingerprint.dev, stat.dev);
  assert.equal(fingerprint.ino, stat.ino);
  assert.equal(fingerprint.size, 5);
  assert.equal(fingerprint.mtimeMs, stat.mtimeMs);
});

test("C13 fingerprintFiles accepts an fsModule override", () => {
  const calls = [];
  const fsModule = {
    realpathSync: (target) => {
      calls.push(["realpathSync", target]);
      return "/resolved";
    },
    statSync: () => ({ dev: 1, ino: 2, size: 3, mtimeMs: 4 }),
  };

  assert.deepEqual(
    fingerprintFiles(["/raw"], { fsModule }),
    [{ path: "/resolved", dev: 1, ino: 2, size: 3, mtimeMs: 4 }],
  );
  assert.deepEqual(calls, [["realpathSync", "/raw"]]);
});

// 半途失败必须把已经打开的 fd 全部关掉，否则 worker 每失败一次就泄漏描述符。
test("C13 openSourceDescriptors closes already-opened descriptors on failure", () => {
  const dir = makeTempDir();
  const first = writeFile(dir, "a.7z");
  const missing = path.join(dir, "missing.7z");

  const closed = [];
  let opened = 0;
  const fsModule = {
    openSync: (target, flags) => {
      if (target === missing) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      opened += 1;
      return fs.openSync(target, flags);
    },
    closeSync: (fd) => {
      closed.push(fd);
      return fs.closeSync(fd);
    },
  };

  assert.throws(
    () => openSourceDescriptors([{ path: first }, { path: missing }], { fsModule }),
    /ENOENT/,
  );
  assert.equal(opened, 1);
  assert.equal(closed.length, 1, "已打开的 fd 必须被关掉");
});

test("C13 openSourceDescriptors opens every fingerprint", () => {
  const dir = makeTempDir();
  const fingerprints = [
    { path: writeFile(dir, "a.7z") },
    { path: writeFile(dir, "b.7z") },
  ];

  const descriptors = openSourceDescriptors(fingerprints);
  try {
    assert.equal(descriptors.length, 2);
    assert.ok(descriptors.every((fd) => Number.isInteger(fd)));
  } finally {
    closeSourceDescriptors(descriptors);
  }
});

test("C13 verifyFingerprints accepts an unchanged file", () => {
  const dir = makeTempDir();
  const filePath = writeFile(dir, "a.7z");
  const fingerprints = fingerprintFiles([filePath]);
  const descriptors = openSourceDescriptors(fingerprints);
  try {
    assert.doesNotThrow(() => verifyFingerprints(fingerprints, descriptors));
  } finally {
    closeSourceDescriptors(descriptors);
  }
});

test("C13 verifyFingerprints detects an in-place rewrite through the open fd", () => {
  const dir = makeTempDir();
  const filePath = writeFile(dir, "a.7z", "12345");
  const fingerprints = fingerprintFiles([filePath]);
  const descriptors = openSourceDescriptors(fingerprints);
  try {
    fs.truncateSync(filePath, 2);
    assert.throws(
      () => verifyFingerprints(fingerprints, descriptors),
      isSourceChanged,
    );
  } finally {
    closeSourceDescriptors(descriptors);
  }
});

test("C13 verifyFingerprints detects a deleted file when there is no descriptor", () => {
  const dir = makeTempDir();
  const filePath = writeFile(dir, "a.7z");
  const fingerprints = fingerprintFiles([filePath]);
  fs.rmSync(filePath);

  assert.throws(() => verifyFingerprints(fingerprints, []), isSourceChanged);
});

test("C13 verifyFingerprints detects a swapped file through the path", () => {
  const dir = makeTempDir();
  const filePath = writeFile(dir, "a.7z", "original");
  const fingerprints = fingerprintFiles([filePath]);

  const replacement = path.join(dir, "replacement");
  fs.writeFileSync(replacement, "totally-different-content");
  fs.renameSync(replacement, filePath);

  assert.throws(() => verifyFingerprints(fingerprints, []), isSourceChanged);
});

test("C13 verifyFingerprints accepts an empty fingerprint list", () => {
  assert.doesNotThrow(() => verifyFingerprints([], []));
  assert.doesNotThrow(() => verifyFingerprints(null, null));
});

test("C13 closeSourceDescriptors ignores already-closed descriptors", () => {
  assert.doesNotThrow(() => closeSourceDescriptors([]));
  assert.doesNotThrow(() => closeSourceDescriptors(null));
  assert.doesNotThrow(() => closeSourceDescriptors([-1, -2]));
});
