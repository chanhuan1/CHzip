"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildTree,
  collectDescendantFiles,
  computeSelectionCounts,
  createSearchScheduler,
  filterTree,
  searchFiles,
  selectionState,
  stateFromCounts,
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

// ------------------------------------------- 预聚合选中计数（等价性）

test("computeSelectionCounts aggregates per subtree", () => {
  const entries = [
    { path: "a/1.txt", type: "file", size: 1 },
    { path: "a/2.txt", type: "file", size: 1 },
    { path: "a/sub/3.txt", type: "file", size: 1 },
    { path: "b/4.txt", type: "file", size: 1 },
  ];
  const tree = buildTree(entries);
  const selected = new Set(["a/1.txt", "a/sub/3.txt"]);
  const counts = computeSelectionCounts(tree, selected);

  const a = tree.find((node) => node.path === "a");
  assert.deepEqual(counts.get(a), { fileCount: 3, selectedCount: 2 });
  assert.equal(selectionState(a, selected, counts), "mixed");

  const sub = a.children.find((node) => node.path === "a/sub");
  assert.deepEqual(counts.get(sub), { fileCount: 1, selectedCount: 1 });
  assert.equal(selectionState(sub, selected, counts), "checked");

  const b = tree.find((node) => node.path === "b");
  assert.deepEqual(counts.get(b), { fileCount: 1, selectedCount: 0 });
  assert.equal(selectionState(b, selected, counts), "unchecked");

  const rootFile = b.children.find((node) => node.path === "b/4.txt");
  assert.deepEqual(counts.get(rootFile), { fileCount: 1, selectedCount: 0 });
});

test("stateFromCounts mirrors the original tri-state rules", () => {
  assert.equal(stateFromCounts(null), "unchecked");
  assert.equal(stateFromCounts({ fileCount: 0, selectedCount: 0 }), "unchecked");
  assert.equal(stateFromCounts({ fileCount: 3, selectedCount: 0 }), "unchecked");
  assert.equal(stateFromCounts({ fileCount: 3, selectedCount: 3 }), "checked");
  assert.equal(stateFromCounts({ fileCount: 3, selectedCount: 1 }), "mixed");
});

function createRandom(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

test("computeSelectionCounts agrees with the legacy recursion on random trees", () => {
  const random = createRandom(20260914);

  for (let round = 0; round < 25; round += 1) {
    const entries = [];
    const directoryCount = 1 + Math.floor(random() * 4);
    for (let d = 0; d < directoryCount; d += 1) {
      const dir = `dir${d}`;
      const fileCount = 1 + Math.floor(random() * 5);
      for (let f = 0; f < fileCount; f += 1) {
        entries.push({ path: `${dir}/f${f}.txt`, type: "file", size: f });
      }
      if (random() > 0.5) {
        entries.push({ path: `${dir}/sub/deep/g.txt`, type: "file", size: 1 });
      }
    }

    const tree = buildTree(entries);
    const allFiles = entries.map((entry) => entry.path);
    const selected = new Set(allFiles.filter(() => random() > 0.4));
    const counts = computeSelectionCounts(tree, selected);

    const visit = (node) => {
      const legacy = selectionState(node, selected);
      const fast = selectionState(node, selected, counts);
      assert.equal(
        fast,
        legacy,
        `节点 ${node.path} 的选中状态应与旧实现一致`,
      );
      for (const child of node.children || []) {
        visit(child);
      }
    };
    for (const node of tree) {
      visit(node);
    }
  }
});

test("selectionState without counts keeps the legacy behaviour", () => {
  const entries = [
    { path: "a/1.txt", type: "file", size: 1 },
    { path: "a/2.txt", type: "file", size: 1 },
  ];
  const tree = buildTree(entries);
  const a = tree[0];

  assert.equal(selectionState(a, new Set()), "unchecked");
  assert.equal(selectionState(a, new Set(["a/1.txt"])), "mixed");
  assert.equal(selectionState(a, new Set(["a/1.txt", "a/2.txt"])), "checked");
});

