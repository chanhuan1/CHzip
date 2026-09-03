"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildTree,
  collectDescendantFiles,
  createSearchScheduler,
  filterTree,
  searchFiles,
  selectionState,
} = require("../app/www/js/tree");

test("buildTree creates correct directory structure", () => {
  const entries = [
    { path: "dir1/file1.txt", type: "file", size: 100 },
    { path: "dir1/file2.txt", type: "file", size: 200 },
    { path: "dir2/subdir/file3.txt", type: "file", size: 300 },
    { path: "rootfile.txt", type: "file", size: 50 },
  ];
  const tree = buildTree(entries);
  assert.equal(tree.length, 3);
  assert.equal(tree[0].name, "dir1");
  assert.equal(tree[0].type, "directory");
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[1].name, "dir2");
  assert.equal(tree[1].children.length, 1);
  assert.equal(tree[2].name, "rootfile.txt");
  assert.equal(tree[2].type, "file");
});

test("buildTree handles empty entries", () => {
  const tree = buildTree([]);
  assert.equal(tree.length, 0);
});

test("buildTree handles entries with backslashes", () => {
  const entries = [
    { path: "dir\\file.txt", type: "file", size: 100 },
  ];
  const tree = buildTree(entries);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, "dir");
  assert.equal(tree[0].children[0].name, "file.txt");
});

test("collectDescendantFiles returns all files under a node", () => {
  const entries = [
    { path: "dir/file1.txt", type: "file", size: 100 },
    { path: "dir/file2.txt", type: "file", size: 200 },
    { path: "dir/sub/file3.txt", type: "file", size: 300 },
  ];
  const tree = buildTree(entries);
  const files = collectDescendantFiles(tree[0]);
  assert.equal(files.length, 3);
  assert.ok(files.includes("dir/file1.txt"));
  assert.ok(files.includes("dir/file2.txt"));
  assert.ok(files.includes("dir/sub/file3.txt"));
});

test("collectDescendantFiles returns single file for file node", () => {
  const entries = [
    { path: "file.txt", type: "file", size: 100 },
  ];
  const tree = buildTree(entries);
  const files = collectDescendantFiles(tree[0]);
  assert.deepEqual(files, ["file.txt"]);
});

test("selectionState returns correct states", () => {
  const entries = [
    { path: "dir/file1.txt", type: "file", size: 100 },
    { path: "dir/file2.txt", type: "file", size: 200 },
  ];
  const tree = buildTree(entries);
  const node = tree[0];

  assert.equal(selectionState(node, new Set()), "unchecked");
  assert.equal(selectionState(node, new Set(["dir/file1.txt"])), "mixed");
  assert.equal(selectionState(node, new Set(["dir/file1.txt", "dir/file2.txt"])), "checked");
});

test("filterTree filters by query", () => {
  const entries = [
    { path: "dir/file1.txt", type: "file", size: 100 },
    { path: "dir/file2.log", type: "file", size: 200 },
    { path: "other/file3.txt", type: "file", size: 300 },
  ];
  const tree = buildTree(entries);
  const filtered = filterTree(tree, "file1");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, "dir");
  assert.equal(filtered[0].children.length, 1);
  assert.equal(filtered[0].children[0].name, "file1.txt");
});

test("filterTree returns all for empty query", () => {
  const entries = [
    { path: "dir/file1.txt", type: "file", size: 100 },
  ];
  const tree = buildTree(entries);
  const filtered = filterTree(tree, "");
  assert.equal(filtered.length, tree.length);
});

test("searchFiles finds matching files", () => {
  const entries = [
    { path: "dir/file1.txt", type: "file", size: 100 },
    { path: "dir/file2.log", type: "file", size: 200 },
    { path: "other/file3.txt", type: "file", size: 300 },
  ];
  const results = searchFiles(entries, ".txt");
  assert.equal(results.length, 2);
  assert.ok(results.some((e) => e.path === "dir/file1.txt"));
  assert.ok(results.some((e) => e.path === "other/file3.txt"));
});

test("searchFiles returns empty for no matches", () => {
  const entries = [
    { path: "dir/file1.txt", type: "file", size: 100 },
  ];
  const results = searchFiles(entries, ".xyz");
  assert.equal(results.length, 0);
});

test("createSearchScheduler schedules callbacks", () => {
  return new Promise((resolve, reject) => {
    const scheduler = createSearchScheduler({ delay: 50 });
    let called = false;
    const generation = scheduler.schedule(() => {
      called = true;
      try {
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    assert.equal(scheduler.isCurrent(generation), true);
    setTimeout(() => {
      if (!called) {
        reject(new Error("Callback was not called"));
      }
    }, 200);
  });
});

test("createSearchScheduler cancels pending callbacks", () => {
  return new Promise((resolve, reject) => {
    const scheduler = createSearchScheduler({ delay: 50 });
    let called = false;
    scheduler.schedule(() => {
      called = true;
    });
    scheduler.cancel();
    setTimeout(() => {
      if (called) {
        reject(new Error("Callback should have been cancelled"));
      } else {
        resolve();
      }
    }, 100);
  });
});
