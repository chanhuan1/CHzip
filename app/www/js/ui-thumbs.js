(function (root) {
    "use strict";

    // ------------------------------------------------------------------ 常量
    //
    // 缩略图墙是「挑选」场景：每次取图都是一次 CGI + 一次 7z 调用（NAS 上
    // 不免费），所以必须同时上「懒加载 + 并发限流 + LRU 缓存」三道闸，
    // 不能一进缩略图视图就把几百张图全拉一遍。
    const THUMB_CELL_SIZE = 112;         // 单元格边长（CSS 像素）
    const THUMB_LRU_CAPACITY = 60;       // 同时存活的最大 blob URL 数
    const THUMB_FETCH_CONCURRENCY = 2;   // 同时在途的 preview-file 请求数
    // 进入「距离视口还差多少 px 就开始取图」的预取窗口。太小会变成「刚好进
    // 视口才取」，用户能感到加载；太大会让一次快滚拉太多。
    const THUMB_PREFETCH_MARGIN = 240;

    // ------------------------------------------------------------------ LRU 缓存
    //
    // Map 本身保留插入顺序，所以可以用「读时把 key 挪到末尾、写时若超容
    // 删最旧」的方式做 O(1) LRU。value 是 blob URL，被删时必须同步
    // revokeObjectURL —— 否则 URL 永远不会被释放，blob 越积越多。
    function createThumbCache(capacity) {
        const map = new Map();
        return {
            get(path) {
                if (!map.has(path)) {
                    return null;
                }
                const url = map.get(path);
                map.delete(path);
                map.set(path, url);
                return url;
            },
            set(path, url) {
                if (map.has(path)) {
                    URL.revokeObjectURL(map.get(path));
                    map.delete(path);
                }
                map.set(path, url);
                while (map.size > capacity) {
                    const oldest = map.keys().next().value;
                    URL.revokeObjectURL(map.get(oldest));
                    map.delete(oldest);
                }
            },
            clear() {
                for (const url of map.values()) {
                    URL.revokeObjectURL(url);
                }
                map.clear();
            },
            size() {
                return map.size;
            },
        };
    }

    // ------------------------------------------------------------------ 并发限流
    //
    // 任务以「cell 元素」为单位入队，同一时刻最多 concurrency 个在跑。
    // 已经离开视口的 cell 仍会被取消（在 fetch 前检查 dataset.pending）。
    function createThumbQueue(concurrency, runTask) {
        const pending = [];
        let inflight = 0;
        const pump = () => {
            while (inflight < concurrency && pending.length) {
                const task = pending.shift();
                inflight += 1;
                Promise.resolve()
                    .then(() => runTask(task))
                    .catch(() => {
                        // 单个缩略图失败不阻塞队列 —— 该 cell 已经在 runTask
                        // 里标了 is-error，这里只负责把队列继续推下去。
                    })
                    .finally(() => {
                        inflight -= 1;
                        pump();
                    });
            }
        };
        return {
            enqueue(task) {
                pending.push(task);
                pump();
            },
            clear() {
                pending.length = 0;
            },
        };
    }

    // ------------------------------------------------------------------ 单元格
    //
    // 每个 cell 是一个 figure：缩略图 <img> + 底部文件名 label + 右上勾选框。
    // 勾选状态直接读写 state.selectedPaths，与列表视图的复选框语义一致 —
    // 用户在缩略图墙上勾的文件，切回列表视图后仍是勾上的。
    function buildCell(entry, state) {
        const cell = document.createElement("figure");
        cell.className = "thumb-cell";
        cell.dataset.path = entry.path;
        cell.title = entry.path;

        const frame = document.createElement("div");
        frame.className = "thumb-frame";

        const img = document.createElement("img");
        img.className = "thumb-img";
        img.alt = entry.name;
        img.loading = "lazy";
        frame.append(img);

        const name = document.createElement("figcaption");
        name.className = "thumb-name";
        name.textContent = entry.name;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "thumb-checkbox";
        checkbox.checked = state.selectedPaths.has(entry.path);
        checkbox.setAttribute("aria-label", `选择 ${entry.path}`);
        cell.append(checkbox);

        if (entry.encrypted) {
            cell.classList.add("is-encrypted");
            const lock = document.createElement("span");
            lock.className = "thumb-lock";
            lock.title = "已加密";
            lock.setAttribute("aria-hidden", "true");
            lock.innerHTML = '<svg viewBox="0 0 16 16" focusable="false">'
                + '<path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke-width="1.6" stroke-linecap="round"/>'
                + '<rect x="3.5" y="7" width="9" height="7" rx="1.4"/>'
                + "</svg>";
            frame.append(lock);
        }

        cell.append(frame, name);
        return { cell, img, checkbox };
    }

    // ------------------------------------------------------------------ 主入口
    //
    // renderThumbWall(state, options)：
    //   - state.elements.thumbWall       缩略图容器（index.html 加）
    //   - state.elements.thumbWallEmpty  固实/无图时的提示条
    //   - state.entries                  buildTree 的扁平 entries（含 size/encrypted）
    //   - state.selectedPaths            与列表视图共享
    //   - state.previewSolid             固实包禁用缩略图墙
    //   - state.onPreviewFile            点击 cell 进入 previewFile 大图弹窗
    //   - state.onThumbSelect            勾选变化后通知外层刷新 selectionSummary
    //
    // options.api              CHzipApiClient 实例（用来 postApi("preview-file")）
    // options.uiPreview        CHzipPreview（isImageFile / formatSize 等）
    // options.getPassword      () => 当前密码（取自 els.passwordInput.value）
    // options.getCodePage      () => 当前代码页
    // options.archivePath      当前压缩包路径（state.filePath）
    function renderThumbWall(state, options) {
        const els = state.elements;
        const container = els.thumbWall;
        const emptyBox = els.thumbWallEmpty;
        const uiPreview = options.uiPreview;
        const api = options.api;

        container.replaceChildren();
        emptyBox.hidden = true;
        emptyBox.textContent = "";

        // 固实包：每个缩略图都要解整包，彻底禁用，只给文字提示。
        if (state.previewSolid) {
            emptyBox.hidden = false;
            emptyBox.textContent = "固实（solid）压缩包不支持缩略图墙：取出任一图片都要先解压整包，请切回列表视图。";
            return { dispose() {} };
        }

        const imageEntries = (state.entries || []).filter((entry) => (
            entry.type === "file"
            && uiPreview.isImageFile(entry.name)
            && entry.size > 0
            && entry.size <= uiPreview.PREVIEW_MAX_SIZE
        ));

        if (!imageEntries.length) {
            emptyBox.hidden = false;
            emptyBox.textContent = "此压缩包内没有可预览的图片。";
            return { dispose() {} };
        }

        const cache = createThumbCache(THUMB_LRU_CAPACITY);
        const queue = createThumbQueue(THUMB_FETCH_CONCURRENCY, async (task) => {
            const { entry, cell, img } = task;
            // 渲染期间用户切回列表 / 切走压缩包：cell 已不在 document 里，
            // 也没标 pending，直接放弃。
            if (!cell.isConnected || cell.dataset.pending !== "1") {
                return;
            }
            cell.dataset.pending = "0";
            try {
                const result = await api.postApi("preview-file", {
                    path: options.archivePath,
                    targetPath: entry.path,
                    password: options.getPassword(),
                    codePage: options.getCodePage(),
                }, { timeoutMs: 60 * 1000 });
                if (!cell.isConnected) {
                    return;
                }
                const binaryString = atob(result.content);
                const bytes = Uint8Array.from(binaryString, (ch) => ch.charCodeAt(0));
                const blob = new Blob([bytes], { type: getMimeType(entry.name, uiPreview) });
                const url = URL.createObjectURL(blob);
                cache.set(entry.path, url);
                img.src = url;
                cell.classList.add("is-loaded");
            } catch (error) {
                if (!cell.isConnected) {
                    return;
                }
                cell.classList.add("is-error");
                cell.title = `${entry.path}\n缩略图加载失败：${error.message || "未知错误"}`;
            }
        });

        const observer = typeof IntersectionObserver === "function"
            ? new IntersectionObserver((entriesList) => {
                for (const hit of entriesList) {
                    if (!hit.isIntersecting) {
                        continue;
                    }
                    const cell = hit.target;
                    observer.unobserve(cell);
                    if (cell.dataset.cached === "1") {
                        continue;
                    }
                    cell.dataset.pending = "1";
                    queue.enqueue(cell.__thumbTask);
                }
            }, {
                root: container,
                rootMargin: `${THUMB_PREFETCH_MARGIN}px`,
            })
            : null;

        const fragment = document.createDocumentFragment();
        for (const entry of imageEntries) {
            const { cell, img, checkbox } = buildCell(entry, state);

            // 命中缓存：直接显示，不进观察器。
            const cachedUrl = cache.get(entry.path);
            if (cachedUrl) {
                cell.dataset.cached = "1";
                img.src = cachedUrl;
                cell.classList.add("is-loaded");
            }

            cell.__thumbTask = { entry, cell, img };
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) {
                    state.selectedPaths.add(entry.path);
                } else {
                    state.selectedPaths.delete(entry.path);
                }
                state.onThumbSelect?.();
            });
            cell.addEventListener("click", (event) => {
                if (event.target === checkbox) {
                    return;
                }
                state.onPreviewFile?.(entry.path);
            });

            if (observer && !cachedUrl) {
                observer.observe(cell);
            } else if (!cachedUrl) {
                // 浏览器没 IntersectionObserver：退化为立刻入队（仍受并发限流）。
                cell.dataset.pending = "1";
                queue.enqueue(cell.__thumbTask);
            }

            fragment.append(cell);
        }
        container.append(fragment);

        return {
            dispose() {
                if (observer) {
                    observer.disconnect();
                }
                queue.clear();
                // cache 不在这里 clear —— 切回列表再切回来时仍想命中缓存。
            },
            cacheSize() {
                return cache.size();
            },
        };
    }

    function getMimeType(fileName, uiPreview) {
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

    root.CHzipUiThumbs = {
        THUMB_CELL_SIZE,
        THUMB_FETCH_CONCURRENCY,
        THUMB_LRU_CAPACITY,
        createThumbCache,
        createThumbQueue,
        renderThumbWall,
    };
}(typeof window !== "undefined" ? window : globalThis));
