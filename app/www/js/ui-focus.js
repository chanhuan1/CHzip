// 通用焦点管理：为所有模态弹窗提供
//   1) 打开时记录原焦点，关闭时还原
//   2) Tab / Shift+Tab 在当前最上层弹窗内循环
// 实现上监听全局 keydown + 维护一个简单栈，不需要侵入每个 open/close 函数。
(function (root) {
    "use strict";

    // 与 index.html 中所有 .dialog-backdrop / .preview-backdrop 对应。
    const BACKDROP_SELECTOR = ".dialog-backdrop, .preview-backdrop";
    const FOCUSABLE_SELECTOR = [
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "a[href]",
        "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const stack = []; // [{ backdrop, previousFocus }]

    function topVisibleBackdrop() {
        const all = document.querySelectorAll(BACKDROP_SELECTOR);
        // 取 z-index 最高的可见者。由于 z-index 是 CSS 写死的，简单起见
        // 按 DOM 顺序倒序找第一个 hidden=false。
        for (let i = all.length - 1; i >= 0; i -= 1) {
            if (!all[i].hidden) {
                return all[i];
            }
        }
        return null;
    }

    function onBackdropShown(backdrop) {
        if (!backdrop || stack.some((entry) => entry.backdrop === backdrop)) {
            return;
        }
        stack.push({ backdrop, previousFocus: document.activeElement });
    }

    function onBackdropHidden(backdrop) {
        const idx = stack.findIndex((entry) => entry.backdrop === backdrop);
        if (idx < 0) {
            return;
        }
        const [entry] = stack.splice(idx, 1);
        const prev = entry.previousFocus;
        if (prev && typeof prev.focus === "function" && document.contains(prev)) {
            // 延迟一帧，等关闭动画/兄弟弹窗接管焦点
            requestAnimationFrame(() => {
                try { prev.focus(); } catch { /* 元素可能已被禁用 */ }
            });
        }
    }

    // 用 MutationObserver 监听 hidden 属性变化，统一接管所有 dialog 的开关。
    function observeBackdrops() {
        const all = document.querySelectorAll(BACKDROP_SELECTOR);
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type !== "attributes" || m.attributeName !== "hidden") {
                    continue;
                }
                const el = m.target;
                if (el.hidden) {
                    onBackdropHidden(el);
                } else {
                    onBackdropShown(el);
                }
            }
        });
        all.forEach((el) => {
            observer.observe(el, { attributes: true, attributeFilter: ["hidden"] });
        });
    }

    function trapTab(event) {
        if (event.key !== "Tab") {
            return;
        }
        const backdrop = topVisibleBackdrop();
        if (!backdrop) {
            return;
        }
        const focusables = Array.from(backdrop.querySelectorAll(FOCUSABLE_SELECTOR))
            .filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!focusables.length) {
            return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey) {
            // Shift+Tab：在第一个上再退就循环到最后一个
            if (active === first || !backdrop.contains(active)) {
                event.preventDefault();
                last.focus();
            }
        } else if (active === last || !backdrop.contains(active)) {
            // Tab：在最后一个上再进就循环到第一个；焦点在弹窗外也拉回
            event.preventDefault();
            first.focus();
        }
    }

    function initFocusManagement() {
        if (typeof document === "undefined") {
            return;
        }
        observeBackdrops();
        document.addEventListener("keydown", trapTab, true);
    }

    root.CHzipFocus = { initFocusManagement };
}(typeof window !== "undefined" ? window : globalThis));
