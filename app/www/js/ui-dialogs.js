(function (root) {
    "use strict";

    function formatSize(size) {
        if (!Number.isFinite(Number(size))) {
            return "-";
        }
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = Number(size);
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        const digits = value >= 10 || unit === 0 ? 0 : 1;
        return `${value.toFixed(digits)} ${units[unit]}`;
    }

    function setNotice(message, kind, state) {
        const els = state.elements;
        els.notice.className = `notice ${kind || ""}`.trim();
        els.notice.textContent = message;
    }

    function setToolStatus(text, kind, state) {
        const els = state.elements;
        els.toolStatus.className = `status-badge ${kind || ""}`.trim();
        els.toolStatus.textContent = text;
    }

    function setPasswordPromptError(message, state) {
        const els = state.elements;
        els.passwordPromptError.textContent = message || "";
        els.passwordPromptError.hidden = !message;
    }

    function setPasswordRecordError(message, state) {
        const els = state.elements;
        els.passwordRecordError.textContent = message || "";
        els.passwordRecordError.hidden = !message;
    }

    function setCreateDirectoryError(message, state) {
        const els = state.elements;
        els.createDirectoryError.textContent = message || "";
        els.createDirectoryError.hidden = !message;
    }

    function isPermissionError(error) {
        return error?.code === "SOURCE_FILE_DENIED"
            || error?.code === "SOURCE_PARENT_DENIED";
    }

    function openPermissionDialog(error, state) {
        const els = state.elements;
        state.permissionError = error || null;
        const deniedPath = error?.details?.path
            || error?.path
            || state.filePath;
        const fileName = String(deniedPath || "")
            .split("/")
            .filter(Boolean)
            .pop() || "当前文件";
        els.permissionDialogMessage.textContent = `当前文件未授予 CHzip 读取权限：“${fileName}”。请按以下步骤为上一级文件夹添加应用权限。`;
        els.permissionDialog.hidden = false;
    }

    function closePermissionDialog(state) {
        state.elements.permissionDialog.hidden = true;
    }

    function handlePermissionError(error, state) {
        if (!isPermissionError(error)) {
            return false }
        recordDiagnosticError(error, state);
        openPermissionDialog(error, state);
        return true;
    }

    function recordDiagnosticError(error, state) {
        state.lastRequestId = error?.requestId || "";
        state.diagnosticsReport = null;
        state.elements.diagnosticsBtn.hidden = !state.filePath;
    }

    function clearDiagnosticError(state) {
        state.lastRequestId = "";
        state.diagnosticsReport = null;
        state.elements.diagnosticsBtn.hidden = true;
    }

    function diagnosticsText(state) {
        return JSON.stringify(state.diagnosticsReport || {}, null, 2);
    }

    function archiveTypeLabel(info) {
        const format = info?.selection?.format;
        if (format) {
            return format === "bzip2" ? "BZ2" : format.toUpperCase().slice(0, 5);
        }
        return info?.selection?.kind === "split" ? "SPLIT" : "ARC";
    }

    function renderWarnings(warnings, state) {
        const els = state.elements;
        if (!warnings?.length) {
            els.warningList.hidden = true;
            els.warningList.textContent = "";
            return;
        }
        els.warningList.hidden = false;
        els.warningList.textContent = warnings.join("；");
    }

    function renderVolumes(parts, state) {
        const els = state.elements;
        els.volumeList.replaceChildren();
        els.volumeCount.textContent = String(parts?.length || 0);
        for (const part of parts || []) {
            const item = document.createElement("div");
            item.className = "volume-item";
            const name = document.createElement("span");
            name.textContent = part.name;
            name.title = part.path;
            const size = document.createElement("span");
            size.textContent = formatSize(part.size);
            item.append(name, size);
            els.volumeList.append(item);
        }
    }

    function renderInfo(info, state) {
        const els = state.elements;
        state.info = info;
        state.filePath = info.filePath;
        els.archiveType.textContent = archiveTypeLabel(info);
        els.archiveTitle.textContent = info.fileName;
        els.filePath.textContent = info.filePath;
        els.partCount.textContent = String(info.partCount || 1);
        renderWarnings(info.warnings, state);
        renderVolumes(info.parts, state);
        if (info.tool) {
            const sourceMap = {
                bundled: "内置 7-Zip 就绪",
                system: "系统 7-Zip 就绪",
                env: "指定 7-Zip 就绪",
            };
            setToolStatus(sourceMap[info.tool.source] || "7-Zip 就绪", "ok", state);
        } else {
            setToolStatus("缺少 7-Zip", "fail", state);
        }
        updateOutputPreview(state);
    }

    function updateOutputPreview(state) {
        const els = state.elements;
        const directory = state.selectedDirectory;
        els.selectedDirectoryPath.textContent = directory || "-";
        els.selectedDirectoryPath.title = directory || "-";
        if (!directory || !state.info) {
            els.outputPreview.textContent = "-";
            return;
        }
        const separator = directory.endsWith("/") ? "" : "/";
        els.outputPreview.textContent = `${directory}${separator}${state.info.outputStem}`;
    }

    function pathWithin(root, candidate) {
        if (!root || !candidate) {
            return false;
        }
        const normalizedRoot = root.replace(/\/+$/, "");
        return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
    }

    function currentBrowsingRoot(state) {
        return state.directoryRoots
            .filter((root) => pathWithin(directoryRootPath(root), state.pendingDirectory))
            .sort((a, b) => directoryRootPath(b).length - directoryRootPath(a).length)[0]
            || null;
    }

    function directoryRootPath(root) {
        return typeof root === "string" ? root : root.path;
    }

    function selectDirectoryNode(node, state) {
        const els = state.elements;
        state.pendingDirectory = node.path;
        state.pendingDirectorySelectable = Boolean(node.canSelect);
        els.directoryDialogPath.textContent = node.path;
        els.directoryDialogPath.title = node.path;
        els.chooseDirectoryBtn.disabled = !node.canSelect;
        els.createDirectoryBtn.disabled = !node.canSelect;
        const root = currentBrowsingRoot(state);
        els.directoryUpBtn.disabled = !root
            || state.pendingDirectory === directoryRootPath(root);
        renderDirectoryTree(state);
    }

    function appendDirectoryNode(container, node, depth, state, api) {
        const els = state.elements;
        const row = document.createElement("div");
        row.className = "directory-node-row";
        row.style.setProperty("--directory-depth", depth);
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-selected", String(node.path === state.pendingDirectory));
        if (node.path === state.pendingDirectory) {
            row.classList.add("is-selected");
        }

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "directory-node-toggle";
        toggle.textContent = "›";
        toggle.title = "展开目录";
        toggle.disabled = !node.canBrowse;
        if (state.directoryExpanded.has(node.path)) {
            toggle.classList.add("is-open");
        }
        toggle.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (state.directoryExpanded.has(node.path)) {
                state.directoryExpanded.delete(node.path);
                renderDirectoryTree(state);
                return;
            }
            state.directoryExpanded.add(node.path);
            renderDirectoryTree(state);
            await loadDirectoryChildren(node.path, state, api);
        });

        const label = document.createElement("button");
        label.type = "button";
        label.className = "directory-node-label";
        label.textContent = depth === 0 ? node.path : (node.name || node.path);
        label.title = node.path;
        label.addEventListener("click", () => selectDirectoryNode(node, state));

        const status = document.createElement("small");
        status.textContent = node.canSelect ? "可选择" : "只读";
        row.append(toggle, label, status);
        container.append(row);

        if (!state.directoryExpanded.has(node.path)) {
            return;
        }
        const listing = state.directoryCache.get(node.path);
        if (!listing) {
            const loading = document.createElement("div");
            loading.className = "directory-tree-state";
            loading.style.setProperty("--directory-depth", depth + 1);
            loading.textContent = "正在加载...";
            container.append(loading);
            return;
        }
        if (!listing.children.length) {
            const empty = document.createElement("div");
            empty.className = "directory-tree-state";
            empty.style.setProperty("--directory-depth", depth + 1);
            empty.textContent = "没有子目录";
            container.append(empty);
            return;
        }
        for (const child of listing.children) {
            appendDirectoryNode(container, child, depth + 1, state, api);
        }
    }

    function renderDirectoryTree(state, api) {
        const els = state.elements;
        els.directoryTree.replaceChildren();
        if (!state.directoryRoots.length) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "没有可访问的授权目录";
            els.directoryTree.append(empty);
            return;
        }
        for (const root of state.directoryRoots) {
            appendDirectoryNode(els.directoryTree, {
                name: directoryRootPath(root),
                path: directoryRootPath(root),
                canBrowse: root.canBrowse ?? true,
                canSelect: root.canSelect ?? true,
            }, 0, state, api);
        }
    }

    async function loadDirectoryChildren(directoryPath, state, api, force = false) {
        const els = state.elements;
        if (!force && state.directoryCache.has(directoryPath)) {
            return state.directoryCache.get(directoryPath);
        }
        const requestId = state.directoryRequestId;
        try {
            const result = await api.requestJson(api.apiUrl("directories", {
                archivePath: state.filePath,
                path: directoryPath,
            }));
            if (requestId !== state.directoryRequestId || els.directoryDialog.hidden) {
                return null;
            }
            state.directoryCache.set(directoryPath, result);
            renderDirectoryTree(state, api);
            return result;
        } catch (error) {
            if (requestId === state.directoryRequestId) {
                state.directoryExpanded.delete(directoryPath);
                renderDirectoryTree(state, api);
                setNotice(error.message, "error", state);
                recordDiagnosticError(error, state);
            }
            return null;
        }
    }

    async function revealDirectoryPath(directoryPath, state, api) {
        const root = state.directoryRoots
            .filter((entry) => pathWithin(directoryRootPath(entry), directoryPath))
            .sort((a, b) => directoryRootPath(b).length - directoryRootPath(a).length)[0];
        if (!root) {
            return;
        }
        let current = directoryRootPath(root);
        state.directoryExpanded.add(current);
        await loadDirectoryChildren(current, state, api);
        const relative = directoryPath.slice(current.length)
            .split("/")
            .filter(Boolean);
        for (const segment of relative) {
            current = `${current.replace(/\/$/, "")}/${segment}`;
            state.directoryExpanded.add(current);
            await loadDirectoryChildren(current, state, api);
        }
        const listing = state.directoryCache.get(directoryPath);
        selectDirectoryNode({
            path: directoryPath,
            canSelect: listing?.canSelect ?? true,
        }, state);
    }

    async function loadDirectoryRoots(state, api) {
        const result = await api.requestJson(api.apiUrl("directories", {
            archivePath: state.filePath,
        }));
        state.directoryRoots = result.roots || [];
        state.selectedDirectory = result.defaultPath || "";
        updateOutputPreview(state);
        return result;
    }

    async function refreshDirectoryRoots(state, api) {
        const requestId = ++state.directoryRequestId;
        state.directoryCache.clear();
        state.directoryExpanded.clear();
        const result = await loadDirectoryRoots(state, api);
        if (requestId !== state.directoryRequestId) {
            return;
        }
        state.pendingDirectory = state.selectedDirectory;
        state.pendingDirectorySelectable = Boolean(state.pendingDirectory);
        renderDirectoryTree(state, api);
        if (state.pendingDirectory) {
            await revealDirectoryPath(state.pendingDirectory, state, api);
        }
    }

    function openDirectoryDialog(state) {
        state.elements.directoryDialog.hidden = false;
    }

    function closeDirectoryDialog(state) {
        state.directoryRequestId += 1;
        state.elements.directoryDialog.hidden = true;
    }

    function chooseBrowsingDirectory(state) {
        if (!state.pendingDirectorySelectable) {
            return;
        }
        state.selectedDirectory = state.pendingDirectory;
        updateOutputPreview(state);
        closeDirectoryDialog(state);
    }

    async function goUpDirectory(state, api) {
        const els = state.elements;
        const root = currentBrowsingRoot(state);
        if (!root) {
            return;
        }
        const rootPath = directoryRootPath(root);
        const parent = state.pendingDirectory.replace(/\/[^/]+\/?$/, "") || "/";
        const target = pathWithin(rootPath, parent) ? parent : rootPath;
        try {
            const listing = await loadDirectoryChildren(target, state, api);
            selectDirectoryNode({
                path: target,
                canSelect: listing?.canSelect ?? (target === rootPath
                    ? (root.canSelect ?? true)
                    : false),
            }, state);
        } catch (error) {
            setNotice(error.message, "error", state);
            if (!handlePermissionError(error, state)) {
                recordDiagnosticError(error, state);
            }
        }
    }

    function openCreateDirectoryDialog(state) {
        if (!state.pendingDirectorySelectable) {
            return;
        }
        const els = state.elements;
        els.createDirectoryNameInput.value = "";
        setCreateDirectoryError("", state);
        els.createDirectoryDialog.hidden = false;
        els.createDirectoryNameInput.focus();
    }

    function closeCreateDirectoryDialog(state) {
        state.elements.createDirectoryDialog.hidden = true;
        setCreateDirectoryError("", state);
    }

    async function createDirectory(state, api) {
        const els = state.elements;
        const name = els.createDirectoryNameInput.value.trim();
        if (!name) {
            setCreateDirectoryError("请输入文件夹名称。", state);
            return;
        }
        els.confirmCreateDirectoryBtn.disabled = true;
        try {
            const result = await api.postApi("create-directory", {
                archivePath: state.filePath,
                parentPath: state.pendingDirectory,
                name,
            });
            state.directoryCache.delete(state.pendingDirectory);
            await loadDirectoryChildren(state.pendingDirectory, state, api, true);
            state.directoryExpanded.add(state.pendingDirectory);
            closeCreateDirectoryDialog(state);
            selectDirectoryNode(result, state);
        } catch (error) {
            setCreateDirectoryError(error.message, state);
        } finally {
            els.confirmCreateDirectoryBtn.disabled = false;
        }
    }

    root.CHzipUiDialogs = {
        chooseBrowsingDirectory,
        closeCreateDirectoryDialog,
        closeDirectoryDialog,
        closePermissionDialog,
        createDirectory,
        currentBrowsingRoot,
        directoryRootPath,
        formatSize,
        goUpDirectory,
        handlePermissionError,
        isPermissionError,
        loadDirectoryChildren,
        loadDirectoryRoots,
        openCreateDirectoryDialog,
        openDirectoryDialog,
        openPermissionDialog,
        refreshDirectoryRoots,
        renderDirectoryTree,
        renderInfo,
        renderVolumes,
        renderWarnings,
        revealDirectoryPath,
        selectDirectoryNode,
        setCreateDirectoryError,
        setNotice,
        setPasswordPromptError,
        setPasswordRecordError,
        setToolStatus,
        updateOutputPreview,
    };
}(typeof window !== "undefined" ? window : globalThis));
