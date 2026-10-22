(function (root) {
    "use strict";

    const STORAGE_KEY = "chzip.theme";

    function getStoredTheme() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch {
            return null;
        }
    }

    function storeTheme(theme) {
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch {
            // Ignore storage errors
        }
    }

    function getSystemTheme() {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
            return "dark";
        }
        return "light";
    }

    function applyTheme(theme) {
        const root = document.documentElement;
        if (theme === "dark" || theme === "light") {
            root.setAttribute("data-theme", theme);
        } else {
            root.removeAttribute("data-theme");
        }
        syncThemeToggleA11y(theme);
    }

    // 让屏幕阅读器知道当前主题：aria-pressed=true 表示当前是深色。
    // CSS 侧的图标/文案切换已由 data-theme 驱动，这里只补 a11y 语义。
    function syncThemeToggleA11y(theme) {
        const btn = typeof document !== "undefined"
            ? document.getElementById("themeToggle")
            : null;
        if (!btn) {
            return;
        }
        const isDark = theme === "dark";
        btn.setAttribute("aria-pressed", String(isDark));
        btn.setAttribute(
            "aria-label",
            isDark ? "切换主题（当前为深色）" : "切换主题（当前为浅色）",
        );
    }

    function getCurrentTheme() {
        const stored = getStoredTheme();
        if (stored === "dark" || stored === "light") {
            return stored;
        }
        return getSystemTheme();
    }

    function toggleTheme() {
        const current = getCurrentTheme();
        const next = current === "dark" ? "light" : "dark";
        storeTheme(next);
        applyTheme(next);
        return next;
    }

    function initTheme() {
        const theme = getCurrentTheme();
        applyTheme(theme);
        return theme;
    }

    root.CHzipTheme = {
        applyTheme,
        getCurrentTheme,
        initTheme,
        toggleTheme,
    };
}(typeof window !== "undefined" ? window : globalThis));
