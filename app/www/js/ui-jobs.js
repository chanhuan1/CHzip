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

    root.CHzipUiJobs = {
        cancelExtract,
        computeEta,
        pollStatus,
        setJobProgress,
        startExtract,
        statusLabel,
    };
}(typeof window !== "undefined" ? window : globalThis));
