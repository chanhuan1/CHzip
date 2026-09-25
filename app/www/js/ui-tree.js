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
    // 多类型文件图标体系：根据扩展名语义化分类（代码、图片、音频、视频、压缩包、文档、表格、安装包等），
    // 并支持展开文件夹 (folderOpen) 状态反馈。
    const TREE_ICONS = {
        folder: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<path class="tree-icon-tab" d="M2.5 6V2.42A1.2 1.2 0 0 1 3.7 1.22'
            + 'H7.3A1.2 1.2 0 0 1 8.5 2.42V6Z"/>'
            + '<path class="tree-icon-folder-body" d="M2.6 4.6H13.4A1.6 1.6 0 0 1 15 6.2'
            + 'V13.18A1.6 1.6 0 0 1 13.4 14.78H2.6A1.6 1.6 0 0 1 1 13.18'
            + 'V6.2A1.6 1.6 0 0 1 2.6 4.6Z"/>'
            + "</svg>",
        folderOpen: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<path class="tree-icon-tab" d="M2.5 6V2.42A1.2 1.2 0 0 1 3.7 1.22'
            + 'H6.8A1.2 1.2 0 0 1 7.9 2.42V4.8Z"/>'
            + '<path class="tree-icon-folder-body" opacity="0.6" d="M2 5h12v7H2z"/>'
            + '<path class="tree-icon-folder-body" d="M1.2 14.4l2-8.2c.2-.7.8-1.2 1.5-1.2h10.4c.8 0 1.3.8 1.1 1.5l-2 8.2c-.2.7-.8 1.2-1.5 1.2H2.7c-.8 0-1.4-.7-1.1-1.5z"/>'
            + "</svg>",
        file: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<path class="tree-icon-file-body" d="M3.9 1.25H9.5L13.5 5.25V13.35'
            + 'A1.4 1.4 0 0 1 12.1 14.75H3.9A1.4 1.4 0 0 1 2.5 13.35'
            + 'V2.65A1.4 1.4 0 0 1 3.9 1.25Z"/>'
            + '<path class="tree-icon-fold" d="M9.5 1.25L13.5 5.25H10.7'
            + 'A1.2 1.2 0 0 1 9.5 4.05Z"/>'
            + "</svg>",
        code: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<rect class="icon-shape-code" x="2" y="2" width="12" height="12" rx="2.5"/>'
            + '<path d="M6 5.5L3.5 8 6 10.5M10 5.5l2.5 2.5-2.5 2.5M8.8 4.5l-1.6 7" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
            + "</svg>",
        image: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<rect class="icon-shape-image" x="2" y="2" width="12" height="12" rx="2.5"/>'
            + '<circle cx="5.5" cy="5.5" r="1.2" fill="#fff"/>'
            + '<path d="M3 12.2l3.2-3.8a1 1 0 0 1 1.5 0l1.1 1.3 1.8-2.2a1 1 0 0 1 1.5 0L13.5 9v3.2a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1z" fill="#fff" opacity="0.9"/>'
            + "</svg>",
        video: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<rect class="icon-shape-video" x="2" y="2" width="12" height="12" rx="2.5"/>'
            + '<path d="M6.5 5.5v5l4-2.5-4-2.5z" fill="#fff"/>'
            + "</svg>",
        audio: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<rect class="icon-shape-audio" x="2" y="2" width="12" height="12" rx="2.5"/>'
            + '<path d="M10 4.5v5a1.8 1.8 0 1 1-1.2-1.7V5.8L6.5 6.4v4.3A1.8 1.8 0 1 1 5.3 9V5.2a.8.8 0 0 1 .6-.8l3.5-.8a.8.8 0 0 1 .6.9z" fill="#fff"/>'
            + "</svg>",
        archive: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<rect class="icon-shape-archive" x="2" y="2" width="12" height="12" rx="2.5"/>'
            + '<path d="M7 4h2v1H7V4zm0 2h2v1H7V6zm0 2h2v1H7V8zm-1 3.5a1.5 1.5 0 0 1 3 0v1a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-1z" fill="#fff"/>'
            + "</svg>",
        doc: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<path class="icon-shape-doc" d="M3.5 1.5h6l3.5 3.5v9.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z"/>'
            + '<path d="M9.5 1.5v3.5h3.5" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.8"/>'
            + '<path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" stroke="#fff" stroke-width="1.3" stroke-linecap="round" fill="none"/>'
            + "</svg>",
        pdf: '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
            + '<rect class="icon-shape-pdf" x="2" y="2" width="12" height="12" rx="2.5"/>'
            + '<path d="M4.5 9.5V6.8h1.8c.8 0 1.2.4 1.2 1.1s-.4 1.1-1.2 1.1H5.4v1.5H4.5zm.9-2.1v1.1h.8c.4 0 .6-.2.6-.55s-.2-.55-.6-.55h-.8zM8.2 9.5V6.8h1.5c1.2 0 1.8.8 1.8 1.8s-.6 1.9-1.8 1.9H8.2zm.9-2.1v1.8h.6c.7 0 1-.4 1-1s-.3-.8-1-.8h-.6z" fill="#fff"/>'
            + "</svg>",
    };

    function getFileCategory(filename) {
        const lastDot = String(filename || "").lastIndexOf(".");
        if (lastDot < 0) {
            return "file";
        }
        const ext = filename.slice(lastDot).toLowerCase();
        if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".html", ".htm", ".css", ".scss", ".less",
            ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".go", ".rs", ".php", ".rb", ".sh",
            ".bash", ".zsh", ".sql", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".lua", ".vim",
            ".dockerfile", ".makefile", ".cmake"].includes(ext)) {
            return "code";
        }
        if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".tif"].includes(ext)) {
            return "image";
        }
        if ([".mp4", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".webm", ".m4v", ".rmvb"].includes(ext)) {
            return "video";
        }
        if ([".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".ape"].includes(ext)) {
            return "audio";
        }
        if ([".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".zst", ".cab", ".iso", ".dmg", ".wim", ".001", ".z01", ".r00"].includes(ext)) {
            return "archive";
        }
        if (ext === ".pdf") {
            return "pdf";
        }
        if ([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".markdown", ".rtf", ".csv", ".tsv"].includes(ext)) {
            return "doc";
        }
        return "file";
    }

    // 预览按钮的“眼睛”图标：不用 emoji（各平台字形/配色不一致，Linux 上
    // 还可能落到替代字体），改为矢量图标，与树图标同一套 currentColor 方案。
    const PREVIEW_EYE_ICON = '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
        + '<path class="tree-preview-eye" d="M1.6 8C3.1 5.3 5.4 3.6 8 3.6'
        + 'C10.6 3.6 12.9 5.3 14.4 8C12.9 10.7 10.6 12.4 8 12.4'
        + 'C5.4 12.4 3.1 10.7 1.6 8Z"/>'
        + '<circle class="tree-preview-pupil" cx="8" cy="8" r="2.1"/>'
        + "</svg>";

    // 加密文件的锁标：与 TREE_ICONS / PREVIEW_EYE_ICON 同一套 currentColor 方案，
    // 不用 emoji（跨平台字形不一致）。填充/描边颜色由 .tree-lock-body / .tree-lock-shackle
    // CSS 规则驱动，便于主题切换。
    // 注意：这是模块内部常量，不要挂到 CHzipUiTree 导出对象上 ——
    // tests/ui-dialogs.test.js 的 assertExportedCallsResolve 只扫 app.js 里的
    // uiXxx.Y( 调用，新增内部常量若误导出会破坏「导出最小面」的约定。
    const LOCK_ICON = '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'
        + '<path class="tree-lock-shackle" d="M5 7V5a3 3 0 0 1 6 0v2"'
        + ' fill="none" stroke-width="1.6" stroke-linecap="round"/>'
        + '<rect class="tree-lock-body" x="3.5" y="7" width="9" height="7" rx="1.4"/>'
        + "</svg>";

    // 压缩率展示：返回 "-62%" 这种短串；没有可展示的收益
    // （size<=0、packedSize 缺失/非法、或压完反而更大）返回空串，
    // 调用方据此把 .tree-ratio 留空。
    // 内部辅助函数，不导出（理由同 LOCK_ICON）。
    function formatRatio(packedSize, size) {
        const original = Number(size);
        const packed = Number(packedSize);
        if (!Number.isFinite(original) || original <= 0) {
            return "";
        }
        // packedSize===0 而 size>0 视为"无压缩数据"（buildTree 对缺失的 packedSize
        // 默认 0，不是真的压成 0 字节 —— 原文件非空的话压到 0 不可能）。
        if (!Number.isFinite(packed) || packed <= 0) {
            return "";
        }
        const savings = 1 - packed / original;
        if (savings <= 0) {
            return "";
        }
        return `-${Math.round(savings * 100)}%`;
    }

    // 文件行的多行 tooltip：完整路径 + 修改时间（若有）+ 原始/压缩后大小。
    // entry 可以是 buildTree 的叶子节点，也可以是 searchFiles 返回的原始 entry —
    // 两个路径上的字段名一致（size/packedSize/modified/encrypted），统一在这里拼。
    function buildFileTooltip(path, entry) {
        const lines = [String(path || "")];
        if (entry && entry.modified) {
            lines.push(`修改时间: ${entry.modified}`);
        }
        if (entry && Number.isFinite(Number(entry.size)) && Number(entry.size) > 0) {
            lines.push(`原始: ${formatSize(entry.size)} / 压缩后: ${formatSize(entry.packedSize)}`);
        }
        return lines.join("\n");
    }

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

    function createTreeIcon(isDirectory, filename = "", isOpen = false) {
        const icon = document.createElement("span");
        if (isDirectory) {
            icon.className = "tree-icon folder";
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = isOpen ? TREE_ICONS.folderOpen : TREE_ICONS.folder;
            return icon;
        }
        const category = getFileCategory(filename);
        icon.className = `tree-icon file file-${category}`;
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = TREE_ICONS[category] || TREE_ICONS.file;
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
        row.title = buildFileTooltip(entry.path, entry);

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

        const icon = createTreeIcon(false, entry.path);

        // 加密锁标：始终占位（非加密留空），保证 grid 列对齐；
        // 空元素通过 CSS .tree-lock:empty { display:none } 折叠，
        // 没加密文件时该列不占宽度。
        const lock = document.createElement("span");
        lock.className = "tree-lock";
        lock.setAttribute("aria-hidden", "true");
        if (entry.encrypted) {
            lock.innerHTML = LOCK_ICON;
            lock.title = "已加密";
        }

        const label = document.createElement("span");
        label.className = "tree-label";
        const normalizedPath = String(entry.path || "").replace(/\\/g, "/");
        label.textContent = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);

        const ratio = document.createElement("span");
        ratio.className = "tree-ratio";
        ratio.textContent = formatRatio(entry.packedSize, entry.size);

        const size = document.createElement("span");
        size.className = "tree-size";
        size.textContent = formatSize(entry.size);

        row.append(toggle, checkbox, icon, lock, label, ratio, size);
        container.append(row);
    }

    function appendTreeNode(container, node, depth, state, treeApi, counts) {
        const row = registerRow(document.createElement("div"), node.path);
        row.className = "tree-row";
        row.style.setProperty("--tree-depth", String(depth));
        row.title = node.type === "file" ? buildFileTooltip(node.path, node) : node.path;

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

        const isDir = node.type === "directory";
        const isExpanded = isDir && state.expandedPaths.has(node.path);
        const icon = createTreeIcon(isDir, node.name, isExpanded);

        // 加密锁标：仅文件可能加密；目录行也占位（空），保证 grid 列对齐。
        const lock = document.createElement("span");
        lock.className = "tree-lock";
        lock.setAttribute("aria-hidden", "true");
        if (node.type === "file" && node.encrypted) {
            lock.innerHTML = LOCK_ICON;
            lock.title = "已加密";
        }

        const label = document.createElement("span");
        label.className = "tree-label";
        label.textContent = node.name;

        // 压缩率列：仅文件节点显示；目录行留空占位。
        const ratio = document.createElement("span");
        ratio.className = "tree-ratio";
        ratio.textContent = node.type === "file"
            ? formatRatio(node.packedSize, node.size)
            : "";

        const size = document.createElement("span");
        size.className = "tree-size";
        size.textContent = node.type === "file" ? formatSize(node.size) : "";

        row.append(toggle, checkbox, icon, lock, label, ratio, size);

        if (node.type === "file" && state.previewableFiles && state.previewableFiles.has(node.path)) {
            const previewBtn = document.createElement("button");
            previewBtn.type = "button";
            previewBtn.className = "tree-preview-btn";
            if (state.previewSolid) {
                previewBtn.classList.add("is-solid");
            }
            previewBtn.innerHTML = PREVIEW_EYE_ICON;
            previewBtn.title = state.previewSolid
                ? "固实压缩包：单文件预览需解压整包，耗时较长（点击查看提示）"
                : "预览文件";
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
            if (togglePath !== null) {
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
                return;
            }

            // 单击行：高亮为当前选定行（.is-active-row）
            const row = event.target?.closest?.(".tree-row");
            if (row && (!event.target.classList || !event.target.classList.contains("tree-checkbox"))) {
                const prev = container.querySelector?.(".tree-row.is-active-row");
                if (prev && prev !== row) {
                    prev.classList?.remove("is-active-row");
                }
                row.classList?.add("is-active-row");
            }
        });

        // 双击目录行：快速展开/收起目录
        container.addEventListener("dblclick", (event) => {
            const state = activeState;
            const treeApi = activeTreeApi;
            if (!state || !treeApi) {
                return;
            }
            if (event.target?.closest?.(".tree-checkbox, .tree-preview-btn, .tree-toggle")) {
                return;
            }
            const path = rowPathFromEvent(event, ".tree-row");
            if (path === null) {
                return;
            }
            const node = nodeIndex.get(path);
            if (!node || node.type !== "directory"
                || !(node.children && node.children.length)) {
                return;
            }
            if (state.expandedPaths.has(path)) {
                state.expandedPaths.delete(path);
            } else {
                state.expandedPaths.add(path);
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

        // 树刚被 replaceChildren 重建、且行还在按帧分批补齐：此时若解压正在
        // 进行，旧高亮已随 DOM 一起消失。在下一帧按记住的当前文件重新补挂——
        // 目标行若尚未渲染出来则跳过，由后续 setJobProgress 的轮询 tick 自然
        // 补上（文件高频切换时每 1s 都有新路径进来，视觉代价可忽略）。
        if (currentExtractingNormalized) {
            scheduleFrame(() => {
                if (activeState === state) {
                    applyHighlight(els, undefined);
                }
            });
        }
    }

    function setPreviewControls(enabled, state) {
        const els = state.elements;
        els.selectAllInput.disabled = !enabled;
        if (els.treeSearchInput) {
            els.treeSearchInput.disabled = !enabled;
        }
        if (els.expandAllBtn) {
            els.expandAllBtn.disabled = !enabled;
        }
        if (els.collapseAllBtn) {
            els.collapseAllBtn.disabled = !enabled;
        }
    }

    function expandAll(state, treeApi) {
        if (!state.previewReady || state.previewLimited || !state.tree) {
            return;
        }
        const queue = [...state.tree];
        while (queue.length) {
            const node = queue.shift();
            if (node.type === "directory" && node.children && node.children.length) {
                state.expandedPaths.add(node.path);
                queue.push(...node.children);
            }
        }
        renderTree(state, treeApi);
    }

    function collapseAll(state, treeApi) {
        if (!state.previewReady || state.previewLimited) {
            return;
        }
        state.expandedPaths.clear();
        renderTree(state, treeApi);
    }

    // 实时高亮正在解压的文件节点（支持递归匹配、折叠目录祖先提示与平滑保持）
    let currentExtractingNormalized = "";

    // 唯一允许写入高亮 class 的出口。负责在写入前校验归一化路径：
    // - null：显式退出运行态，彻底清理并复位；
    // - undefined（或缺省）：按 currentExtractingNormalized 的原值补挂
    //   （renderTree 重建/分批渲染追加后调用，让已亮行在新 DOM 上恢复）；
    // - 字符串：新的当前文件，路径变了才重写。
    //
    // 归一化必须剥掉 7-Zip -bb1 的动作标记：真实进度里的 currentFile 常带
    // "- name"（已存在/跳过）、"+ name"（新增解压）等前缀（见 engine.js 的
    // extractProgressName，该值原样传给前端显示）。文件树的 data-path 是干净
    // 的相对路径，不剥前缀 findMatchingRow 永远匹配不上，高亮就不会亮。
    function normalizeHighlightPath(value) {
        return String(value || "")
            // 先剥掉 7-Zip 原地刷新的控制字符（\b 退格等）：真机进度里的
            // currentFile 可能带 "\b\b\b- name"。后端已剥，这里再拦一道。
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f]+/g, "")
            .replace(/\\/g, "/")
            .trim()
            .replace(/^\.\//, "")
            .replace(/^\/+/, "")
            // 7-Zip -bb1 动作标记（"- "/"+" 等）。剥除控制字符后再 trim，
            // 保证 "\b\b- name" → "name" 而不是 " name"。
            .replace(/^[-+*=]\s+/, "")
            .trim();
    }

    function applyHighlight(els, rawInput) {
        if (rawInput === null) {
            currentExtractingNormalized = "";
            clearAllExtractingHighlights(els.fileTree);
            return;
        }
        if (rawInput !== undefined) {
            const normalized = normalizeHighlightPath(rawInput);
            // 关键点：若当前帧 7-Zip 仅输出了进度百分比（未附带新文件名），
            // 保持现有高亮，避免闪烁清空
            if (!normalized || normalized === currentExtractingNormalized) {
                return;
            }
            currentExtractingNormalized = normalized;
        }
        if (!currentExtractingNormalized) {
            return;
        }
        clearAllExtractingHighlights(els.fileTree);
        const normalized = currentExtractingNormalized;

        // 1. 在当前已渲染的行中匹配目标文件行
        let targetRow = findMatchingRow(els.fileTree, normalized, false);
        let matchedVia = targetRow ? "file" : "";

        // 2. 若目标文件所在目录处于折叠状态（未展开），向上溯源高亮最近的可见父目录
        if (!targetRow) {
            let parent = normalized;
            while (parent.includes("/")) {
                parent = parent.slice(0, parent.lastIndexOf("/"));
                targetRow = findMatchingRow(els.fileTree, parent, true);
                if (targetRow) {
                    targetRow.classList.add("is-extracting-dir");
                    matchedVia = "dir";
                    break;
                }
            }
        } else {
            targetRow.classList.add("is-extracting");
        }

        // 调试：?debugHighlight=1 时打印匹配结果与树上已有的 data-path，
        // 一次就能看出是「路径对不上」还是「行还没渲染出来」。
        if (typeof window !== "undefined"
            && /[?&]debugHighlight=1/.test(window.location?.search || "")) {
            const paths = [];
            const kids = els.fileTree?.children || [];
            for (let i = 0; i < kids.length && i < 30; i += 1) {
                if (kids[i].dataset?.path) {
                    paths.push(kids[i].dataset.path);
                }
            }
            // eslint-disable-next-line no-console
            console.log("[CHzip-HL] match", {
                normalized,
                matched: matchedVia || "NONE",
                rowPath: targetRow?.dataset?.path || "",
                treePaths: paths,
            });
        }
    }

    function highlightExtractingFile(currentFile, state) {
        const els = state?.elements;
        if (!els?.fileTree) {
            return;
        }
        // 显式传 null 清场；undefined 等价于"无新文件名"，保持现状（applyHighlight
        // 内部对空归一化路径同样保持不清除）。
        applyHighlight(els, currentFile === null ? null : currentFile);
    }

    function clearAllExtractingHighlights(container) {
        const activeRows = container.querySelectorAll?.(".is-extracting, .is-extracting-dir");
        if (activeRows && activeRows.length !== undefined) {
            for (let i = 0; i < activeRows.length; i++) {
                activeRows[i].classList.remove("is-extracting", "is-extracting-dir");
            }
        } else if (container.children) {
            for (let i = 0; i < container.children.length; i++) {
                container.children[i].classList?.remove("is-extracting", "is-extracting-dir");
            }
        }
    }

    function findMatchingRow(container, targetPath, directoryOnly = false) {
        const allRows = container.children;
        if (!allRows) return null;
        const norm = targetPath.toLowerCase();

        // 优先精确比对完整相对路径
        for (let i = 0; i < allRows.length; i++) {
            const row = allRows[i];
            const p = row.dataset?.path;
            if (!p) continue;
            const pNorm = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
            if (pNorm === norm) {
                return row;
            }
        }

        // 备选比对：支持尾部相对匹配（应对 7-Zip 前缀差异）
        if (!directoryOnly) {
            for (let i = 0; i < allRows.length; i++) {
                const row = allRows[i];
                const p = row.dataset?.path;
                if (!p) continue;
                const pNorm = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
                if (pNorm.endsWith("/" + norm) || norm.endsWith("/" + pNorm)) {
                    return row;
                }
            }
        }
        return null;
    }

    root.CHzipUiTree = {
        collapseAll,
        expandAll,
        formatSize,
        highlightExtractingFile,
        renderTree,
        setPreviewControls,
        updateSelectionSummary,
    };
}(typeof window !== "undefined" ? window : globalThis));
