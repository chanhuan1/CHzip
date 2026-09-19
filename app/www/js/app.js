(function () {
    "use strict";

    const treeApi = window.CHzipTree;
    const passwordStore = window.CHzipPasswordStore.createPasswordStore(
        window.localStorage,
    );
    const api = window.CHzipApiClient.createApiClient();
    const uiDialogs = window.CHzipUiDialogs;
    const uiTree = window.CHzipUiTree;
    const uiJobs = window.CHzipUiJobs;
    const uiPasswords = window.CHzipUiPasswords;
    const uiPreview = window.CHzipPreview;
    const uiTheme = window.CHzipTheme;
    const uiComment = window.CHzipComment;

    const state = window.CHzipState.createState();
    state.elements = window.CHzipState.createElementCache();

    const passwordManager = uiPasswords.createPasswordManager(state, passwordStore);
    const commentManager = uiComment.createCommentManager(state, api);

    // 主题按钮的图标与文案由 [data-theme] 纯 CSS 驱动，这里只负责应用主题。
    uiTheme.initTheme();

    state.onPreviewFile = previewFile;
    state.onAvailabilityChange = updateActionAvailability;

    const els = state.elements;

    const searchScheduler = treeApi.createSearchScheduler({ delay: 180 });

    function getQueryPath() {
        return new URLSearchParams(window.location.search).get("path") || "";
    }

    const passwordManagerApi = {
        openPasswordPrompt: passwordManager.openPasswordPrompt,
        closePasswordPrompt: passwordManager.closePasswordPrompt,
        togglePasswordPresetList: passwordManager.togglePasswordPresetList,
        closePasswordPresetList: passwordManager.closePasswordPresetList,
        selectPasswordPreset: passwordManager.selectPasswordPreset,
        selectManagerPassword: passwordManager.selectManagerPassword,
        openPasswordManager: passwordManager.openPasswordManager,
        closePasswordManager: passwordManager.closePasswordManager,
        openPasswordRecordDialog: passwordManager.openPasswordRecordDialog,
        closePasswordRecordDialog: passwordManager.closePasswordRecordDialog,
        invalidatePasswordVerification: passwordManager.invalidatePasswordVerification,
        rememberPasswordAfterSuccessfulPreview: passwordManager.rememberPasswordAfterSuccessfulPreview,
        savePasswordRecord: passwordManager.savePasswordRecord,
        deleteSelectedPassword: passwordManager.deleteSelectedPassword,
        renderSavedPasswords: passwordManager.renderSavedPasswords,
        updatePasswordManagerStatus: passwordManager.updatePasswordManagerStatus,
    };

    function setPreviewControls(enabled) {
        uiTree.setPreviewControls(enabled, state);
    }

    async function loadPreview(options = {}) {
        const els = state.elements;
        if (!state.filePath || state.running) {
            return false;
        }
        searchScheduler.cancel();
        state.searchRenderId += 1;
        const preserveExisting = Boolean(
            options.fromPasswordManager
            && state.entries.length
            && state.previewReady,
        );
        const previousPreview = preserveExisting ? {
            entries: state.entries,
            tree: state.tree,
            allFilePaths: state.allFilePaths,
            selectedPaths: new Set(state.selectedPaths),
            expandedPaths: new Set(state.expandedPaths),
        } : null;
        state.previewing = true;
        if (!preserveExisting) {
            state.previewReady = false;
            state.previewLimited = false;
            state.passwordRequired = false;
            state.passwordVerified = true;
            els.fileTree.innerHTML = '<div class="tree-empty">正在生成文件树...</div>';
        }
        setPreviewControls(false);
        uiDialogs.setNotice("正在读取压缩包目录...", "", state);
        const previewRequest = {
            id: ++state.previewRequestId,
            password: els.passwordInput.value,
            codePage: els.codePageSelect.value,
            activeSavedPasswordId: state.activeSavedPasswordId,
        };
        let succeeded = false;
        try {
            const preview = await api.postApi("preview", {
                path: state.filePath,
                password: previewRequest.password,
                codePage: previewRequest.codePage,
            });
            if (previewRequest.id !== state.previewRequestId) {
                return false;
            }
            state.entries = preview.entries || [];
            state.tree = treeApi.buildTree(state.entries);
            state.allFilePaths = state.entries
                .filter((entry) => entry.type === "file")
                .map((entry) => entry.path);
            state.selectedPaths = new Set(state.allFilePaths);
            state.expandedPaths = new Set(
                state.tree
                    .filter((node) => node.type === "directory")
                    .map((node) => node.path),
            );
            state.previewableFiles = new Set(
                state.entries
                    .filter((entry) => entry.type === "file" && uiPreview.isPreviewable(entry.name, entry.size))
                    .map((entry) => entry.path),
            );
            state.previewReady = true;
            state.previewSolid = Boolean(preview.solid);
            state.passwordRequired = Boolean(preview.passwordRequired);
            state.passwordVerified = preview.passwordVerified !== false;
            els.fileCount.textContent = String(preview.summary?.fileCount || 0);
            els.totalSize.textContent = uiTree.formatSize(preview.summary?.totalSize || 0);
            setPreviewControls(true);
            if (state.passwordRequired && !state.passwordVerified) {
                uiDialogs.setNotice(
                    "检测到加密文件，请在密码管理器中验证后继续。",
                    "error",
                    state,
                );
                passwordManagerApi.openPasswordPrompt("检测到加密文件，请输入或选择密码后验证。");
            } else {
                const passwordStored = await passwordManagerApi.rememberPasswordAfterSuccessfulPreview(previewRequest);
                uiDialogs.setNotice(
                    passwordStored
                        ? (
                            preview.summary?.encrypted
                                ? "密码验证成功，可以选择文件并开始解压。"
                                : "预览完成，可以选择文件并开始解压。"
                        )
                        : "预览完成，但密码未能写入浏览器本地存储。",
                    "success",
                    state,
                );
                succeeded = true;
                if (options.fromPasswordManager) {
                    passwordManagerApi.closePasswordPrompt(true);
                }
            }
        } catch (error) {
            if (previewRequest.id !== state.previewRequestId) {
                return false;
            }
            if (
                previousPreview
                && (error.code === "PASSWORD" || error.code === "PASSWORD_REQUIRED")
            ) {
                state.entries = previousPreview.entries;
                state.tree = previousPreview.tree;
                state.allFilePaths = previousPreview.allFilePaths;
                state.selectedPaths = previousPreview.selectedPaths;
                state.expandedPaths = previousPreview.expandedPaths;
                state.previewReady = true;
            } else {
                state.entries = [];
                state.tree = [];
                state.allFilePaths = [];
                state.selectedPaths.clear();
            }
            if (error.code === "PREVIEW_LIMIT") {
                state.previewLimited = true;
                uiDialogs.setNotice("压缩包内容超过预览限制，仍可整包解压。", "", state);
            } else if (error.code === "PREVIEW_INTERRUPTED") {
                state.previewLimited = true;
                uiDialogs.setNotice("预览被系统中断，可整包解压。", "error", state);
            } else if (error.code === "PASSWORD_REQUIRED") {
                state.passwordRequired = true;
                state.passwordVerified = false;
                uiDialogs.setNotice("压缩包文件头已加密，请在密码管理器中验证。", "error", state);
                passwordManagerApi.openPasswordPrompt("文件头已加密，请输入密码后验证并预览。");
            } else if (error.code === "PASSWORD") {
                state.passwordRequired = true;
                state.passwordVerified = false;
                uiDialogs.setNotice("密码错误，请重新输入后验证。", "error", state);
                passwordManagerApi.openPasswordPrompt("密码错误，请检查后重新验证。");
            } else if (uiDialogs.handlePermissionError(error, state)) {
                uiDialogs.setNotice(error.message, "error", state);
            } else {
                uiDialogs.setNotice(error.message, "error", state);
            }
        } finally {
            state.previewing = false;
            uiTree.renderTree(state, treeApi);
            passwordManagerApi.updatePasswordManagerStatus();
            updateActionAvailability();
        }
        return succeeded;
    }

    async function verifyPasswordAndPreview() {
        const els = state.elements;
        if (!els.passwordInput.value) {
            uiDialogs.setPasswordPromptError("请输入解压密码。", state);
            els.passwordInput.focus();
            return;
        }
        uiDialogs.setPasswordPromptError("", state);
        els.verifyPasswordBtn.disabled = true;
        els.verifyPasswordBtn.textContent = "正在验证...";
        try {
            await loadPreview({ fromPasswordManager: true });
        } finally {
            els.verifyPasswordBtn.textContent = "确定";
        }
    }

    function togglePasswordVisibility() {
        const els = state.elements;
        els.passwordInput.type = els.showPasswordInput.checked
            ? "text"
            : "password";
    }

    function closeResultDialog() {
        state.elements.resultDialog.hidden = true;
    }

    async function retryPermissionAccess() {
        uiDialogs.closePermissionDialog(state);
        uiDialogs.setNotice("正在重新检测文件权限...", "", state);
        await loadApp();
    }

    function openPermissionDiagnostics() {
        uiDialogs.closePermissionDialog(state);
        openDiagnostics();
    }

    function diagnosticsText() {
        return JSON.stringify(state.diagnosticsReport || {}, null, 2);
    }

    async function openDiagnostics() {
        const els = state.elements;
        if (!state.filePath) {
            return;
        }
        els.diagnosticsDialog.hidden = false;
        els.diagnosticsContent.textContent = "正在生成诊断报告...";
        try {
            state.diagnosticsReport = await api.requestJson(api.apiUrl("diagnostics", {
                path: state.filePath,
                requestId: state.lastRequestId,
            }));
            els.diagnosticsContent.textContent = diagnosticsText();
        } catch (error) {
            state.diagnosticsReport = {
                generatedAt: new Date().toISOString(),
                requestId: error.requestId || state.lastRequestId,
                error: {
                    code: error.code,
                    message: error.message,
                },
            };
            els.diagnosticsContent.textContent = diagnosticsText();
        }
    }

    function closeDiagnostics() {
        state.elements.diagnosticsDialog.hidden = true;
    }

    function copyTextWithLegacyFallback(text) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) {
            throw new Error("浏览器不允许复制，请使用下载 JSON");
        }
    }

    async function copyDiagnostics() {
        const els = state.elements;
        const text = diagnosticsText();
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
            } catch (error) {
                copyTextWithLegacyFallback(text);
            }
        } else {
            copyTextWithLegacyFallback(text);
        }
        els.copyDiagnosticsBtn.textContent = "已复制";
        window.setTimeout(() => {
            els.copyDiagnosticsBtn.textContent = "复制";
        }, 1500);
    }

    function downloadDiagnostics() {
        const text = diagnosticsText();
        const blob = new Blob([text], {
            type: "application/json;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `CHzip-diagnostics-${Date.now()}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    let previewContent = "";

    async function previewFile(targetPath) {
        const els = state.elements;
        if (!state.filePath || !targetPath) {
            return;
        }
        const entry = state.entries.find((e) => e.path === targetPath);
        if (!entry || !uiPreview.isPreviewable(entry.name, entry.size)) {
            uiDialogs.setNotice("此文件类型不支持预览或文件过大", "error", state);
            return;
        }

        els.previewDialog.hidden = false;
        els.previewFileName.textContent = entry.name;
        els.previewInfo.textContent = uiPreview.formatSize(entry.size);
        els.previewCopyBtn.hidden = !uiPreview.isTextFile(entry.name);
        previewContent = "";

        // 固实（solid）压缩包取出任一文件都要先解压整包，耗时与压缩包体积
        // 成正比、与目标文件大小无关。提前把原因说清楚，别让用户面对一次
        // 莫名其妙的长时间等待。
        const loading = document.createElement("div");
        loading.className = "preview-loading";
        loading.textContent = state.previewSolid
            ? "正在加载预览…此压缩包为固实（solid）压缩，需先解压到目标文件所在位置，可能耗时较久。"
            : "正在加载预览...";
        els.previewBody.replaceChildren(loading);

        // 取消上一个仍在途的预览请求：否则连点几次会同时跑起多个 7z，
        // 把「占满一个核」升级成「占满多个核」。
        // 注意 abort 只停前端的 fetch，服务端那个 7z 由 preview-file 的
        // 超时兜底（见 services.previewFile 的 PREVIEW_TIMEOUT）。
        if (state.previewAbortController) {
            state.previewAbortController.abort();
        }
        const abortController = new AbortController();
        state.previewAbortController = abortController;

        const requestSeq = ++state.previewFileRequestId;
        try {
            const result = await api.postApi("preview-file", {
                path: state.filePath,
                targetPath,
                password: els.passwordInput.value,
                codePage: els.codePageSelect.value,
            }, {
                signal: abortController.signal,
                // 比后端 PREVIEW_FILE_MS（45s）留一点余量，让后端先给出
                // 「固实压缩需解压整包」这类明确错误，而不是前端自己超时。
                timeoutMs: 60 * 1000,
            });
            if (requestSeq !== state.previewFileRequestId) {
                return;
            }
            previewContent = result.content;
            const fileType = uiPreview.getFileType(entry.name);
            els.previewIcon.classList.toggle("is-image", fileType === "image");
            // 连续预览时先回收上一张图片的 blob URL，否则每次换图都泄漏一个。
            // 对纯文本子树 revokeBlobUrl 是 no-op，两个分支都调最安全。
            uiPreview.revokeBlobUrl(els.previewBody);
            if (fileType === "image") {
                try {
                    const binaryString = atob(result.content);
                    // 用原生 Uint8Array.from 代替逐字符 JS 循环：
                    // 10 MiB 图片约有一千万次循环，全部压在主线程上。
                    // atob 的输出每个字符都在 0~255，因此按码点映射与 charCodeAt 等价。
                    const bytes = Uint8Array.from(
                        binaryString,
                        (ch) => ch.charCodeAt(0),
                    );
                    const blob = new Blob([bytes], { type: getMimeType(entry.name) });
                    const container = document.createElement("div");
                    container.className = "preview-image-container";
                    container.appendChild(uiPreview.formatImagePreview(blob, entry.name));
                    els.previewBody.replaceChildren(container);
                } catch {
                    els.previewBody.innerHTML = '<div class="preview-error">图片预览失败</div>';
                }
            } else {
                const formatted = uiPreview.formatTextPreview(result.content);
                const pre = document.createElement("pre");
                pre.className = "preview-text";
                pre.innerHTML = formatted;
                els.previewBody.replaceChildren(pre);
            }
        } catch (error) {
            if (requestSeq !== state.previewFileRequestId) {
                return;
            }
            const errorBox = document.createElement("div");
            errorBox.className = "preview-error";
            errorBox.textContent = error.message || "预览失败";
            els.previewBody.replaceChildren(errorBox);
        } finally {
            if (state.previewAbortController === abortController) {
                state.previewAbortController = null;
            }
        }
    }

    function closePreviewDialog() {
        const els = state.elements;
        // 关掉弹窗就没必要再等这个预览了；顺手取消，免得它回来时又去改 DOM。
        if (state.previewAbortController) {
            state.previewAbortController.abort();
            state.previewAbortController = null;
        }
        uiPreview.revokeBlobUrl(els.previewBody);
        els.previewDialog.hidden = true;
        previewContent = "";
    }

    async function copyPreviewContent() {
        if (!previewContent) {
            return;
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(previewContent);
            } else {
                const textarea = document.createElement("textarea");
                textarea.value = previewContent;
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand("copy");
                textarea.remove();
            }
            const originalText = state.elements.previewCopyBtn.textContent;
            state.elements.previewCopyBtn.textContent = "已复制";
            setTimeout(() => {
                state.elements.previewCopyBtn.textContent = originalText;
            }, 1500);
        } catch {
            // Ignore copy errors
        }
    }

    function getMimeType(fileName) {
        const ext = uiPreview.getFileExtension(fileName);
        const mimeTypes = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".bmp": "image/bmp",
            ".webp": "image/webp",
            ".ico": "image/x-icon",
            ".tiff": "image/tiff",
            ".tif": "image/tiff",
        };
        return mimeTypes[ext] || "application/octet-stream";
    }

    function setElementText(element, text) {
        if (element) {
            element.textContent = text;
        }
    }

    function setElementClass(element, className) {
        if (element) {
            element.className = className;
        }
    }

    function withTimeout(promise, timeoutMs, timeoutMessage) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error(timeoutMessage);
                error.code = "TIMEOUT";
                reject(error);
            }, timeoutMs);
            promise.then(
                (result) => {
                    clearTimeout(timer);
                    resolve(result);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    // 重新打开同一压缩包页面时，若它正有进行中的后台任务，把主面板进度
    // 恢复过来——否则主面板显示「准备就绪 0%」而顶部任务流显示「进行中」，
    // 两处矛盾，用户可能重复点「开始解压」。
    async function resumeActiveJobIfAny() {
        const els = state.elements;
        if (!state.filePath || state.running) {
            return;
        }
        try {
            const data = await api.requestJson(api.apiUrl("jobs"), {
                timeoutMs: api.POLL_TIMEOUT_MS,
            });
            const active = (data?.active || []).find(
                (job) => job.archivePath === state.filePath,
            );
            if (!active) {
                return;
            }
            state.jobId = active.id;
            state.running = true;
            state.etaTracker = null;
            uiJobs.setJobProgress(
                active.progress || 0,
                "任务进行中",
                active.currentFile || "正在恢复任务进度...",
                state,
                active,
            );
            if (state.pollTimer) {
                state.pollTimer.stop();
            }
            state.pollTimer = uiJobs.createPoller(() => uiJobs.pollStatus(state, api), {
                interval: 1000,
            });
            state.pollTimer.start();
            await uiJobs.pollStatus(state, api);
        } catch (error) {
            // 恢复失败不影响页面正常打开：顶部任务流仍会显示该任务。
        }
    }

    async function loadApp() {
        const els = state.elements;
        await passwordManagerApi.renderSavedPasswords();
        state.filePath = getQueryPath();
        if (!state.filePath) {
            setElementText(els.toolStatus, "未选择文件");
            setElementClass(els.toolStatus, "status-badge fail");
            setElementText(els.notice, "请从 fnOS 文件管理器右键打开受支持的压缩包或首卷文件。");
            setElementClass(els.notice, "notice error");
            setElementText(els.archiveTitle, "没有接收到文件路径");
            setElementText(els.filePath, "支持普通压缩包、.7z.001、.zip.001、.part1.rar 等格式。");
            return;
        }

        try {
            setElementText(els.toolStatus, "检测中");
            setElementClass(els.toolStatus, "status-badge");
            const info = await withTimeout(
                api.requestJson(api.apiUrl("info", { path: state.filePath })),
                30000,
                "检测引擎超时",
            );
            uiDialogs.renderInfo(info, state);
            await uiDialogs.loadDirectoryRoots(state, api);
            await loadPreview();
            await commentManager.loadComment();
            await resumeActiveJobIfAny();
        } catch (error) {
            console.error("loadApp error:", error);
            setElementText(els.toolStatus, "不可用");
            setElementClass(els.toolStatus, "status-badge fail");
            setElementText(els.notice, error.message || "未知错误");
            setElementClass(els.notice, "notice error");
            setElementText(els.archiveTitle, "无法打开压缩包");
            setElementText(els.filePath, state.filePath);
            if (!uiDialogs.handlePermissionError(error, state)) {
                uiDialogs.recordDiagnosticError(error, state);
            }
        }
    }

    function updateActionAvailability() {
        const els = state.elements;
        const hasPreview = state.previewReady || state.previewLimited;
        const hasSelection = state.previewLimited || state.selectedPaths.size > 0;
        const passwordReady = !state.passwordRequired || state.passwordVerified;
        const ready = Boolean(
            state.info
            && state.info.tool
            && state.selectedDirectory
            && hasPreview
            && hasSelection
            && passwordReady
            && !state.running,
        );
        els.extractBtn.disabled = !ready;
        els.cancelBtn.hidden = !state.running;
        els.refreshPreviewBtn.disabled = state.running || state.previewing || !state.info;
        els.codePageSelect.disabled = state.running || state.previewing;
        els.openPasswordManagerBtn.disabled = state.running || state.previewing || !state.info;
        els.passwordInput.disabled = state.running || state.previewing;
        els.passwordPresetToggleBtn.disabled = state.running || state.previewing;
        els.showPasswordInput.disabled = state.running || state.previewing;
        els.openPasswordManagerFromPromptBtn.disabled = state.running || state.previewing;
        els.verifyPasswordBtn.disabled = state.running || state.previewing;
        els.cancelPasswordBtn.disabled = state.running || state.previewing;
        els.addPasswordBtn.disabled = state.running || state.previewing;
        els.editPasswordBtn.disabled = state.running || state.previewing
            || !state.selectedManagerPasswordId;
        els.deletePasswordBtn.disabled = state.running || state.previewing
            || !state.selectedManagerPasswordId;
        els.recordPasswordInput.disabled = state.running || state.previewing;
        els.recordLabelInput.disabled = state.running || state.previewing;
        els.confirmPasswordRecordBtn.disabled = state.running || state.previewing;
        els.openDirectoryPickerBtn.disabled = state.running || !state.info;
        passwordManagerApi.updatePasswordManagerStatus();
    }

    els.refreshPreviewBtn.addEventListener("click", loadPreview);
    els.codePageSelect.addEventListener("change", loadPreview);
    els.passwordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            verifyPasswordAndPreview();
        }
    });
    els.passwordInput.addEventListener("input", () => {
        const active = state.activeSavedPasswordId
            ? passwordStore.get(state.activeSavedPasswordId)
            : null;
        const inputSeq = ++state.passwordInputSeq;
        if (active) {
            active.then((entry) => {
                if (inputSeq !== state.passwordInputSeq) {
                    return;
                }
                if (entry && entry.password !== els.passwordInput.value) {
                    state.activeSavedPasswordId = "";
                }
                passwordManagerApi.invalidatePasswordVerification();
                uiDialogs.setPasswordPromptError("", state);
                passwordManagerApi.updatePasswordManagerStatus();
            });
        } else {
            passwordManagerApi.invalidatePasswordVerification();
            uiDialogs.setPasswordPromptError("", state);
            passwordManagerApi.updatePasswordManagerStatus();
        }
    });
    els.passwordPresetToggleBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        passwordManagerApi.togglePasswordPresetList();
    });
    els.showPasswordInput.addEventListener("change", togglePasswordVisibility);
    els.openPasswordManagerBtn.addEventListener("click", () => passwordManagerApi.openPasswordManager("main"));
    els.openPasswordManagerFromPromptBtn.addEventListener("click", () => passwordManagerApi.openPasswordManager("prompt"));
    els.closePasswordPromptDialogBtn.addEventListener("click", () => passwordManagerApi.closePasswordPrompt());
    els.cancelPasswordBtn.addEventListener("click", () => passwordManagerApi.closePasswordPrompt());
    els.verifyPasswordBtn.addEventListener("click", verifyPasswordAndPreview);
    els.closePasswordManagerDialogBtn.addEventListener("click", () => passwordManagerApi.closePasswordManager());
    els.confirmPasswordManagerBtn.addEventListener("click", () => passwordManagerApi.closePasswordManager());
    els.addPasswordBtn.addEventListener("click", () => passwordManagerApi.openPasswordRecordDialog("add"));
    els.editPasswordBtn.addEventListener("click", () => passwordManagerApi.openPasswordRecordDialog("edit"));
    els.deletePasswordBtn.addEventListener("click", () => passwordManagerApi.deleteSelectedPassword());
    els.closePasswordRecordDialogBtn.addEventListener("click", () => passwordManagerApi.closePasswordRecordDialog());
    els.cancelPasswordRecordBtn.addEventListener("click", () => passwordManagerApi.closePasswordRecordDialog());
    els.confirmPasswordRecordBtn.addEventListener("click", () => passwordManagerApi.savePasswordRecord());
    els.recordPasswordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            passwordManagerApi.savePasswordRecord();
        }
    });
    els.passwordPromptDialog.addEventListener("click", (event) => {
        if (event.target === els.passwordPromptDialog) {
            passwordManagerApi.closePasswordPrompt();
        }
    });
    els.passwordManagerDialog.addEventListener("click", (event) => {
        if (event.target === els.passwordManagerDialog) {
            passwordManagerApi.closePasswordManager();
        }
    });
    els.passwordRecordDialog.addEventListener("click", (event) => {
        if (event.target === els.passwordRecordDialog) {
            passwordManagerApi.closePasswordRecordDialog();
        }
    });
    document.addEventListener("click", (event) => {
        if (
            state.passwordPresetOpen
            && !els.passwordPresetList.contains(event.target)
            && event.target !== els.passwordPresetToggleBtn
        ) {
            passwordManagerApi.closePasswordPresetList();
        }
    });
    if (els.treeSearchInput) {
        els.treeSearchInput.addEventListener("input", () => {
            state.searchRenderId += 1;
            searchScheduler.schedule(() => uiTree.renderTree(state, treeApi));
        });
    }
    els.selectAllInput.addEventListener("change", () => {
        state.selectedPaths = els.selectAllInput.checked
            ? new Set(state.allFilePaths)
            : new Set();
        uiTree.renderTree(state, treeApi);
    });
    els.openDirectoryPickerBtn.addEventListener("click", async () => {
        if (!state.info) {
            return;
        }
        uiDialogs.openDirectoryDialog(state);
        try {
            await uiDialogs.refreshDirectoryRoots(state, api);
        } catch (error) {
            uiDialogs.closeDirectoryDialog(state);
            uiDialogs.setNotice(error.message, "error", state);
            if (!uiDialogs.handlePermissionError(error, state)) {
                uiDialogs.recordDiagnosticError(error, state);
            }
        }
    });
    els.closeDirectoryDialogBtn.addEventListener("click", () => uiDialogs.closeDirectoryDialog(state));
    els.cancelDirectoryBtn.addEventListener("click", () => uiDialogs.closeDirectoryDialog(state));
    els.chooseDirectoryBtn.addEventListener("click", () => {
        uiDialogs.chooseBrowsingDirectory(state);
        updateActionAvailability();
    });
    els.directoryUpBtn.addEventListener("click", () => uiDialogs.goUpDirectory(state, api));
    els.refreshDirectoryRootsBtn.addEventListener("click", () => uiDialogs.refreshDirectoryRoots(state, api));
    els.createDirectoryBtn.addEventListener("click", () => uiDialogs.openCreateDirectoryDialog(state));
    els.cancelCreateDirectoryBtn.addEventListener("click", () => uiDialogs.closeCreateDirectoryDialog(state));
    els.confirmCreateDirectoryBtn.addEventListener("click", () => uiDialogs.createDirectory(state, api));
    els.createDirectoryNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            uiDialogs.createDirectory(state, api);
        }
    });
    els.directoryDialog.addEventListener("click", (event) => {
        if (event.target === els.directoryDialog) {
            uiDialogs.closeDirectoryDialog(state);
        }
    });
    els.createDirectoryDialog.addEventListener("click", (event) => {
        if (event.target === els.createDirectoryDialog) {
            uiDialogs.closeCreateDirectoryDialog(state);
        }
    });
    els.extractBtn.addEventListener("click", () => {
        uiJobs.startExtract(state, api);
        updateActionAvailability();
    });
    els.cancelBtn.addEventListener("click", () => {
        uiJobs.cancelExtract(state, api);
        updateActionAvailability();
    });
    els.closeResultDialogBtn.addEventListener("click", closeResultDialog);
    els.confirmResultDialogBtn.addEventListener("click", closeResultDialog);
    els.resultDialog.addEventListener("click", (event) => {
        if (event.target === els.resultDialog) {
            closeResultDialog();
        }
    });
    els.diagnosticsBtn.addEventListener("click", openDiagnostics);
    els.closeDiagnosticsDialogBtn.addEventListener("click", closeDiagnostics);
    els.copyDiagnosticsBtn.addEventListener("click", () => {
        copyDiagnostics().catch((error) => {
            els.diagnosticsContent.textContent = `复制失败：${error.message}\n\n${diagnosticsText()}`;
        });
    });
    els.downloadDiagnosticsBtn.addEventListener("click", downloadDiagnostics);
    els.diagnosticsDialog.addEventListener("click", (event) => {
        if (event.target === els.diagnosticsDialog) {
            closeDiagnostics();
        }
    });
    els.closePermissionDialogBtn.addEventListener("click", () => uiDialogs.closePermissionDialog(state));
    els.retryPermissionBtn.addEventListener("click", retryPermissionAccess);
    els.permissionDiagnosticsBtn.addEventListener("click", openPermissionDiagnostics);
    els.permissionDialog.addEventListener("click", (event) => {
        if (event.target === els.permissionDialog) {
            uiDialogs.closePermissionDialog(state);
        }
    });

    els.themeToggle.addEventListener("click", () => {
        uiTheme.toggleTheme();
    });
    els.historyBtn.addEventListener("click", () => {
        uiJobs.openHistory(state, api);
    });
    els.closeHistoryBtn.addEventListener("click", () => {
        uiJobs.closeHistory(state);
    });
    els.closeHistoryConfirmBtn.addEventListener("click", () => {
        uiJobs.closeHistory(state);
    });
    els.clearHistoryBtn.addEventListener("click", () => {
        uiJobs.clearHistory(state, api);
    });
    els.historyDialog.addEventListener("click", (event) => {
        if (event.target === els.historyDialog) {
            uiJobs.closeHistory(state);
        }
    });
    els.closeTaskCenterBtn.addEventListener("click", () => {
        uiJobs.closeTaskCenter(state, api);
    });
    els.closeTaskCenterConfirmBtn.addEventListener("click", () => {
        uiJobs.closeTaskCenter(state, api);
    });
    els.taskCenterDialog.addEventListener("click", (event) => {
        if (event.target === els.taskCenterDialog) {
            uiJobs.closeTaskCenter(state, api);
        }
    });

    els.closePreviewBtn.addEventListener("click", closePreviewDialog);
    els.previewDialog.addEventListener("click", (event) => {
        if (event.target === els.previewDialog) {
            closePreviewDialog();
        }
    });
    els.previewCopyBtn.addEventListener("click", copyPreviewContent);

    els.closeCommentDialogBtn.addEventListener("click", () => commentManager.closeCommentDialog());
    els.cancelCommentBtn.addEventListener("click", () => commentManager.closeCommentDialog());
    els.saveCommentBtn.addEventListener("click", () => commentManager.saveComment());
    els.commentCopyBtn.addEventListener("click", () => commentManager.copyComment());
    els.commentDialog.addEventListener("click", (event) => {
        if (event.target === els.commentDialog) {
            commentManager.closeCommentDialog();
        }
    });
    els.openCommentBtn.addEventListener("click", () => commentManager.openCommentDialog());

    // 统一停掉所有轮询器。轮询器是对象（不是定时器句柄），必须调用 stop()，
    // 否则会残留定时器与 visibilitychange 监听。
    function stopAllPollers() {
        for (const key of [
            "pollTimer",
            "taskCenterTimer",
            "taskWatchTimer",
            "historyTimer",
        ]) {
            if (state[key]) {
                state[key].stop();
                state[key] = null;
            }
        }
        if (state.historyClearTimer) {
            clearTimeout(state.historyClearTimer);
            state.historyClearTimer = null;
        }
    }

    // Esc 关闭最上层可见弹窗。弹窗众多、关闭函数分散，这里用一个注册表
    // 统一处理，避免给 11 个弹窗各写一遍。层级：preview(1000) > nested(60)
    // > 普通(50)，同层按 DOM 顺序后者优先（后开的在上）。
    const dialogClosers = [
        ["previewDialog", () => closePreviewDialog()],
        ["createDirectoryDialog", () => uiDialogs.closeCreateDirectoryDialog(state)],
        ["passwordRecordDialog", () => passwordManagerApi.closePasswordRecordDialog()],
        ["directoryDialog", () => uiDialogs.closeDirectoryDialog(state)],
        ["passwordPromptDialog", () => passwordManagerApi.closePasswordPrompt()],
        ["passwordManagerDialog", () => passwordManagerApi.closePasswordManager()],
        ["permissionDialog", () => uiDialogs.closePermissionDialog(state)],
        ["resultDialog", () => closeResultDialog()],
        ["diagnosticsDialog", () => closeDiagnostics()],
        ["taskCenterDialog", () => uiJobs.closeTaskCenter(state, api)],
        ["historyDialog", () => uiJobs.closeHistory(state)],
        ["commentDialog", () => commentManager.closeCommentDialog()],
    ];
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }
        // 从最上层往后找第一个可见的弹窗关掉。preview-backdrop 用 previewDialog
        // 也在同一注册表里（它 z-index 最高，排最前）。
        for (const [id, close] of dialogClosers) {
            const element = document.getElementById(id);
            if (element && !element.hidden) {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
            }
        }
    });

    window.addEventListener("beforeunload", stopAllPollers);
    window.addEventListener("pagehide", stopAllPollers);

    // pagehide 停掉的轮询器要在 bfcache 恢复时重启，否则 fnOS 内嵌窗口
    // 隐藏再切回后任务栏永久停更（pagehide≠unload，页面会被 bfcache 保留）。
    // 恢复逻辑在 ui-jobs.resumePollers：只处理 persisted=true，按当前
    // 任务/弹窗状态重启对应轮询器。
    window.addEventListener("pageshow", (event) => uiJobs.resumePollers(state, api, event));

    loadApp()
        .then(updateActionAvailability)
        .catch((error) => {
            console.error("CHzip initialization error:", error);
            const els = state.elements;
            if (els.notice) {
                els.notice.className = "notice error";
                els.notice.textContent = `初始化失败：${error.message}`;
            }
        });
    uiJobs.startTaskWatch(state, api);
}());
