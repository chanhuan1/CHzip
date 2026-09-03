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

    function appendSearchFileRow(container, entry, state, treeApi) {
        const row = document.createElement("div");
        row.className = "tree-row tree-search-row";
        row.style.setProperty("--tree-depth", "0");
        row.title = entry.path;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "tree-toggle is-placeholder";
        toggle.tabIndex = -1;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tree-checkbox";
        checkbox.checked = state.selectedPaths.has(entry.path);
        checkbox.setAttribute("aria-label", `选择 ${entry.path}`);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                state.selectedPaths.add(entry.path);
            } else {
                state.selectedPaths.delete(entry.path);
            }
            updateSelectionSummary(state);
        });

        const icon = document.createElement("span");
        icon.className = "tree-icon file";
        icon.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = "tree-label";
        const normalizedPath = String(entry.path || "").replace(/\\/g, "/");
        label.textContent = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);

        const size = document.createElement("span");
        size.className = "tree-size";
        size.textContent = formatSize(entry.size);

        row.append(toggle, checkbox, icon, label, size);
        container.append(row);
    }

    function appendTreeNode(container, node, depth, state, treeApi) {
        const row = document.createElement("div");
        row.className = "tree-row";
        row.style.setProperty("--tree-depth", String(depth));
        row.title = node.path;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "tree-toggle";
        const hasChildren = node.type === "directory" && node.children?.length;
        if (!hasChildren) {
            toggle.classList.add("is-placeholder");
        } else {
            toggle.textContent = "›";
            toggle.classList.toggle("is-open", state.expandedPaths.has(node.path));
            toggle.setAttribute("aria-label", state.expandedPaths.has(node.path) ? "折叠目录" : "展开目录");
            toggle.addEventListener("click", () => {
                if (state.expandedPaths.has(node.path)) {
                    state.expandedPaths.delete(node.path);
                } else {
                    state.expandedPaths.add(node.path);
                }
                renderTree(state, treeApi);
            });
        }

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tree-checkbox";
        const nodeState = treeApi.selectionState(node, state.selectedPaths);
        checkbox.checked = nodeState === "checked";
        checkbox.indeterminate = nodeState === "mixed";
        checkbox.setAttribute("aria-label", `选择 ${node.path}`);
        checkbox.addEventListener("change", () => {
            const paths = treeApi.collectDescendantFiles(node);
            for (const filePath of paths) {
                if (checkbox.checked) {
                    state.selectedPaths.add(filePath);
                } else {
                    state.selectedPaths.delete(filePath);
                }
            }
            renderTree(state, treeApi);
        });

        const icon = document.createElement("span");
        icon.className = `tree-icon ${node.type === "directory" ? "folder" : "file"}`;
        icon.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = "tree-label";
        label.textContent = node.name;

        const size = document.createElement("span");
        size.className = "tree-size";
        size.textContent = node.type === "file" ? formatSize(node.size) : "";

        row.append(toggle, checkbox, icon, label, size);

        if (node.type === "file" && state.previewableFiles && state.previewableFiles.has(node.path)) {
            const previewBtn = document.createElement("button");
            previewBtn.type = "button";
            previewBtn.className = "tree-preview-btn";
            previewBtn.textContent = "👁";
            previewBtn.title = "预览文件";
            previewBtn.setAttribute("aria-label", `预览 ${node.name}`);
            previewBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                if (state.onPreviewFile) {
                    state.onPreviewFile(node.path);
                }
            });
            row.append(previewBtn);
        }

        container.append(row);

        if (hasChildren && state.expandedPaths.has(node.path)) {
            for (const child of node.children) {
                appendTreeNode(container, child, depth + 1, state, treeApi);
            }
        }
    }

    function updateSelectionSummary(state) {
        const selectedCount = state.previewLimited
            ? state.allFilePaths.length
            : state.selectedPaths.size;
        const els = state.elements;
        if (state.previewLimited) {
            els.selectionSummary.textContent = "预览受限，将解压全部文件";
        } else if (!state.previewReady) {
            els.selectionSummary.textContent = "等待预览";
        } else {
            els.selectionSummary.textContent = `已选择 ${selectedCount} / ${state.allFilePaths.length} 个文件`;
        }

        const allSelected = state.allFilePaths.length > 0
            && state.selectedPaths.size === state.allFilePaths.length;
        els.selectAllInput.checked = allSelected;
        els.selectAllInput.indeterminate = state.selectedPaths.size > 0 && !allSelected;
        state.onAvailabilityChange?.();
    }

    function renderSearchResults(query, renderId, state, treeApi) {
        const els = state.elements;
        const matches = treeApi.searchFiles(state.entries, query);
        if (!matches.length) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "没有匹配的文件";
            els.fileTree.append(empty);
            return;
        }

        treeApi.renderBatches(matches, {
            batchSize: 200,
            scheduleFrame(callback) {
                if (window.requestAnimationFrame) {
                    window.requestAnimationFrame(callback);
                } else {
                    window.setTimeout(callback, 0);
                }
            },
            isCurrent() {
                return (
                    renderId === state.searchRenderId
                    && query === (els.treeSearchInput?.value.trim() || "")
                );
            },
            renderBatch(entries) {
                const fragment = document.createDocumentFragment();
                for (const entry of entries) {
                    appendSearchFileRow(fragment, entry, state, treeApi);
                }
                els.fileTree.append(fragment);
            },
        });
    }

    function renderTree(state, treeApi) {
        const els = state.elements;
        const renderId = ++state.searchRenderId;
        els.fileTree.replaceChildren();
        if (!state.previewReady && !state.previewLimited) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "尚未载入压缩包目录";
            els.fileTree.append(empty);
            updateSelectionSummary(state);
            return;
        }
        if (state.previewLimited) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = "压缩包内容超过预览限制，将按整包方式解压。";
            els.fileTree.append(empty);
            updateSelectionSummary(state);
            return;
        }

        const query = els.treeSearchInput?.value.trim() || "";
        if (query) {
            renderSearchResults(query, renderId, state, treeApi);
            updateSelectionSummary(state);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const node of state.tree) {
            appendTreeNode(fragment, node, 0, state, treeApi);
        }
        els.fileTree.append(fragment);
        updateSelectionSummary(state);
    }

    function setPreviewControls(enabled, state) {
        const els = state.elements;
        els.selectAllInput.disabled = !enabled;
        if (els.treeSearchInput) {
            els.treeSearchInput.disabled = !enabled;
        }
    }

    root.CHzipUiTree = {
        formatSize,
        renderTree,
        setPreviewControls,
        updateSelectionSummary,
    };
}(typeof window !== "undefined" ? window : globalThis));
