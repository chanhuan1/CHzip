(function (root) {
    "use strict";

    // 页面隐藏时的轮询间隔。
    //
    // 这里刻意**不是**彻底停止轮询，而是降到 30s 一次：fnOS 的内嵌窗口
    // 对 document.hidden 的上报无法在本地验证，若它误报为 true，彻底停止
    // 会让界面永久不再更新（用户看不到任何进度）。降频既能把隐藏期间的
    // 请求量压下 ~30 倍，又不存在"界面冻死"的失败模式。
    const HIDDEN_POLL_INTERVAL_MS = 30 * 1000;

    // 统一的轮询循环。
    //
    // - 用递归 setTimeout 而不是 setInterval：上一次请求没返回之前绝不发下一次，
    //   从根本上消除"请求堆积 + 乱序覆盖"（每次请求都要起一个 node 进程，
    //   单次耗时完全可能超过 1s）。
    // - in-flight 守卫保证任何时刻最多一个在途请求。
    // - 页面隐藏时降频，重新可见时立即补一次，避免回来看到过期进度。
    // - stop() 之后不再有任何定时器，也不会再发请求。
    function createPoller(tick, options) {
        const settings = options || {};
        const intervalFn = typeof settings.interval === "function"
            ? settings.interval
            : () => (settings.interval == null ? 1000 : settings.interval);
        const hiddenIntervalFn = typeof settings.hiddenInterval === "function"
            ? settings.hiddenInterval
            : () => (settings.hiddenInterval == null
                ? HIDDEN_POLL_INTERVAL_MS
                : settings.hiddenInterval);

        let timer = null;
        let running = false;
        let busy = false;
        // 页面从隐藏恢复时置位：让"正在途中的请求"结束后立刻接上一轮，
        // 而不是傻等一个完整间隔。
        let wakeImmediately = false;

        const clear = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        };

        const isHidden = () => typeof document !== "undefined"
            && document.visibilityState === "hidden";

        const schedule = (delay) => {
            clear();
            if (!running) {
                return;
            }
            timer = setTimeout(run, delay);
        };

        const scheduleNext = () => {
            schedule(isHidden() ? hiddenIntervalFn() : intervalFn());
        };

        async function run() {
            timer = null;
            if (!running || busy) {
                return;
            }
            busy = true;
            try {
                await tick();
            } catch (error) {
                // 单次失败不应中断轮询循环。
            } finally {
                busy = false;
            }
            if (!running) {
                return;
            }
            if (wakeImmediately) {
                wakeImmediately = false;
                schedule(0);
                return;
            }
            scheduleNext();
        }

        const onVisibilityChange = () => {
            if (!running || isHidden()) {
                return;
            }
            if (busy) {
                wakeImmediately = true;
                return;
            }
            schedule(0);
        };

        return {
            start() {
                if (running) {
                    return;
                }
                running = true;
                wakeImmediately = false;
                if (typeof document !== "undefined"
                    && typeof document.addEventListener === "function") {
                    document.addEventListener("visibilitychange", onVisibilityChange);
                }
                schedule(0);
            },
            stop() {
                running = false;
                wakeImmediately = false;
                clear();
                if (typeof document !== "undefined"
                    && typeof document.removeEventListener === "function") {
                    document.removeEventListener("visibilitychange", onVisibilityChange);
                }
            },
            isRunning() {
                return running;
            },
        };
    }

    // 连续轮询失败达到这个次数，才把「连接中断」挑明到进度条——
    // 偶发的单次抖动（弱网）不应打扰用户。
    const POLL_FAIL_ALERT_THRESHOLD = 5;

    function statusLabel(status, phase) {
        if (status === "queued") {
            return "任务已排队";
        }
        if (status === "cancelling") {
            return "正在停止";
        }
        if (status === "cancelled") {
            return "已停止";
        }
        if (status === "success") {
            return "解压完成";
        }
        if (status === "failed") {
            return "解压失败";
        }
        if (phase === "validating") {
            return "正在检查文件列表";
        }
        if (phase === "preparing") {
            return "正在准备嵌套归档";
        }
        if (phase === "extracting") {
            return "正在解压";
        }
        return "正在处理";
    }

    // 兜底：文件名位置绝不渲染「一串百分比」。
    //
    // 后端解析 7-Zip 输出时，若某行把多次进度更新挤在一起，仍有可能把百分比串
    // 当成文件名传下来（v2.9 与 v3.2 两次真机反馈都是这个症状）。这里再拦一道，
    // 保证界面上不会出现进度百分比堆叠。要求「至少两个百分比」才算百分比串，
    // 因此真的存在名为 "50%" 的文件时仍然照常显示。
    const PERCENT_RUN_ONLY = /^(?:\s*\d{1,3}\s*%){2,}\s*$/;

    function setJobProgress(percent, status, currentFile, state, job = null, eta = null) {
        const els = state.elements;
        const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
        els.progressFill.style.width = `${safePercent}%`;
        els.progressText.textContent = `${Math.round(safePercent)}%`;
        els.jobState.textContent = status;
        const fileText = PERCENT_RUN_ONLY.test(String(currentFile || ""))
            ? ""
            : currentFile;
        els.currentFile.textContent = fileText || "正在等待任务状态...";
        if (els.progressEta) {
            els.progressEta.hidden = !eta;
            els.progressEta.textContent = eta ? `剩余约 ${eta}` : "";
        }
        const running = Boolean(job)
            && !["success", "failed", "cancelled"].includes(job.status);
        const ok = job?.status === "success";
        const bad = job?.status === "failed" || job?.status === "cancelled";
        const fill = els.progressFill;
        fill.classList.toggle("is-running", running && safePercent > 0);
        fill.classList.toggle("is-success", ok);
        fill.classList.toggle("is-error", bad);
        els.progressTrack.classList.toggle(
            "is-busy",
            (state.running || running) && safePercent <= 0,
        );
    }

    function computeEta(state, job) {
        if (!job || job.status !== "running" || job.phase !== "extracting") {
            return null;
        }
        const pct = Number(job.progress) || 0;
        if (!(pct > 0 && pct < 100)) {
            return null;
        }
        const now = Date.now();
        let tracker = state.etaTracker;
        if (!tracker || tracker.jobId !== job.id) {
            state.etaTracker = { jobId: job.id, pct, at: now, rate: 0 };
            return null;
        }
        const dt = (now - tracker.at) / 1000;
        const dp = pct - tracker.pct;
        if (dt >= 1 && dp >= 0.5) {
            const instant = dp / dt;
            tracker.rate = tracker.rate ? tracker.rate * 0.6 + instant * 0.4 : instant;
            tracker.pct = pct;
            tracker.at = now;
        } else if (dt >= 8) {
            tracker.pct = pct;
            tracker.at = now;
            return null;
        }
        const rate = tracker.rate;
        if (!rate || rate <= 0) {
            return null;
        }
        const seconds = (100 - pct) / rate;
        if (!(seconds >= 5)) {
            return null;
        }
        return seconds < 90 ? `${Math.round(seconds)} 秒` : `${Math.ceil(seconds / 60)} 分钟`;
    }

    function finishPolling(state) {
        if (state.pollTimer) {
            state.pollTimer.stop();
            state.pollTimer = null;
        }
        state.running = false;
        state.jobId = "";
    }

    async function startExtract(state, api) {
        const els = state.elements;
        if (els.extractBtn.disabled) {
            return;
        }
        state.running = true;
        setJobProgress(0, "正在创建任务", "正在校验设置...", state);
        setNotice("解压任务正在启动，请保持页面打开。", "", state);
        try {
            const selectedPaths = state.previewLimited
                || state.selectedPaths.size === state.allFilePaths.length
                ? null
                : Array.from(state.selectedPaths);
            const result = await api.postApi("extract", {
                path: state.filePath,
                password: els.passwordInput.value,
                codePage: els.codePageSelect.value,
                destinationRoot: state.selectedDirectory,
                selectedPaths,
            });
            state.jobId = result.jobId;
            state.etaTracker = null;
            els.outputPreview.textContent = result.outputDir;
            setJobProgress(0, "任务已排队", "等待 7-Zip 启动...", state);
            ensureMiniPoll(state, api);
            await pollStatus(state, api);
            if (state.jobId) {
                if (state.pollTimer) {
                    state.pollTimer.stop();
                }
                state.pollTimer = createPoller(() => pollStatus(state, api), {
                    interval: 1000,
                });
                state.pollTimer.start();
            }
        } catch (error) {
            state.running = false;
            setJobProgress(0, "启动失败", error.message, state);
            setNotice(error.message, "error", state);
            if (!handlePermissionError(error, state)) {
                recordDiagnosticError(error, state);
            }
        }
    }

    async function pollStatus(state, api) {
        const els = state.elements;
        if (!state.jobId) {
            return;
        }
        try {
            const job = await api.requestJson(api.apiUrl("status", {
                jobId: state.jobId,
            }), { timeoutMs: api.POLL_TIMEOUT_MS });
            // 成功：清零失败计数并摘掉连接中断的错误态。
            state.pollFailCount = 0;
            els.progressTrack.classList.remove?.("is-error");
            const eta = computeEta(state, job);
            setJobProgress(
                job.progress,
                statusLabel(job.status, job.phase),
                job.currentFile || "",
                state,
                job,
                eta,
            );
            if (job.status === "success") {
                finishPolling(state);
                setJobProgress(100, "解压完成", job.outputDir, state, job);
                setNotice("解压任务已完成。", "success", state);
                els.resultOutputDir.textContent = job.outputDir;
                els.resultDialog.hidden = false;
            } else if (job.status === "failed") {
                finishPolling(state);
                const message = job.error?.message || "解压失败";
                const requestSuffix = job.requestId
                    ? `（请求 ID：${job.requestId}）`
                    : "";
                setJobProgress(job.progress, "解压失败", `${message}${requestSuffix}`, state, job);
                setNotice(message, "error", state);
                if (!handlePermissionError(job.error, state)) {
                    recordDiagnosticError(job.error, state);
                }
            } else if (job.status === "cancelled") {
                finishPolling(state);
                setJobProgress(job.progress, "已停止", "未完成的任务目录已清理。", state, job);
                setNotice("解压任务已停止。", "", state);
            }
        } catch (error) {
            // 连续失败计数：偶发抖动不打扰，超过阈值才把「假进度」挑明——
            // 否则后端持续起不来时，界面永远停在最后一次成功的 N%，
            // 用户无法区分「解压中」与「轮询已失效」。
            state.pollFailCount = (state.pollFailCount || 0) + 1;
            if (state.pollFailCount >= POLL_FAIL_ALERT_THRESHOLD) {
                els.jobState.textContent = "连接中断，重试中…";
                els.currentFile.textContent = "与设备的连接已断开，正在自动重试。";
                els.progressTrack.classList.add?.("is-error");
            }
            // notice 只在第一次失败与跨过阈值时更新，避免每秒重写同一条
            // 错误反复打断（role=status 的 live region 会被读屏反复播报）。
            if (
                state.pollFailCount === 1
                || state.pollFailCount === POLL_FAIL_ALERT_THRESHOLD
            ) {
                setNotice(`状态查询失败：${error.message}`, "error", state);
            }
            recordDiagnosticError(error, state);
        }
    }

    async function cancelExtract(state, api) {
        const els = state.elements;
        if (!state.jobId || !state.running) {
            return;
        }
        els.cancelBtn.disabled = true;
        setJobProgress(
            Number.parseInt(els.progressText.textContent, 10) || 0,
            "正在停止",
            "正在终止 7-Zip 进程...",
            state,
        );
        try {
            await api.postApi("cancel", { jobId: state.jobId });
            await pollStatus(state, api);
        } catch (error) {
            setNotice(`停止任务失败：${error.message}`, "error", state);
            recordDiagnosticError(error, state);
        } finally {
            els.cancelBtn.disabled = false;
        }
    }

    function setNotice(message, kind, state) {
        const els = state.elements;
        if (!els.notice) {
            return;
        }
        els.notice.className = `notice ${kind || ""}`.trim();
        els.notice.textContent = message;
    }

    function recordDiagnosticError(error, state) {
        state.lastRequestId = error?.requestId || "";
        state.diagnosticsReport = null;
        if (state.elements.diagnosticsBtn) {
            state.elements.diagnosticsBtn.hidden = !state.filePath;
        }
    }

    function handlePermissionError(error, state) {
        if (error?.code !== "SOURCE_FILE_DENIED" && error?.code !== "SOURCE_PARENT_DENIED") {
            return false;
        }
        recordDiagnosticError(error, state);
        const els = state.elements;
        const deniedPath = error?.details?.path || error?.path || state.filePath;
        const fileName = String(deniedPath || "").split("/").filter(Boolean).pop() || "当前文件";
        els.permissionDialogMessage.textContent = `当前文件未授予 CHzip 读取权限：“${fileName}”。请按以下步骤为上一级文件夹添加应用权限。`;
        els.permissionDialog.hidden = false;
        return true;
    }

    // 任务中心的渲染签名：只包含真正影响 DOM 的字段。
    // 弹窗打开但数据没变化时（空闲时是绝大多数轮询），直接跳过整段重建。
    // 每次 closeTaskCenter 会清空，保证重新打开必定渲染一次。
    let taskCenterSignature = null;

    function taskCenterSignatureOf(active, history) {
        const activePart = active.map((job) => [
            job.id,
            job.status,
            job.phase,
            job.progress,
            job.currentFile || "",
            job.error?.message || "",
            job.outputDir || "",
        ]);
        const historyPart = history.map((job) => [
            job.id,
            job.status,
            job.phase,
            job.progress,
        ]);
        return JSON.stringify([activePart, historyPart]);
    }

    function renderTaskStream(state, api, data) {
        const els = state.elements;
        const stream = els.taskStream;
        if (!stream) {
            return;
        }
        const active = (data?.active || []).slice();
        if (!active.length) {
            stream.hidden = true;
            stream.replaceChildren();
            state.taskStreamRows = new Map();
            return;
        }
        // 按开始先后排序，最先开始在最上面
        active.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

        // 按 job.id 复用已有行：轮询时只改文本，不重建 DOM、也不重挂监听器。
        const rows = state.taskStreamRows instanceof Map
            ? state.taskStreamRows
            : new Map();
        const seen = new Set();
        active.forEach((job, index) => {
            const name = job.archiveName || "压缩包";
            const ordinal = index < CN.length ? CN[index] : String(index + 1);
            const label = active.length > 1 ? `任务${ordinal} · ${name}` : name;
            const percent = `${Math.round(Number(job.progress) || 0)}%`;

            let entry = rows.get(job.id);
            if (!entry) {
                const row = document.createElement("div");
                row.className = "task-stream-row";
                row.setAttribute("role", "button");
                row.tabIndex = 0;
                row.title = "点击查看详情 / 停止";
                row.addEventListener("click", () => openTaskCenter(state, api));
                row.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") {
                        openTaskCenter(state, api);
                    }
                });

                const text = document.createElement("span");
                text.className = "task-stream-text";
                const pct = document.createElement("span");
                pct.className = "task-stream-pct";
                row.append(text, pct);

                entry = { row, text, pct };
                rows.set(job.id, entry);
            }

            if (entry.text.textContent !== label) {
                entry.text.textContent = label;
            }
            const title = job.archivePath || name;
            if (entry.text.title !== title) {
                entry.text.title = title;
            }
            if (entry.pct.textContent !== percent) {
                entry.pct.textContent = percent;
            }
            seen.add(job.id);
            // append 会把已存在的节点移动到末尾，因此这一步同时完成排序。
            stream.append(entry.row);
        });
        for (const [jobId, entry] of rows) {
            if (!seen.has(jobId)) {
                entry.row.remove();
                rows.delete(jobId);
            }
        }
        state.taskStreamRows = rows;
        stream.hidden = false;
    }

    async function pollTaskMini(state, api) {
        try {
            const data = await api.requestJson(api.apiUrl("jobs"), {
                timeoutMs: api.POLL_TIMEOUT_MS,
            });
            renderTaskStream(state, api, data);
            return data?.active?.length || 0;
        } catch (error) {
            return 0;
        }
    }

    function ensureMiniPoll(state, api) {
        pollTaskMini(state, api).catch(() => {});
    }

    // 页面打开后常驻的自适应监听：有后台任务时 1.5s 快刷；
    // 连续没有任务时按 5s → 15s → 30s 退避（原实现空闲时永远 5s 一次，
    // 一个常开窗口一小时就是 720 次请求，每次都要起一个 node 进程）。
    // 任务中心弹窗打开时由弹窗自身轮询驱动，此处让位避免重复请求。
    const IDLE_BACKOFF_MS = [5000, 15000, 30000];
    const ACTIVE_POLL_MS = 1500;

    function startTaskWatch(state, api) {
        if (state.taskWatchTimer) {
            return;
        }
        let idleSteps = 0;
        const poller = createPoller(async () => {
            if (state.taskCenterOpen) {
                return;
            }
            const count = await pollTaskMini(state, api);
            if (count > 0) {
                idleSteps = 0;
            } else {
                idleSteps = Math.min(idleSteps + 1, IDLE_BACKOFF_MS.length - 1);
            }
        }, {
            interval: () => (state.taskCenterOpen
                ? 3000
                : (idleSteps > 0
                    ? IDLE_BACKOFF_MS[idleSteps]
                    : ACTIVE_POLL_MS)),
        });
        state.taskWatchTimer = poller;
        poller.start();
    }

    // 历史记录需要完整日期（可能跨天/跨周），因此按本地时区输出
    // YYYY-MM-DD HH:MM:SS，各段补零以便纵向对齐。
    function formatTaskDateTime(iso) {
        if (!iso) {
            return "";
        }
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return "";
        }
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
            + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function renderTaskEmpty(list, text) {
        const empty = document.createElement("div");
        empty.className = "task-center-empty";
        empty.textContent = text;
        list.append(empty);
    }

    // 元信息行拆成「时间 + 详情」两个 span：时间不参与省略（flex: none），
    // 详情过长时优先被截断，保证日期时间始终可见。
    function appendTaskMeta(container, timeText, timeTitle, detailText, detailTitle) {
        const meta = document.createElement("div");
        meta.className = "task-row-meta";
        if (timeText) {
            const time = document.createElement("span");
            time.className = "task-row-time";
            time.textContent = timeText;
            if (timeTitle) {
                time.title = timeTitle;
            }
            meta.append(time);
        }
        if (detailText) {
            const detail = document.createElement("span");
            detail.className = "task-row-detail";
            detail.textContent = detailText;
            if (detailTitle) {
                detail.title = detailTitle;
            }
            meta.append(detail);
        }
        container.append(meta);
    }

    function renderTaskRow(state, api, list, job) {
        const terminal = ["success", "failed", "cancelled"].includes(job.status);
        const row = document.createElement("div");
        row.className = `task-row task-${job.status}`;

        const main = document.createElement("div");
        main.className = "task-row-main";

        const head = document.createElement("div");
        head.className = "task-row-head";
        const name = document.createElement("strong");
        name.className = "task-row-name";
        name.textContent = job.archiveName || "压缩包";
        name.title = job.archivePath || "";
        const status = document.createElement("span");
        status.className = "task-row-status";
        status.textContent = terminal
            ? statusLabel(job.status, job.phase)
            : `${statusLabel(job.status, job.phase)} · ${Math.round(Number(job.progress) || 0)}%`;
        head.append(name, status);
        main.append(head);

        if (!terminal) {
            const track = document.createElement("div");
            track.className = "task-row-track";
            const fill = document.createElement("div");
            fill.className = "task-row-fill";
            fill.style.width = `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`;
            track.append(fill);
            main.append(track);
            const started = formatTaskDateTime(job.startedAt);
            appendTaskMeta(
                main,
                started ? `开始于 ${started}` : "",
                "",
                job.currentFile ? `正在处理：${job.currentFile}` : "",
                job.currentFile || "",
            );
        } else {
            const finished = formatTaskDateTime(
                job.finishedAt || job.startedAt || job.createdAt,
            );
            const started = formatTaskDateTime(job.startedAt);
            const timeTitle = [
                finished ? `完成于 ${finished}` : "",
                started ? `开始于 ${started}` : "",
            ].filter(Boolean).join("，");
            if (job.status === "success") {
                appendTaskMeta(
                    main,
                    finished,
                    timeTitle,
                    `已解压到：${job.outputDir || ""}`,
                    job.outputDir || "",
                );
            } else if (job.status === "failed") {
                appendTaskMeta(
                    main,
                    finished,
                    timeTitle,
                    job.error?.message || "解压失败",
                    "",
                );
            } else {
                appendTaskMeta(main, finished, timeTitle, "已停止", "");
            }
        }

        const actions = document.createElement("div");
        actions.className = "task-row-actions";
        if (!terminal) {
            const stop = document.createElement("button");
            stop.type = "button";
            stop.className = "danger-button task-stop-btn";
            stop.textContent = "停止";
            stop.addEventListener("click", () => {
                // 点击即禁用并变「停止中…」：防误触连发多个 cancel（弱网），
                // 也由轮询确认终态后整行重建自然恢复。
                stop.disabled = true;
                stop.textContent = "停止中…";
                cancelTaskCenter(state, api, job.id);
            });
            actions.append(stop);
        }
        row.append(main, actions);
        list.append(row);
    }

    async function pollTaskCenter(state, api) {
        const list = state.elements.taskCenterList;
        if (!list) {
            return;
        }
        try {
            const data = await api.requestJson(api.apiUrl("jobs"), {
                timeoutMs: api.POLL_TIMEOUT_MS,
            });
            const active = data?.active || [];
            const history = data?.history || [];
            renderTaskStream(state, api, data);

            const signature = taskCenterSignatureOf(active, history);
            if (signature === taskCenterSignature) {
                return;
            }
            taskCenterSignature = signature;

            list.replaceChildren();
            if (active.length) {
                const h = document.createElement("div");
                h.className = "task-center-section";
                h.textContent = "进行中";
                list.append(h);
                for (const job of active) {
                    renderTaskRow(state, api, list, job);
                }
            }
            if (history.length) {
                const h = document.createElement("div");
                h.className = "task-center-section";
                h.textContent = "解压历史";
                list.append(h);
                for (const job of history) {
                    renderTaskRow(state, api, list, job);
                }
            }
            if (!active.length && !history.length) {
                renderTaskEmpty(list, "当前没有解压任务。关闭本页面不会中断进行中的解压。");
            }
        } catch (error) {
            taskCenterSignature = null;
            list.replaceChildren();
            renderTaskEmpty(list, `任务列表获取失败：${error.message}`);
        }
    }

    async function cancelTaskCenter(state, api, jobId) {
        try {
            await api.postApi("cancel", { jobId });
        } catch (error) {
            // 下一次轮询会反映真实状态
        }
        await pollTaskCenter(state, api);
    }

    async function openTaskCenter(state, api) {
        const dialog = state.elements.taskCenterDialog;
        if (!dialog) {
            return;
        }
        dialog.hidden = false;
        state.taskCenterOpen = true;
        if (state.taskCenterTimer) {
            state.taskCenterTimer.stop();
        }
        // 首次 tick 是立即执行的，等价于原来的"先拉一次再起定时器"，
        // 但不会多打一次请求。
        state.taskCenterTimer = createPoller(() => pollTaskCenter(state, api), {
            interval: 1500,
        });
        state.taskCenterTimer.start();
    }

    function closeTaskCenter(state, api) {
        if (state.taskCenterTimer) {
            state.taskCenterTimer.stop();
            state.taskCenterTimer = null;
        }
        taskCenterSignature = null;
        state.taskCenterOpen = false;
        const dialog = state.elements.taskCenterDialog;
        if (dialog) {
            dialog.hidden = true;
        }
        ensureMiniPoll(state, api);
    }

    async function pollHistory(state, api) {
        const list = state.elements.historyList;
        if (!list) {
            return;
        }
        const clearBtn = state.elements.clearHistoryBtn;
        try {
            const data = await api.requestJson(api.apiUrl("jobs"), {
                timeoutMs: api.POLL_TIMEOUT_MS,
            });
            const history = data?.history || [];
            // 无记录时禁用清空按钮；二次确认中或正在清空时不干扰按钮状态
            if (clearBtn && !state.historyClearPending && !state.historyClearing) {
                clearBtn.disabled = history.length === 0;
            }
            list.replaceChildren();
            if (history.length) {
                for (const job of history) {
                    renderTaskRow(state, api, list, job);
                }
            } else {
                renderTaskEmpty(list, "暂无解压历史");
            }
        } catch (error) {
            list.replaceChildren();
            renderTaskEmpty(list, `历史记录获取失败：${error.message}`);
        }
    }

    function resetClearHistoryConfirm(state) {
        if (state.historyClearTimer) {
            clearTimeout(state.historyClearTimer);
            state.historyClearTimer = null;
        }
        state.historyClearPending = false;
        const button = state.elements.clearHistoryBtn;
        if (button && !state.historyClearing) {
            button.textContent = "清空记录";
        }
    }

    // 清空历史是不可撤销的批量操作，因此用按钮内联二次确认（不弹原生对话框），
    // 首次点击变为“确认清空？”，4 秒内再点一次才真正执行。
    async function clearHistory(state, api) {
        const button = state.elements.clearHistoryBtn;
        if (!button || state.historyClearing) {
            return;
        }
        if (!state.historyClearPending) {
            state.historyClearPending = true;
            button.textContent = "确认清空？";
            state.historyClearTimer = window.setTimeout(
                () => resetClearHistoryConfirm(state),
                4000,
            );
            return;
        }
        resetClearHistoryConfirm(state);
        state.historyClearing = true;
        button.disabled = true;
        button.textContent = "正在清空...";
        let cleared = false;
        try {
            await api.postApi("clear-history", {});
            cleared = true;
            await pollHistory(state, api);
            setNotice("解压历史已清空。", "success", state);
        } catch (error) {
            setNotice(`清空历史失败：${error.message}`, "error", state);
            recordDiagnosticError(error, state);
        } finally {
            state.historyClearing = false;
            button.textContent = "清空记录";
            button.disabled = cleared;
        }
    }

    async function openHistory(state, api) {
        const dialog = state.elements.historyDialog;
        if (!dialog) {
            return;
        }
        dialog.hidden = false;
        state.historyOpen = true;
        if (state.historyTimer) {
            state.historyTimer.stop();
        }
        state.historyTimer = createPoller(() => pollHistory(state, api), {
            interval: 3000,
        });
        state.historyTimer.start();
    }

    function closeHistory(state) {
        if (state.historyTimer) {
            state.historyTimer.stop();
            state.historyTimer = null;
        }
        state.historyOpen = false;
        resetClearHistoryConfirm(state);
        const dialog = state.elements.historyDialog;
        if (dialog) {
            dialog.hidden = true;
        }
    }

    // bfcache 恢复后重启 pagehide 停掉的轮询器（见 app.js 的 stopAllPollers）。
    // 只处理 persisted=true；普通首次加载不重复启动。四类状态按需恢复：
    // 进行中的任务轮询、常驻监听、以及仍开着的任务中心/历史弹窗。
    function resumePollers(state, api, event) {
        if (!event || !event.persisted) {
            return;
        }
        if (!state.pollTimer && state.jobId && state.running) {
            state.pollTimer = createPoller(() => pollStatus(state, api), {
                interval: 1000,
            });
            state.pollTimer.start();
        }
        if (!state.taskWatchTimer) {
            startTaskWatch(state, api);
        }
        if (state.taskCenterOpen && !state.taskCenterTimer) {
            openTaskCenter(state, api);
        }
        if (state.historyOpen && !state.historyTimer) {
            openHistory(state, api);
        }
    }

    root.CHzipUiJobs = {
        ACTIVE_POLL_MS,
        HIDDEN_POLL_INTERVAL_MS,
        IDLE_BACKOFF_MS,
        cancelExtract,
        cancelTaskCenter,
        clearHistory,
        closeHistory,
        closeTaskCenter,
        computeEta,
        createPoller,
        ensureMiniPoll,
        formatTaskDateTime,
        openHistory,
        openTaskCenter,
        pollHistory,
        pollStatus,
        pollTaskCenter,
        pollTaskMini,
        resetClearHistoryConfirm,
        resumePollers,
        setJobProgress,
        startExtract,
        startTaskWatch,
        statusLabel,
    };
}(typeof window !== "undefined" ? window : globalThis));
