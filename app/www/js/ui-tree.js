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

    // 用内联 SVG 代替原先 CSS 画的圆角方框：文件夹与文件都是实心双色调，
    // 主体用竖向渐变（渐变为 index.html 中的 #chzipFolderBody / #chzipFileBody），
    // 顶部平涂部分分别为页签与折角。
    const TREE_ICONS = {
        folder: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<path class="tree-icon-tab" d="M2.5 6V2.42A1.2 1.2 0 0 1 3.7 1.22'
            + 'H7.3A1.2 1.2 0 0 1 8.5 2.42V6Z"/>'
            + '<path class="tree-icon-folder-body" d="M2.6 4.6H13.4A1.6 1.6 0 0 1 15 6.2'
            + 'V13.18A1.6 1.6 0 0 1 13.4 14.78H2.6A1.6 1.6 0 0 1 1 13.18'
            + 'V6.2A1.6 1.6 0 0 1 2.6 4.6Z"/>'
            + "</svg>",
        file: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<path class="tree-icon-file-body" d="M3.9 1.25H9.5L13.5 5.25V13.35'
            + 'A1.4 1.4 0 0 1 12.1 14.75H3.9A1.4 1.4 0 0 1 2.5 13.35'
            + 'V2.65A1.4 1.4 0 0 1 3.9 1.25Z"/>'
            + '<path class="tree-icon-fold" d="M9.5 1.25L13.5 5.25H10.7'
            + 'A1.2 1.2 0 0 1 9.5 4.05Z"/>'
            + "</svg>",
    };

    // 预览按钮的“眼睛”图标：不用 emoji（各平台字形/配色不一致，Linux 上
    // 还可能落到替代字体），改为矢量图标，与树图标同一套 currentColor 方案。
    const PREVIEW_EYE_ICON = '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
        + '<path class="tree-preview-eye" d="M1.6 8C3.1 5.3 5.4 3.6 8 3.6'
        + 'C10.6 3.6 12.9 5.3 14.4 8C12.9 10.7 10.6 12.4 8 12.4'
        + 'C5.4 12.4 3.1 10.7 1.6 8Z"/>'
        + '<circle class="tree-preview-pupil" cx="8" cy="8" r="2.1"/>'
        + "</svg>";

    const RENDER_BATCH_SIZE = 200;

    // ---------------------------------------------------------------- 渲染期索引
    //
    // 原先每个节点各自挂 click/change 监听，一次重渲染就要销毁重建上千个监听器；
    // 勾选/展开也直接全量 renderTree（重建整棵树 + 重建全部监听器）。
    // 现在改为：容器级事件委托（每棵树只挂 2 个监听）+ 渲染期建立
    // 「path → 节点 / path → 复选框」索引，勾选时只更新受影响的复选框。
    //
    // 页面里只有一棵文件树，因此这些模块级变量是安全的。
    let nodeIndex = new Map();
    let checkboxIndex = new Map();
    let activeState = null;
    let activeTreeApi = null;
    // 当前这棵树的选中计数（path→node 的 Map 的反向：以节点对象为键）。
    // 必须放在模块级而不是 renderTree 的闭包里：分批渲染可能跨多帧，
    // 用户在这期间勾选会让"渲染开始时算的 counts"过期，
    // 后续批次就会渲染出与 state.selectedPaths 矛盾的复选框状态。
    let activeCounts = new Map();
    const delegatedContainers = new WeakSet();

    function createTreeIcon(isDirectory) {
        const icon = document.createElement("span");
        icon.className = `tree-icon ${isDirectory ? "folder" : "file"}`;
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = isDirectory ? TREE_ICONS.folder : TREE_ICONS.file;
        return icon;
    }

    function registerRow(row, path) {
        row.dataset.path = path;
        return row;
    }

    function appendSearchFileRow(container, entry, state, treeApi) {
        const row = registerRow(document.createElement("div"), entry.path);
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
        checkboxIndex.set(entry.path, checkbox);

        const icon = createTreeIcon(false);

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

    function appendTreeNode(container, node, depth, state, treeApi, counts) {
        const row = registerRow(document.createElement("div"), node.path);
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
            toggle.setAttribute(
                "aria-label",
                state.expandedPaths.has(node.path) ? "折叠目录" : "展开目录",
            );
        }

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tree-checkbox";
        const nodeState = treeApi.selectionState(node, state.selectedPaths, counts);
        checkbox.checked = nodeState === "checked";
        checkbox.indeterminate = nodeState === "mixed";
        checkbox.setAttribute("aria-label", `选择 ${node.path}`);
        checkboxIndex.set(node.path, checkbox);

        const icon = createTreeIcon(node.type === "directory");

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
            previewBtn.innerHTML = PREVIEW_EYE_ICON;
            previewBtn.title = "预览文件";
            previewBtn.setAttribute("aria-label", `预览 ${node.name}`);
            row.append(previewBtn);
        }

        container.append(row);
    }

    // 把「可见节点」摊平成一个列表（只包含已展开的分支），
    // 以便分批渲染，避免一次性同步建出成百上千个 DOM 节点。
    function flattenVisibleNodes(nodes, state) {
        const out = [];
        const walk = (node, depth) => {
            out.push({ node, depth });
            if (
                node.type === "directory"
                && node.children
                && node.children.length
                && state.expandedPaths.has(node.path)
            ) {
                for (const child of node.children) {
                    walk(child, depth + 1);
                }
            }
        };
        for (const node of nodes || []) {
            walk(node, 0);
        }
        return out;
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

    function syncCheckbox(path, counts, treeApi) {
        const checkbox = checkboxIndex.get(path);
        const node = nodeIndex.get(path);
        if (!checkbox || !node) {
            return;
        }
        const nodeState = treeApi.stateFromCounts(counts.get(node));
        checkbox.checked = nodeState === "checked";
        checkbox.indeterminate = nodeState === "mixed";
    }

    // 勾选变化只做数据更新 + 受影响复选框的定向刷新，
    // 不再整棵树重建（原先勾选一个文件就要重建整棵树和全部监听器）。
    function applySelectionChange(path, checked, state, treeApi) {
        const node = nodeIndex.get(path);
        if (!node) {
            // 搜索结果行：只有单个文件、没有对应的树节点。
            if (checked) {
                state.selectedPaths.add(path);
            } else {
                state.selectedPaths.delete(path);
            }
            updateSelectionSummary(state);
            return;
        }
        const affected = treeApi.collectDescendantFiles(node);
        for (const filePath of affected) {
            if (checked) {
                state.selectedPaths.add(filePath);
            } else {
                state.selectedPaths.delete(filePath);
            }
        }

        activeCounts = treeApi.computeSelectionCounts(state.tree, state.selectedPaths);
        for (const filePath of affected) {
            syncCheckbox(filePath, activeCounts, treeApi);
        }
        syncCheckbox(path, activeCounts, treeApi);

        // 祖先链的"部分选中"状态需要跟着变。
        let parentPath = node.parentPath || "";
        const visited = new Set();
        while (parentPath && !visited.has(parentPath)) {
            visited.add(parentPath);
            syncCheckbox(parentPath, activeCounts, treeApi);
            const parentNode = nodeIndex.get(parentPath);
            parentPath = parentNode ? (parentNode.parentPath || "") : "";
        }
        for (const top of state.tree) {
            syncCheckbox(top.path, activeCounts, treeApi);
        }

        updateSelectionSummary(state);
    }

    function rowPathFromEvent(event, selector) {
        const target = event.target;
        if (!target || typeof target.closest !== "function") {
            return null;
        }
        const hit = target.closest(selector);
        if (!hit) {
            return null;
        }
        const row = hit.closest(".tree-row");
        if (!row) {
            return null;
        }
        const path = row.dataset.path;
        return path === undefined ? null : path;
    }

    function ensureDelegatedHandlers(container) {
        if (delegatedContainers.has(container)) {
            return;
        }
        delegatedContainers.add(container);

        container.addEventListener("click", (event) => {
            const state = activeState;
            const treeApi = activeTreeApi;
            if (!state || !treeApi) {
                return;
            }
            const previewPath = rowPathFromEvent(event, ".tree-preview-btn");
            if (previewPath !== null) {
                event.stopPropagation();
                if (state.onPreviewFile) {
                    state.onPreviewFile(previewPath);
                }
                return;
            }
            const togglePath = rowPathFromEvent(event, ".tree-toggle");
            if (togglePath === null) {
                return;
            }
            const node = nodeIndex.get(togglePath);
            if (!node || node.type !== "directory"
                || !(node.children && node.children.length)) {
                return;
            }
            if (state.expandedPaths.has(togglePath)) {
                state.expandedPaths.delete(togglePath);
            } else {
                state.expandedPaths.add(togglePath);
            }
            renderTree(state, treeApi);
        });

        container.addEventListener("change", (event) => {
            const state = activeState;
            const treeApi = activeTreeApi;
            if (!state || !treeApi) {
                return;
            }
            const target = event.target;
            if (!target || !target.classList
                || !target.classList.contains("tree-checkbox")) {
                return;
            }
            const path = rowPathFromEvent(event, ".tree-checkbox");
            if (path === null) {
                return;
            }
            applySelectionChange(path, Boolean(target.checked), state, treeApi);
        });
    }

    function scheduleFrame(callback) {
        if (typeof window !== "undefined" && window.requestAnimationFrame) {
            window.requestAnimationFrame(callback);
        } else {
            setTimeout(callback, 0);
        }
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
            batchSize: RENDER_BATCH_SIZE,
            scheduleFrame,
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
        activeState = state;
        activeTreeApi = treeApi;
        nodeIndex = new Map();
        checkboxIndex = new Map();
        ensureDelegatedHandlers(els.fileTree);
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

        // 一次后序遍历算好每个节点的文件数/已选数：原实现是每个节点各递归一次，
        // 整棵树渲染的代价是 O(节点数 × 深度)。
        // activeCounts 是共享的：分批渲染期间用户改勾选时，applySelectionChange
        // 会把它刷新，尚未渲染的批次读到的就是最新值。
        activeCounts = treeApi.computeSelectionCounts(state.tree, state.selectedPaths);
        const flat = flattenVisibleNodes(state.tree, state);
        for (const item of flat) {
            nodeIndex.set(item.node.path, item.node);
        }

        // 分批渲染：先出首批，其余按帧补齐，避免一次性同步建 DOM 卡住主线程。
        treeApi.renderBatches(flat, {
            batchSize: RENDER_BATCH_SIZE,
            scheduleFrame,
            isCurrent() {
                return renderId === state.searchRenderId;
            },
            renderBatch(items) {
                const fragment = document.createDocumentFragment();
                for (const item of items) {
                    appendTreeNode(
                        fragment,
                        item.node,
                        item.depth,
                        state,
                        treeApi,
                        activeCounts,
                    );
                }
                els.fileTree.append(fragment);
            },
        });
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
