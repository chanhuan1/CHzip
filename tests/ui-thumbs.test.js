"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");

// ------------------------------------------------------------------ DOM 桩
// 复用 ui-tree.test.js 的 createElementStub 模式，但只保留缩略图墙需要的部分。

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
    get isConnected() {
      // 桩：只要还在父节点里就算 connected
      return element.parent !== null;
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

let thumbWall;
let thumbWallEmpty;

beforeEach(() => {
  thumbWall = createElementStub("div");
  thumbWallEmpty = createElementStub("div");
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: (tag) => createElementStub(tag),
    createDocumentFragment: () => createElementStub("fragment"),
  };
  globalThis.IntersectionObserver = class {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
    }
    observe(el) {
      this.observed.add(el);
    }
    unobserve(el) {
      this.observed.delete(el);
    }
    disconnect() {
      this.observed.clear();
    }
    // 测试辅助：模拟元素进入视口
    trigger(entries) {
      this.callback(entries.map((el) => ({
        target: el,
        isIntersecting: true,
      })), this);
    }
  };
});

// ui-thumbs 依赖 CHzipPreview（isImageFile / PREVIEW_MAX_SIZE 等）——
// 浏览器里由 <script> 顺序保证，Node 测试必须显式先挂载。
require("../app/www/js/ui-preview");
require("../app/www/js/ui-thumbs");

function createState(overrides = {}) {
  return {
    elements: {
      thumbWall,
      thumbWallEmpty,
    },
    entries: [],
    selectedPaths: new Set(),
    previewSolid: false,
    onPreviewFile: null,
    onThumbSelect: null,
    ...overrides,
  };
}

const IMAGE_ENTRIES = [
  { path: "photos/a.jpg", name: "a.jpg", type: "file", size: 1024 },
  { path: "photos/b.png", name: "b.png", type: "file", size: 2048 },
  { path: "docs/c.txt", name: "c.txt", type: "file", size: 512 },
  { path: "photos/encrypted.jpg", name: "encrypted.jpg", type: "file", size: 1024, encrypted: true },
];

// ------------------------------------------------------------------ 渲染

test("renderThumbWall renders only image files, skipping non-images and oversized", () => {
  const { renderThumbWall } = globalThis.CHzipUiThumbs;
  const state = createState({
    entries: [
      ...IMAGE_ENTRIES,
      { path: "huge.jpg", name: "huge.jpg", type: "file", size: 11 * 1024 * 1024 },
    ],
  });

  const wall = renderThumbWall(state, {
    api: { postApi: async () => ({ content: "" }) },
    uiPreview: globalThis.CHzipPreview,
    archivePath: "/fake.zip",
    getPassword: () => "",
    getCodePage: () => "auto",
  });

  const cells = flatten(thumbWall).filter((el) => el.classList.contains("thumb-cell"));
  assert.equal(cells.length, 3, "a.jpg / b.png / encrypted.jpg 应进墙，c.txt 和 huge.jpg 不进");
  assert.deepEqual(
    cells.map((c) => c.dataset.path).sort(),
    ["photos/a.jpg", "photos/b.png", "photos/encrypted.jpg"],
  );
  wall.dispose();
});

test("renderThumbWall shows solid-archive warning and returns no-op dispose", () => {
  const { renderThumbWall } = globalThis.CHzipUiThumbs;
  const state = createState({
    entries: IMAGE_ENTRIES,
    previewSolid: true,
  });

  const wall = renderThumbWall(state, {
    api: { postApi: async () => ({ content: "" }) },
    uiPreview: globalThis.CHzipPreview,
    archivePath: "/fake.zip",
    getPassword: () => "",
    getCodePage: () => "auto",
  });

  assert.equal(thumbWallEmpty.hidden, false);
  assert.ok(thumbWallEmpty.textContent.includes("固实"));
  assert.equal(typeof wall.dispose, "function");
  wall.dispose();
});

test("renderThumbWall shows empty message when no previewable images", () => {
  const { renderThumbWall } = globalThis.CHzipUiThumbs;
  const state = createState({
    entries: [{ path: "a.txt", name: "a.txt", type: "file", size: 10 }],
  });

  const wall = renderThumbWall(state, {
    api: { postApi: async () => ({ content: "" }) },
    uiPreview: globalThis.CHzipPreview,
    archivePath: "/fake.zip",
    getPassword: () => "",
    getCodePage: () => "auto",
  });

  assert.equal(thumbWallEmpty.hidden, false);
  assert.ok(thumbWallEmpty.textContent.includes("没有可预览的图片"));
  wall.dispose();
});

test("encrypted images are greyed out with lock badge", () => {
  const { renderThumbWall } = globalThis.CHzipUiThumbs;
  const state = createState({ entries: IMAGE_ENTRIES });

  const wall = renderThumbWall(state, {
    api: { postApi: async () => ({ content: "" }) },
    uiPreview: globalThis.CHzipPreview,
    archivePath: "/fake.zip",
    getPassword: () => "",
    getCodePage: () => "auto",
  });

  const encryptedCell = flatten(thumbWall).find(
    (el) => el.dataset.path === "photos/encrypted.jpg",
  );
  assert.ok(encryptedCell.classList.contains("is-encrypted"));
  const lock = encryptedCell.children
    .find((c) => c.classList.contains("thumb-frame"))
    .children.find((c) => c.classList.contains("thumb-lock"));
  assert.ok(lock, "加密 cell 应渲染锁标");
  wall.dispose();
});

// ------------------------------------------------------------------ 勾选

test("thumbnail checkbox toggles state.selectedPaths and fires onThumbSelect", () => {
  const { renderThumbWall } = globalThis.CHzipUiThumbs;
  const selected = [];
  const state = createState({
    entries: IMAGE_ENTRIES,
    selectedPaths: new Set(["photos/a.jpg"]),
    onThumbSelect: () => selected.push(Array.from(state.selectedPaths)),
  });

  const wall = renderThumbWall(state, {
    api: { postApi: async () => ({ content: "" }) },
    uiPreview: globalThis.CHzipPreview,
    archivePath: "/fake.zip",
    getPassword: () => "",
    getCodePage: () => "auto",
  });

  const cell = flatten(thumbWall).find((el) => el.dataset.path === "photos/a.jpg");
  const checkbox = cell.children.find((c) => c.classList.contains("thumb-checkbox"));
  assert.equal(checkbox.checked, true, "已选中的 cell 应渲染为勾选");

  checkbox.checked = false;
  checkbox.fire("change", { target: checkbox });
  assert.equal(state.selectedPaths.has("photos/a.jpg"), false);
  assert.equal(selected.length, 1);
  wall.dispose();
});

// ------------------------------------------------------------------ 点击预览

test("clicking a thumbnail cell routes to onPreviewFile", () => {
  const { renderThumbWall } = globalThis.CHzipUiThumbs;
  const opened = [];
  const state = createState({
    entries: IMAGE_ENTRIES,
    onPreviewFile: (path) => opened.push(path),
  });

  const wall = renderThumbWall(state, {
    api: { postApi: async () => ({ content: "" }) },
    uiPreview: globalThis.CHzipPreview,
    archivePath: "/fake.zip",
    getPassword: () => "",
    getCodePage: () => "auto",
  });

  const cell = flatten(thumbWall).find((el) => el.dataset.path === "photos/a.jpg");
  cell.fire("click", { target: cell, stopPropagation() {} });
  assert.deepEqual(opened, ["photos/a.jpg"]);
  wall.dispose();
});

// ------------------------------------------------------------------ 并发限流

test("createThumbQueue limits concurrency to the configured value", async () => {
  const { createThumbQueue } = globalThis.CHzipUiThumbs;
  let active = 0;
  let maxActive = 0;
  const results = [];

  const queue = createThumbQueue(2, async (task) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    results.push(task.id);
  });

  for (let i = 0; i < 5; i += 1) {
    queue.enqueue({ id: i });
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(maxActive, 2, "同时在途的任务数不应超过 2");
  assert.equal(results.length, 5, "所有任务最终都应完成");
});

// ------------------------------------------------------------------ LRU 缓存

test("createThumbCache evicts oldest entry and revokes its blob URL", () => {
  const { createThumbCache } = globalThis.CHzipUiThumbs;
  const revoked = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "URL");
  globalThis.URL = {
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };

  try {
    const cache = createThumbCache(2);
    cache.set("a", "blob:a");
    cache.set("b", "blob:b");
    assert.equal(cache.get("a"), "blob:a"); // 把 a 挪到末尾
    cache.set("c", "blob:c");               // 超容，应踢掉 b
    assert.equal(cache.get("b"), null);
    assert.deepEqual(revoked, ["blob:b"]);
    assert.equal(cache.size(), 2);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "URL", original);
    } else {
      delete globalThis.URL;
    }
  }
});

test("createThumbCache.clear revokes all cached URLs", () => {
  const { createThumbCache } = globalThis.CHzipUiThumbs;
  const revoked = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "URL");
  globalThis.URL = {
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };

  try {
    const cache = createThumbCache(10);
    cache.set("x", "blob:x");
    cache.set("y", "blob:y");
    cache.clear();
    assert.deepEqual(revoked.sort(), ["blob:x", "blob:y"]);
    assert.equal(cache.size(), 0);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "URL", original);
    } else {
      delete globalThis.URL;
    }
  }
});
