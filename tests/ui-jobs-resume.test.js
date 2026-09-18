"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-jobs");

const { resumePollers, pollTaskMini, pollTaskCenter, pollHistory, pollStatus }
  = globalThis.CHzipUiJobs;

// 与 ui-jobs.test.js 相同思路：用可控的假 document 满足 createPoller 的
// visibilitychange 订阅，测试结束恢复。
async function withFakeDocument(callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return { className: "", textContent: "", append() {} };
    },
  };
  try {
    return await callback();
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

// ------------------------------------------------------------ 轮询超时（D5）
// 卡死的 CGI 进程不该占住轮询循环 330s；四个轮询调用点都必须传
// POLL_TIMEOUT_MS 让 fetch 快速失败、由 createPoller 的 interval 重试。

const POLL_TIMEOUT_MS = 15000;

function recordingApi() {
  const calls = [];
  return {
    calls,
    POLL_TIMEOUT_MS,
    apiUrl(apiName) {
      return `/cgi/?api=${apiName}`;
    },
    async requestJson(url, options) {
      calls.push({ url, options });
      return { active: [], history: [] };
    },
  };
}

function createPollElements() {
  return {
    taskCenterDialog: { hidden: true },
    historyDialog: { hidden: true },
    taskCenterList: { /* 渲染分支需要真 DOM，置空即提前 return */ },
    historyList: null,
  };
}

test("pollTaskMini passes POLL_TIMEOUT_MS to the jobs poll", async () => {
  const api = recordingApi();
  const state = createState({ elements: { taskStreamList: null } });
  await pollTaskMini(state, api);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].options.timeoutMs, POLL_TIMEOUT_MS);
});

test("pollStatus passes POLL_TIMEOUT_MS to the status poll", async () => {
  const api = recordingApi();
  const state = createState({
    jobId: "a".repeat(32),
    elements: {
      progressFill: { style: {}, classList: { toggle() {} } },
      progressText: { textContent: "" },
      jobState: { textContent: "" },
      currentFile: { textContent: "" },
      progressEta: { hidden: true, textContent: "" },
      progressTrack: { classList: { toggle() {} } },
      taskStreamList: null,
    },
  });
  await pollStatus(state, api);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].options.timeoutMs, POLL_TIMEOUT_MS);
});

test("pollTaskCenter passes POLL_TIMEOUT_MS to the jobs poll", () => withFakeDocument(async () => {
  const api = recordingApi();
  // taskCenterList 为 falsy 时函数提前 return 不发请求；给个最小 DOM stub
  // 让它走完 requestJson 与渲染分支。
  const state = createState({
    elements: {
      taskCenterList: { replaceChildren() {}, append() {} },
      taskCenterEmpty: null,
      taskStreamList: null,
    },
  });
  await pollTaskCenter(state, api);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].options.timeoutMs, POLL_TIMEOUT_MS);
}));

test("pollHistory passes POLL_TIMEOUT_MS to the jobs poll", () => withFakeDocument(async () => {
  const api = recordingApi();
  const state = createState({
    elements: {
      historyList: { replaceChildren() {}, append() {} },
      clearHistoryBtn: null,
      historyEmpty: null,
    },
  });
  await pollHistory(state, api);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].options.timeoutMs, POLL_TIMEOUT_MS);
}));
