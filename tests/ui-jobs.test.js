"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-jobs");

const {
  HIDDEN_POLL_INTERVAL_MS,
  IDLE_BACKOFF_MS,
  createPoller,
  formatTaskDateTime,
  setJobProgress,
} = globalThis.CHzipUiJobs;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// setJobProgress 只用到这几个 DOM 属性，够用就行。
function createProgressStub() {
  const classList = () => ({ toggle() {} });
  return {
    progressFill: { style: {}, classList: classList() },
    progressText: { textContent: "" },
    jobState: { textContent: "" },
    currentFile: { textContent: "" },
    progressEta: { hidden: true, textContent: "" },
    progressTrack: { classList: classList() },
  };
}

// 用可控的假 document 驱动可见性逻辑，并在结束后恢复，避免污染其它用例。
async function withFakeDocument(initialState, callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const listeners = new Map();
  globalThis.document = {
    visibilityState: initialState,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  try {
    await callback({
      setVisibility(value) {
        globalThis.document.visibilityState = value;
      },
      fire(type) {
        const handler = listeners.get(type);
        if (handler) {
          handler();
        }
      },
      hasListener(type) {
        return listeners.has(type);
      },
    });
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "document", original);
    } else {
      delete globalThis.document;
    }
  }
}

test("formatTaskDateTime renders full local date and time", () => {
  const iso = new Date(2026, 8, 12, 22, 14, 3).toISOString();
  assert.equal(formatTaskDateTime(iso), "2026-09-12 22:14:03");
});

test("formatTaskDateTime zero-pads every segment", () => {
  const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  assert.equal(formatTaskDateTime(iso), "2026-01-02 03:04:05");
});

test("formatTaskDateTime returns empty string for missing or invalid input", () => {
  assert.equal(formatTaskDateTime(""), "");
  assert.equal(formatTaskDateTime(null), "");
  assert.equal(formatTaskDateTime(undefined), "");
  assert.equal(formatTaskDateTime("not-a-date"), "");
});

test("formatTaskDateTime keeps the calendar date across midnight", () => {
  const iso = new Date(2026, 11, 31, 23, 59, 59).toISOString();
  assert.equal(formatTaskDateTime(iso), "2026-12-31 23:59:59");
});

test("createPoller never lets two requests overlap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const poller = createPoller(async () => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(20);
    inFlight -= 1;
  }, { interval: 1 });

  poller.start();
  await sleep(140);
  poller.stop();

  assert.equal(maxInFlight, 1, "任何时刻最多一个在途请求");
  assert.ok(calls >= 3, `应持续轮询，实际 ${calls} 次`);
  assert.ok(
    calls <= 8,
    `20ms 的请求在 140ms 内不应超过 8 次（setInterval 会堆积成更多），实际 ${calls}`,
  );
});

test("createPoller stop() halts the loop and is idempotent", async () => {
  let calls = 0;
  const poller = createPoller(() => {
    calls += 1;
  }, { interval: 1 });

  poller.start();
  await sleep(20);
  poller.stop();
  poller.stop();

  const after = calls;
  assert.ok(after >= 1);
  assert.equal(poller.isRunning(), false);
  await sleep(40);
  assert.equal(calls, after, "stop() 之后不应再有 tick");
});

test("createPoller start() is idempotent and does not stack timers", async () => {
  let calls = 0;
  const poller = createPoller(() => {
    calls += 1;
  }, { interval: 5 });

  poller.start();
  poller.start();
  poller.start();
  await sleep(40);
  poller.stop();

  assert.ok(
    calls <= 12,
    `重复 start() 不应叠加定时器，实际 ${calls} 次`,
  );
});

test("createPoller keeps polling after a tick throws", async () => {
  let calls = 0;
  const poller = createPoller(() => {
    calls += 1;
    if (calls === 1) {
      throw new Error("boom");
    }
  }, { interval: 1 });

  poller.start();
  await sleep(40);
  poller.stop();

  assert.ok(calls >= 2, `单次异常后应继续轮询，实际 ${calls} 次`);
});

test("createPoller re-evaluates the interval function after every tick", async () => {
  const observed = [];
  let ticks = 0;
  const poller = createPoller(() => {
    ticks += 1;
  }, {
    interval: () => {
      observed.push(ticks);
      return 1;
    },
  });

  poller.start();
  await sleep(40);
  poller.stop();

  assert.ok(observed.length >= 2, "每轮都应重新求值 interval");
  assert.ok(
    observed[1] > observed[0],
    "interval 应在 tick 之后求值，这样退避阶梯才能生效",
  );
});

test("createPoller slows down while the page is hidden and wakes on return", async () => {
  await withFakeDocument("hidden", async (doc) => {
    let calls = 0;
    const poller = createPoller(() => {
      calls += 1;
    }, { interval: 5, hiddenInterval: 1000 });

    poller.start();
    await sleep(60);
    assert.equal(calls, 1, "隐藏时只应立即跑一次，之后按 hiddenInterval 长间隔等待");

    // 恢复可见：即便还有长定时器在等，也必须立刻补一次
    doc.setVisibility("visible");
    doc.fire("visibilitychange");
    await sleep(30);
    assert.ok(calls >= 2, `恢复可见后应立即补一次，实际 ${calls} 次`);

    poller.stop();
    assert.equal(doc.hasListener("visibilitychange"), false, "stop() 应移除监听");
  });
});

test("createPoller default hidden interval is far slower than the active one", () => {
  assert.ok(HIDDEN_POLL_INTERVAL_MS >= 10000);
  assert.ok(IDLE_BACKOFF_MS.length >= 3);
  assert.ok(
    IDLE_BACKOFF_MS[0] < IDLE_BACKOFF_MS[IDLE_BACKOFF_MS.length - 1],
    "空闲退避应是递增阶梯",
  );
});


// ---------------------------------------------------------------- 进度显示兜底

// 真机反馈（v3.2）：进度条下方堆着一串百分比。
// 后端解析已修，但这里再拦一道 —— 文件名位置绝不渲染百分比堆叠。
test("setJobProgress never renders a percent run as the current file", () => {
  const state = { elements: createProgressStub() };

  setJobProgress(0, "正在解压", "1%  3%  5%  6%  8%  10%  11%  13%  15%", state);

  assert.equal(state.elements.progressText.textContent, "0%");
  assert.equal(state.elements.currentFile.textContent, "正在等待任务状态...");
});

test("setJobProgress keeps a normal file name", () => {
  const state = { elements: createProgressStub() };

  setJobProgress(42, "正在解压", "视频/第一集.mkv", state);

  assert.equal(state.elements.progressText.textContent, "42%");
  assert.equal(state.elements.currentFile.textContent, "视频/第一集.mkv");
});

// 只有单个百分比的不拦：真的存在名为 "50%" 的文件。
test("setJobProgress keeps a file name that is a single percent", () => {
  const state = { elements: createProgressStub() };

  setJobProgress(10, "正在解压", "50%", state);

  assert.equal(state.elements.currentFile.textContent, "50%");
});

test("setJobProgress falls back when there is no file name at all", () => {
  const state = { elements: createProgressStub() };

  setJobProgress(0, "任务已排队", "", state);

  assert.equal(state.elements.currentFile.textContent, "正在等待任务状态...");
});

test("finishPolling disables cancelBtn and notifies availability change", () => {
  const { finishPolling } = globalThis.CHzipUiJobs;
  const cancelBtn = { disabled: false };
  let availabilityCalled = false;
  const state = {
    running: true,
    jobId: "some-job",
    pollTimer: null,
    elements: { cancelBtn },
    onAvailabilityChange: () => { availabilityCalled = true; },
  };

  finishPolling(state);
  assert.equal(state.running, false);
  assert.equal(cancelBtn.disabled, true, "任务结束后 cancelBtn 必须置为禁用");
  assert.equal(availabilityCalled, true, "应触发 onAvailabilityChange");
});

test("setJobProgress works with window.CHzipUiTree present without ReferenceError", () => {
  const originalWindow = globalThis.window;
  let highlighted = null;
  globalThis.window = {
    CHzipUiTree: {
      highlightExtractingFile: (file) => { highlighted = file; },
    },
  };
  try {
    const state = { elements: createProgressStub() };
    setJobProgress(0, "正在创建任务", "正在校验设置...", state);
    assert.equal(highlighted, null);

    setJobProgress(50, "正在解压", "a.txt", state, { status: "running" });
    assert.equal(highlighted, "a.txt");
  } finally {
    globalThis.window = originalWindow;
  }
});
