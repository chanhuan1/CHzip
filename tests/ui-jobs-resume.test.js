"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-jobs");

const { resumePollers } = globalThis.CHzipUiJobs;

// 与 ui-jobs.test.js 相同思路：用可控的假 document 满足 createPoller 的
// visibilitychange 订阅，测试结束恢复。
function withFakeDocument(callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    callback();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "document", original);
    } else {
      delete globalThis.document;
    }
  }
}

function createState(overrides = {}) {
  return {
    pollTimer: null,
    taskWatchTimer: null,
    taskCenterTimer: null,
    historyTimer: null,
    jobId: null,
    running: false,
    taskCenterOpen: false,
    historyOpen: false,
    elements: {
      taskCenterDialog: { hidden: true },
      historyDialog: { hidden: true },
      historyList: null,
    },
    ...overrides,
  };
}

function createApi() {
  return {
    apiUrl(apiName) {
      return `/cgi/?api=${apiName}`;
    },
    async requestJson() {
      return { active: [], history: [] };
    },
  };
}

test("resumePollers ignores non-persisted pageshow", () => withFakeDocument(() => {
  const state = createState({ jobId: "a".repeat(32), running: true });
  resumePollers(state, createApi(), { persisted: false });
  assert.equal(state.pollTimer, null);
  assert.equal(state.taskWatchTimer, null);
}));

test("resumePollers restarts an in-flight job poller after bfcache restore", () => withFakeDocument(() => {
  const state = createState({ jobId: "a".repeat(32), running: true });
  resumePollers(state, createApi(), { persisted: true });
  assert.ok(state.pollTimer, "应重建任务状态轮询器");
  assert.ok(state.taskWatchTimer, "应重启常驻监听");
  state.pollTimer.stop();
  state.taskWatchTimer.stop();
}));

test("resumePollers leaves the job poller alone when no job is running", () => withFakeDocument(() => {
  const state = createState();
  resumePollers(state, createApi(), { persisted: true });
  assert.equal(state.pollTimer, null, "无任务时不建任务轮询器");
  assert.ok(state.taskWatchTimer, "常驻监听仍要恢复");
  state.taskWatchTimer.stop();
}));

test("resumePollers does not stack a poller that already exists", () => withFakeDocument(() => {
  const existing = { stop() {}, start() {} };
  const state = createState({
    jobId: "a".repeat(32),
    running: true,
    pollTimer: existing,
    taskWatchTimer: existing,
  });
  resumePollers(state, createApi(), { persisted: true });
  assert.equal(state.pollTimer, existing, "已有轮询器不被替换");
  assert.equal(state.taskWatchTimer, existing, "常驻监听不被重复启动");
}));

test("resumePollers reopens polling for dialogs that are still open", () => withFakeDocument(() => {
  const state = createState({ taskCenterOpen: true, historyOpen: true });
  resumePollers(state, createApi(), { persisted: true });
  assert.ok(state.taskCenterTimer, "任务中心开着就要恢复其轮询");
  assert.ok(state.historyTimer, "历史弹窗开着就要恢复其轮询");
  state.taskCenterTimer.stop();
  state.historyTimer.stop();
  state.taskWatchTimer.stop();
}));

test("resumePollers skips dialogs that are closed", () => withFakeDocument(() => {
  const state = createState();
  resumePollers(state, createApi(), { persisted: true });
  assert.equal(state.taskCenterTimer, null);
  assert.equal(state.historyTimer, null);
  state.taskWatchTimer.stop();
}));
