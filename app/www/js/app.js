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

    const initialTheme = uiTheme.initTheme();
    uiTheme.updateThemeUI(initialTheme);

    state.onPreviewFile = previewFile;
    state.onAvailabilityChange = updateActionAvailability;

    const els = state.elements;

    const searchScheduler = treeApi.createSearchScheduler({ delay: 180 });

    let parseWorker = null;
    let parseWorkerRequestId = 0;

    function parseWithWorker(text, maxEntries, maxBytes) {
        return new Promise((resolve, reject) => {
            if (!window.Worker) {
                reject(new Error("浏览器不支持 Web Worker"));
                return;
            }
            if (!parseWorker) {
                try {
                    parseWorker = new Worker("./index.cgi/js/parse-worker.js");
                } catch (error) {
                    reject(error);
                    return;
                }
            }
            const requestId = ++parseWorkerRequestId;
            const onMessage = (event) => {
                if (event.data.requestId !== requestId) {
                    return;
                }
                parseWorker.removeEventListener("message", onMessage);
                parseWorker.removeEventListener("error", onError);
                if (event.data.error) {
                    reject(new Error(event.data.error));
                } else {
                    resolve(event.data.result);
                }
            };
            const onError = (error) => {
                parseWorker.removeEventListener("message", onMessage);
                parseWorker.removeEventListener("error", onError);
                reject(error);
            };
            parseWorker.addEventListener("message", onMessage);
            parseWorker.addEventListener("error", onError);
            parseWorker.postMessage({ requestId, text, maxEntries, maxBytes });
        });
    }

    function getQueryPath() {
        return new URLSearchParams(window.location.search).get("path") || "";
    }

    function currentArchiveKey() {
        return String(state.info?.fileName || "").toLocaleLowerCase();
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
        els.previewBody.innerHTML = '<div class="preview-loading">正在加载预览...</div>';
        els.previewInfo.textContent = uiPreview.formatSize(entry.size);
        els.previewCopyBtn.hidden = !uiPreview.isTextFile(entry.name);
        previewContent = "";

        const requestSeq = ++state.previewFileRequestId;
        try {
            const result = await api.postApi("preview-file", {
                path: state.filePath,
                targetPath,
                password: els.passwordInput.value,
                codePage: els.codePageSelect.value,
            });
            if (requestSeq !== state.previewFileRequestId) {
                return;
            }
            previewContent = result.content;
            const fileType = uiPreview.getFileType(entry.name);
            if (fileType === "image") {
                els.previewIcon.textContent = "🖼️";
                try {
                    const binaryString = atob(result.content);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: getMimeType(entry.name) });
                    const container = document.createElement("div");
                    container.className = "preview-image-container";
                    container.appendChild(uiPreview.formatImagePreview(blob, entry.name));
                    els.previewBody.replaceChildren(container);
                } catch {
                    els.previewBody.innerHTML = '<div class="preview-error">图片预览失败</div>';
                }
            } else {
                els.previewIcon.textContent = "📄";
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
        }
    }

    function closePreviewDialog() {
        const els = state.elements;
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
        const newTheme = uiTheme.toggleTheme();
        uiTheme.updateThemeUI(newTheme);
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

    window.addEventListener("beforeunload", () => {
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    });

    window.addEventListener("pagehide", () => {
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    });

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
}());
