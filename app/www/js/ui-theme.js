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

    function updateThemeUI(theme, elements) {
        if (!elements) {
            return;
        }
        const icon = document.getElementById("themeIcon");
        const text = document.getElementById("themeText");
        if (icon) {
            icon.textContent = theme === "dark" ? "☀️" : "🌙";
        }
        if (text) {
            text.textContent = theme === "dark" ? "浅色" : "深色";
        }
    }

    root.CHzipTheme = {
        applyTheme,
        getCurrentTheme,
        initTheme,
        toggleTheme,
        updateThemeUI,
    };
}(typeof window !== "undefined" ? window : globalThis));
