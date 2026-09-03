(function (root) {
    "use strict";

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
        if (phase === "testing") {
            return "正在校验压缩包";
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

    function setJobProgress(percent, status, currentFile, state, job = null, eta = null) {
        const els = state.elements;
        const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
        els.progressFill.style.width = `${safePercent}%`;
        els.progressText.textContent = `${Math.round(safePercent)}%`;
        els.jobState.textContent = status;
        els.currentFile.textContent = currentFile || "正在等待任务状态...";
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
        clearInterval(state.pollTimer);
        state.pollTimer = null;
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
                clearInterval(state.pollTimer);
                state.pollTimer = window.setInterval(() => pollStatus(state, api), 1000);
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
            }));
            const eta = computeEta(state, job);
            setJobProgress(
                job.progress,
                statusLabel(job.status, job.phase),
                job.currentFile || (job.phase === "testing" ? "正在检查分卷和数据完整性..." : ""),
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
            setNotice(`状态查询失败：${error.message}`, "error", state);
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
        els.notice.className = `notice ${kind || ""}`.trim();
        els.notice.textContent = message;
    }

    function recordDiagnosticError(error, state) {
        state.lastRequestId = error?.requestId || "";
        state.diagnosticsReport = null;
        state.elements.diagnosticsBtn.hidden = !state.filePath;
    }

    function handlePermissionError(error, state) {
        if (error?.code !== "SOURCE_FILE_DENIED" && error?.code !== "SOURCE_PARENT_DENIED") {
            return false;
        }
        recordDiagnosticError(error, state);
        const els = state.elements;
        state.permissionError = error || null;
        const deniedPath = error?.details?.path || error?.path || state.filePath;
        const fileName = String(deniedPath || "").split("/").filter(Boolean).pop() || "当前文件";
        els.permissionDialogMessage.textContent = `当前文件未授予 CHzip 读取权限：“${fileName}”。请按以下步骤为上一级文件夹添加应用权限。`;
        els.permissionDialog.hidden = false;
        return true;
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
            return;
        }
        // 按开始先后排序，最先开始在最上面
        active.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
        stream.replaceChildren();
        active.forEach((job, index) => {
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
            const name = job.archiveName || "压缩包";
            const ordinal = index < CN.length ? CN[index] : String(index + 1);
            text.textContent = active.length > 1 ? `任务${ordinal} · ${name}` : name;
            text.title = job.archivePath || name;

            const pct = document.createElement("span");
            pct.className = "task-stream-pct";
            pct.textContent = `${Math.round(Number(job.progress) || 0)}%`;

            row.append(text, pct);
            stream.append(row);
        });
        stream.hidden = false;
    }

    async function pollTaskMini(state, api) {
        try {
            const data = await api.requestJson(api.apiUrl("jobs"));
            renderTaskStream(state, api, data);
            return data?.active?.length || 0;
        } catch (error) {
            return 0;
        }
    }

    function ensureMiniPoll(state, api) {
        pollTaskMini(state, api).catch(() => {});
    }

    // 页面打开后常驻的自适应监听：空闲约 5s 扫一次，一旦出现后台任务切到 1.5s 快刷；
    // 任务中心弹窗打开时由弹窗自身轮询驱动（此处跳过，避免重复请求）。
    function startTaskWatch(state, api) {
        if (state.taskWatchTimer) {
            return;
        }
        const tick = async () => {
            try {
                if (!state.taskCenterOpen) {
                    const count = await pollTaskMini(state, api);
                    state.taskWatchTimer = setTimeout(tick, count > 0 ? 1500 : 5000);
                    return;
                }
            } catch (error) {
                // 忽略，继续下一轮
            }
            state.taskWatchTimer = setTimeout(tick, 3000);
        };
        state.taskWatchTimer = setTimeout(tick, 0);
    }

    function formatTaskTime(iso) {
        if (!iso) {
            return "";
        }
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return "";
        }
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function renderTaskEmpty(list, text) {
        const empty = document.createElement("div");
        empty.className = "task-center-empty";
        empty.textContent = text;
        list.append(empty);
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
            const meta = document.createElement("div");
            meta.className = "task-row-meta";
            const started = formatTaskTime(job.startedAt);
            meta.textContent = [
                job.currentFile ? `正在处理：${job.currentFile}` : "",
                started ? `开始于 ${started}` : "",
            ].filter(Boolean).join(" · ");
            main.append(meta);
        } else {
            const meta = document.createElement("div");
            meta.className = "task-row-meta";
            if (job.status === "success") {
                meta.textContent = `已解压到：${job.outputDir || ""}`;
                meta.title = job.outputDir || "";
            } else if (job.status === "failed") {
                meta.textContent = job.error?.message || "解压失败";
            } else {
                meta.textContent = "已停止";
            }
            main.append(meta);
        }

        const actions = document.createElement("div");
        actions.className = "task-row-actions";
        if (!terminal) {
            const stop = document.createElement("button");
            stop.type = "button";
            stop.className = "danger-button task-stop-btn";
            stop.textContent = "停止";
            stop.addEventListener("click", () => {
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
            const data = await api.requestJson(api.apiUrl("jobs"));
            const active = data?.active || [];
            const recent = data?.recent || [];
            renderTaskStream(state, api, data);
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
            if (recent.length) {
                const h = document.createElement("div");
                h.className = "task-center-section";
                h.textContent = "最近完成";
                list.append(h);
                for (const job of recent) {
                    renderTaskRow(state, api, list, job);
                }
            }
            if (!active.length && !recent.length) {
                renderTaskEmpty(list, "当前没有解压任务。关闭本页面不会中断进行中的解压。");
            }
        } catch (error) {
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
        clearInterval(state.taskCenterTimer);
        await pollTaskCenter(state, api);
        state.taskCenterTimer = window.setInterval(
            () => pollTaskCenter(state, api),
            1000,
        );
    }

    function closeTaskCenter(state, api) {
        clearInterval(state.taskCenterTimer);
        state.taskCenterTimer = null;
        state.taskCenterOpen = false;
        const dialog = state.elements.taskCenterDialog;
        if (dialog) {
            dialog.hidden = true;
        }
        ensureMiniPoll(state, api);
    }

    function toggleTaskCenter(state, api) {
        if (state.taskCenterOpen) {
            closeTaskCenter(state, api);
        } else {
            openTaskCenter(state, api);
        }
    }

    async function checkActiveTasks(state, api) {
        try {
            const data = await api.requestJson(api.apiUrl("jobs"));
            if ((data?.active?.length || 0) > 0) {
                ensureMiniPoll(state, api);
            }
        } catch (error) {
            // 任务列表不可用时静默
        }
    }

    root.CHzipUiJobs = {
        cancelExtract,
        cancelTaskCenter,
        checkActiveTasks,
        closeTaskCenter,
        computeEta,
        ensureMiniPoll,
        openTaskCenter,
        pollStatus,
        pollTaskCenter,
        pollTaskMini,
        setJobProgress,
        startExtract,
        startTaskWatch,
        statusLabel,
        toggleTaskCenter,
    };
}(typeof window !== "undefined" ? window : globalThis));
