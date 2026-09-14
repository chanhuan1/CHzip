"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");

const { buildTree } = require("../app/www/js/tree");

// ------------------------------------------------------------------ DOM 桩
//
// ui-tree.js 是原生 DOM 代码，Node 里没有 DOM。这里搭一个刚好够用的桩，
// 用来冒烟验证渲染流程（行数、复选框三态、分批渲染、事件委托），
// 避免重写文件后出现只在浏览器里才暴露的低级错误。

function createElementStub(tagName) {
  const classes = new Set();
  const element = {
    tagName: String(tagName).toUpperCase(),
    parent: null,
    children: [],
    title: "",
    textContent: "",
    innerHTML: "",
    tabIndex: 0,
    type: "",
    checked: false,
    indeterminate: false,
    disabled: false,
    hidden: false,
    dataset: {},
    attributes: {},
    listeners: new Map(),
    style: {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    },
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return on;
      },
    },
    addEventListener(type, handler) {
      const list = element.listeners.get(type) || [];
      list.push(handler);
      element.listeners.set(type, list);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return element.attributes[name];
    },
    append(...nodes) {
      for (const node of nodes) {
        // 真实 DOM 里 append(fragment) 会把 fragment 的子节点搬进来，
        // fragment 自身不入树。桩必须复刻这一点。
        if (node.tagName === "FRAGMENT") {
          for (const child of node.children.slice()) {
            child.parent = element;
            element.children.push(child);
          }
          node.children = [];
          continue;
        }
        node.parent = element;
        element.children.push(node);
      }
    },
    appendChild(node) {
      element.append(node);
      return node;
    },
    replaceChildren(...nodes) {
      element.children = [];
      element.append(...nodes);
    },
    remove() {
      if (element.parent) {
        element.parent.children = element.parent.children.filter(
          (child) => child !== element,
        );
        element.parent = null;
      }
    },
    querySelector() {
      return null;
    },
    closest(selector) {
      const name = selector.startsWith(".") ? selector.slice(1) : null;
      if (!name) {
        return null;
      }
      let node = element;
      while (node) {
        if (node.classList.contains(name)) {
          return node;
        }
        node = node.parent;
      }
      return null;
    },
    fire(type, event) {
      for (const handler of element.listeners.get(type) || []) {
        handler(event);
      }
    },
  };
  Object.defineProperty(element, "className", {
    get() {
      return Array.from(classes).join(" ");
    },
    set(value) {
      classes.clear();
      String(value || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    },
  });
  return element;
}

function flatten(element) {
  const out = [];
  for (const child of element.children) {
    out.push(child);
    out.push(...flatten(child));
  }
  return out;
}

function rowsOf(container) {
  return container.children.filter((child) => child.classList.contains("tree-row"));
}

// 按路径在树里查找节点（目录或文件）。
function findNode(tree, path) {
  for (const node of tree || []) {
    if (node.path === path) {
      return node;
    }
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

let fileTree;
// null 表示"帧同步执行"（多数用例只关心最终结构）；
// 数组表示"手动排队"，用于验证跨帧的分批渲染行为。
let manualFrames = null;

beforeEach(() => {
  fileTree = createElementStub("div");
  manualFrames = null;
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: (tag) => createElementStub(tag),
    createDocumentFragment: () => createElementStub("fragment"),
  };
  globalThis.window.requestAnimationFrame = (callback) => {
    if (manualFrames) {
      manualFrames.push(callback);
      return;
    }
    callback();
  };
});

// 切到手动帧模式，返回一个可以按帧推进的控制器。
function enableManualFrames() {
  manualFrames = [];
  return {
    flush(limit = 10000) {
      let count = 0;
      while (manualFrames.length && count < limit) {
        manualFrames.shift()();
        count += 1;
      }
    },
    pending() {
      return manualFrames.length;
    },
  };
}

// ui-tree.js 只在加载时把 API 挂到全局；每个用例自己新建一棵树容器，
// 模块级的委托监听集合是按容器记录的，因此不需要重新加载模块。
require("../app/www/js/ui-tree");

function createState(overrides = {}) {
  return {
    elements: {
      fileTree,
      selectionSummary: createElementStub("span"),
      selectAllInput: createElementStub("input"),
      treeSearchInput: { value: "", disabled: false },
    },
    entries: [],
    tree: [],
    selectedPaths: new Set(),
    expandedPaths: new Set(),
    allFilePaths: [],
    previewableFiles: new Set(),
    previewReady: true,
    previewLimited: false,
    searchRenderId: 0,
    onAvailabilityChange: null,
    ...overrides,
  };
}

const ENTRIES = [
  { path: "dir1/a.txt", type: "file", size: 10 },
  { path: "dir1/b.txt", type: "file", size: 20 },
  { path: "dir2/sub/c.txt", type: "file", size: 30 },
];

test("renderTree renders only the visible (expanded) part of the tree", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
  });

  renderTree(state, globalThis.CHzipTree);

  // 顶层 dir1 / dir2 默认折叠 → 只有 2 行
  assert.equal(rowsOf(fileTree).length, 2);
  assert.deepEqual(
    rowsOf(fileTree).map((row) => row.dataset.path),
    ["dir1", "dir2"],
  );
});

test("renderTree shows children once a directory is expanded", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
    expandedPaths: new Set(["dir1"]),
  });

  renderTree(state, globalThis.CHzipTree);

  assert.deepEqual(
    rowsOf(fileTree).map((row) => row.dataset.path),
    ["dir1", "dir1/a.txt", "dir1/b.txt", "dir2"],
  );
});

test("renderTree marks checkbox tri-state from the selection set", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
    expandedPaths: new Set(["dir1"]),
    selectedPaths: new Set(["dir1/a.txt"]),
  });

  renderTree(state, globalThis.CHzipTree);

  const checkboxes = new Map();
  for (const row of rowsOf(fileTree)) {
    const checkbox = row.children.find((child) => child.classList.contains("tree-checkbox"));
    checkboxes.set(row.dataset.path, checkbox);
  }

  assert.equal(checkboxes.get("dir1").indeterminate, true, "部分选中应显示半选");
  assert.equal(checkboxes.get("dir1").checked, false);
  assert.equal(checkboxes.get("dir1/a.txt").checked, true);
  assert.equal(checkboxes.get("dir1/b.txt").checked, false);
  assert.equal(checkboxes.get("dir2").checked, false);
  assert.equal(checkboxes.get("dir2").indeterminate, false);
});

test("renderTree shows the empty and limited placeholders", () => {
  const { renderTree } = globalThis.CHzipUiTree;

  const empty = createState({ previewReady: false });
  renderTree(empty, globalThis.CHzipTree);
  assert.equal(rowsOf(fileTree).length, 0);
  assert.equal(fileTree.children[0].textContent, "尚未载入压缩包目录");

  fileTree.replaceChildren();
  const limited = createState({ previewLimited: true });
  renderTree(limited, globalThis.CHzipTree);
  assert.equal(rowsOf(fileTree).length, 0);
  assert.equal(
    fileTree.children[0].textContent,
    "压缩包内容超过预览限制，将按整包方式解压。",
  );
});

test("renderTree adds a preview button only for previewable files", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
    expandedPaths: new Set(["dir1"]),
    previewableFiles: new Set(["dir1/a.txt"]),
  });

  renderTree(state, globalThis.CHzipTree);

  const withButton = rowsOf(fileTree).filter((row) => (
    row.children.some((child) => child.classList.contains("tree-preview-btn"))
  ));
  assert.deepEqual(withButton.map((row) => row.dataset.path), ["dir1/a.txt"]);
});

test("delegated checkbox change updates only the affected checkboxes", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const treeApi = globalThis.CHzipTree;
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
    expandedPaths: new Set(["dir1"]),
  });

  renderTree(state, treeApi);

  const rowByPath = new Map(rowsOf(fileTree).map((row) => [row.dataset.path, row]));
  const checkboxOf = (path) => rowByPath
    .get(path)
    .children.find((child) => child.classList.contains("tree-checkbox"));

  // 勾选 dir1（含 a.txt / b.txt）
  const dir1Checkbox = checkboxOf("dir1");
  dir1Checkbox.checked = true;
  fileTree.fire("change", { target: dir1Checkbox });

  assert.deepEqual(
    Array.from(state.selectedPaths).sort(),
    ["dir1/a.txt", "dir1/b.txt"],
  );
  assert.equal(checkboxOf("dir1").checked, true);
  assert.equal(checkboxOf("dir1").indeterminate, false);
  assert.equal(checkboxOf("dir1/a.txt").checked, true, "子节点复选框应同步");
  assert.equal(checkboxOf("dir1/b.txt").checked, true);
  assert.ok(state.elements.selectionSummary.textContent.includes("已选择 2 / 3"));

  // 取消其中一个子文件 → 目录应变成半选
  const aCheckbox = checkboxOf("dir1/a.txt");
  aCheckbox.checked = false;
  fileTree.fire("change", { target: aCheckbox });

  assert.deepEqual(Array.from(state.selectedPaths), ["dir1/b.txt"]);
  assert.equal(checkboxOf("dir1").indeterminate, true);
  assert.equal(checkboxOf("dir1").checked, false);
});

test("delegated toggle click expands and collapses without rebuilding rows", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const treeApi = globalThis.CHzipTree;
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
  });

  renderTree(state, treeApi);
  assert.equal(rowsOf(fileTree).length, 2);

  const dir1Row = rowsOf(fileTree).find((row) => row.dataset.path === "dir1");
  const toggle = dir1Row.children.find((child) => child.classList.contains("tree-toggle"));
  fileTree.fire("click", { target: toggle, stopPropagation() {} });

  assert.deepEqual(Array.from(state.expandedPaths), ["dir1"]);
  assert.equal(rowsOf(fileTree).length, 4, "展开后应出现子行");

  const toggleAgain = rowsOf(fileTree)
    .find((row) => row.dataset.path === "dir1")
    .children.find((child) => child.classList.contains("tree-toggle"));
  fileTree.fire("click", { target: toggleAgain, stopPropagation() {} });

  assert.equal(state.expandedPaths.size, 0);
  assert.equal(rowsOf(fileTree).length, 2);
});

test("delegated preview click routes to onPreviewFile", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const treeApi = globalThis.CHzipTree;
  const opened = [];
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
    expandedPaths: new Set(["dir1"]),
    previewableFiles: new Set(["dir1/a.txt"]),
    onPreviewFile: (path) => opened.push(path),
  });

  renderTree(state, treeApi);

  const button = flatten(fileTree).find((el) => el.classList.contains("tree-preview-btn"));
  assert.ok(button, "应渲染出预览按钮");
  fileTree.fire("click", { target: button, stopPropagation() {} });

  assert.deepEqual(opened, ["dir1/a.txt"]);
});

test("search mode renders one flat row per matching file", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const treeApi = globalThis.CHzipTree;
  const state = createState({
    entries: ENTRIES,
    tree: buildTree(ENTRIES),
    allFilePaths: ENTRIES.map((entry) => entry.path),
  });
  state.elements.treeSearchInput.value = "c.txt";

  renderTree(state, treeApi);

  const rows = rowsOf(fileTree);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.path, "dir2/sub/c.txt");
  assert.ok(rows[0].classList.contains("tree-search-row"));
});

test("setPreviewControls toggles the search and select-all inputs", () => {
  const { setPreviewControls } = globalThis.CHzipUiTree;
  const state = createState();

  setPreviewControls(false, state);
  assert.equal(state.elements.selectAllInput.disabled, true);
  assert.equal(state.elements.treeSearchInput.disabled, true);

  setPreviewControls(true, state);
  assert.equal(state.elements.selectAllInput.disabled, false);
  assert.equal(state.elements.treeSearchInput.disabled, false);
});

// ------------------------------------------- 分批渲染期间改勾选

function checkboxOfRow(row) {
  return row.children.find((child) => child.classList.contains("tree-checkbox"));
}

test("renderTree renders large trees across multiple frames", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const entries = Array.from({ length: 300 }, (_, index) => ({
    path: `big/f${String(index).padStart(3, "0")}.txt`,
    type: "file",
    size: 1,
  }));
  const state = createState({
    entries,
    tree: buildTree(entries),
    allFilePaths: entries.map((entry) => entry.path),
    expandedPaths: new Set(["big"]),
  });

  const frames = enableManualFrames();
  renderTree(state, globalThis.CHzipTree);

  assert.ok(frames.pending() > 0, "大目录应分批渲染，而不是一次性同步建完");
  assert.equal(rowsOf(fileTree).length, 0, "renderTree 返回时首批尚未渲染");

  frames.flush();
  assert.equal(rowsOf(fileTree).length, 301, "1 个目录 + 300 个文件");
});

test("a selection change mid-render is honoured by the remaining batches", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const treeApi = globalThis.CHzipTree;
  const entries = Array.from({ length: 300 }, (_, index) => ({
    path: `big/f${String(index).padStart(3, "0")}.txt`,
    type: "file",
    size: 1,
  }));
  const state = createState({
    entries,
    tree: buildTree(entries),
    allFilePaths: entries.map((entry) => entry.path),
    expandedPaths: new Set(["big"]),
  });

  const frames = enableManualFrames();
  renderTree(state, treeApi);
  // 只推进第一批（目录行 + 199 个文件），渲染尚未结束
  frames.flush(1);
  assert.ok(frames.pending() > 0, "此时应还有未渲染的批次");
  assert.ok(rowsOf(fileTree).length < 301);

  // 渲染未完成时勾选整个目录
  const dirRow = rowsOf(fileTree).find((row) => row.dataset.path === "big");
  const dirCheckbox = checkboxOfRow(dirRow);
  dirCheckbox.checked = true;
  fileTree.fire("change", { target: dirCheckbox });

  assert.equal(state.selectedPaths.size, 300, "目录下 300 个文件应全部选中");

  // 补齐剩余批次
  frames.flush();

  const rows = rowsOf(fileTree);
  assert.equal(rows.length, 301);

  // 每一行的复选框状态都必须与选中集合一致 —— 若后续批次用了过期的
  // 选中计数，这里会出现大量不一致。
  // 注意：目录行的选中态不由 selectedPaths.has(目录路径) 决定（selectedPaths
  // 只含文件路径），而是由后代文件的选中比例决定。对目录节点，用
  // treeApi.selectionState 算出期望的三态，再与复选框比对。
  const mismatched = rows.filter((row) => {
    const path = row.dataset.path;
    const checkbox = checkboxOfRow(row);
    const node = findNode(state.tree, path);
    if (node && node.type === "directory") {
      const expected = treeApi.selectionState(node, state.selectedPaths);
      const checkedOk = checkbox.checked === (expected === "checked");
      const indeterminateOk = Boolean(checkbox.indeterminate) === (expected === "mixed");
      return !(checkedOk && indeterminateOk);
    }
    return checkbox.checked !== state.selectedPaths.has(path);
  });
  assert.equal(
    mismatched.length,
    0,
    `${mismatched.length} 行复选框与选中集合不一致（首批之后渲染的行用了过期计数）`,
  );
});

test("a mid-render deselection is also honoured by the remaining batches", () => {
  const { renderTree } = globalThis.CHzipUiTree;
  const treeApi = globalThis.CHzipTree;
  const entries = Array.from({ length: 300 }, (_, index) => ({
    path: `big/f${String(index).padStart(3, "0")}.txt`,
    type: "file",
    size: 1,
  }));
  const state = createState({
    entries,
    tree: buildTree(entries),
    allFilePaths: entries.map((entry) => entry.path),
    expandedPaths: new Set(["big"]),
    selectedPaths: new Set(entries.map((entry) => entry.path)),
  });

  const frames = enableManualFrames();
  renderTree(state, treeApi);
  frames.flush(1);

  const dirRow = rowsOf(fileTree).find((row) => row.dataset.path === "big");
  const dirCheckbox = checkboxOfRow(dirRow);
  dirCheckbox.checked = false;
  fileTree.fire("change", { target: dirCheckbox });

  assert.equal(state.selectedPaths.size, 0);

  frames.flush();

  const rows = rowsOf(fileTree);
  const stillChecked = rows.filter((row) => checkboxOfRow(row).checked);
  assert.equal(stillChecked.length, 0, "取消勾选后不应还有行显示为已勾选");
});

