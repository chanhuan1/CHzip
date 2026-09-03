(function (root) {
    "use strict";

    const PREVIEW_MAX_SIZE = 10 * 1024 * 1024;
    const TEXT_EXTENSIONS = new Set([
        ".txt", ".md", ".markdown", ".log", ".ini", ".cfg", ".conf",
        ".json", ".xml", ".yaml", ".yml", ".toml",
        ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
        ".py", ".rb", ".pl", ".php", ".java", ".kt", ".scala",
        ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
        ".cs", ".go", ".rs", ".swift",
        ".css", ".scss", ".sass", ".less",
        ".html", ".htm", ".svg",
        ".sh", ".bash", ".zsh", ".fish", ".ps1",
        ".bat", ".cmd",
        ".sql", ".csv", ".tsv",
        ".env", ".gitignore", ".gitattributes",
        ".dockerfile", ".makefile", ".cmake",
        ".lua", ".vim", ".el", ".clj",
        ".erl", ".ex", ".exs",
        ".hs", ".ml", ".fs",
        ".r", ".R", ".m", ".mat",
        ".tex", ".bib", ".rst", ".adoc",
    ]);

    const IMAGE_EXTENSIONS = new Set([
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
    ]);

    const CODE_KEYWORDS = new Set([
        "function", "const", "let", "var", "if", "else", "for", "while", "do",
        "switch", "case", "default", "break", "continue", "return", "try",
        "catch", "finally", "throw", "new", "delete", "typeof", "instanceof",
        "class", "extends", "super", "this", "static", "import", "export",
        "from", "as", "async", "await", "yield", "true", "false", "null",
        "undefined", "void", "in", "of", "is", "not", "and", "or",
        "def", "lambda", "pass", "with", "raise", "except", "print",
        "module", "require", "include", "use", "fn", "struct", "impl",
        "enum", "trait", "type", "pub", "mut", "ref", "move",
    ]);

    function getFileExtension(filename) {
        const lastDot = filename.lastIndexOf(".");
        if (lastDot < 0) {
            return "";
        }
        return filename.slice(lastDot).toLowerCase();
    }

    function isTextFile(filename) {
        return TEXT_EXTENSIONS.has(getFileExtension(filename));
    }

    function isImageFile(filename) {
        return IMAGE_EXTENSIONS.has(getFileExtension(filename));
    }

    function isPreviewable(filename, size) {
        if (size > PREVIEW_MAX_SIZE) {
            return false;
        }
        return isTextFile(filename) || isImageFile(filename);
    }

    function getFileType(filename) {
        if (isTextFile(filename)) {
            return "text";
        }
        if (isImageFile(filename)) {
            return "image";
        }
        return "unknown";
    }

    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    function highlightSyntax(line) {
        let result = escapeHtml(line);
        result = result.replace(
            /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,
            '<span class="syntax-string">$1</span>',
        );
        result = result.replace(
            /\b(\d+(?:\.\d+)?)\b/g,
            '<span class="syntax-number">$1</span>',
        );
        result = result.replace(
            /\b([a-zA-Z_]\w*)\s*(?=\()/g,
            '<span class="syntax-function">$1</span>',
        );
        const words = result.split(/(\s+)/);
        return words.map((word) => {
            if (CODE_KEYWORDS.has(word.toLowerCase())) {
                return `<span class="syntax-keyword">${word}</span>`;
            }
            return word;
        }).join("");
    }

    function formatTextPreview(content) {
        const lines = content.split(/\r?\n/);
        return lines.map((line, index) => {
            const lineNumber = `<span class="line-number">${String(index + 1).padStart(4, " ")}</span>`;
            const highlighted = highlightSyntax(line);
            return `${lineNumber}${highlighted}`;
        }).join("\n");
    }

    function formatImagePreview(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const img = document.createElement("img");
        img.className = "preview-image";
        img.src = url;
        img.alt = fileName;
        img.dataset.blobUrl = url;
        return img;
    }

    function revokeBlobUrl(element) {
        const img = element.querySelector(".preview-image");
        if (img && img.dataset.blobUrl) {
            URL.revokeObjectURL(img.dataset.blobUrl);
        }
    }

    function formatSize(bytes) {
        if (!Number.isFinite(Number(bytes))) {
            return "-";
        }
        const units = ["B", "KB", "MB", "GB"];
        let value = Number(bytes);
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        const digits = value >= 10 || unit === 0 ? 0 : 1;
        return `${value.toFixed(digits)} ${units[unit]}`;
    }

    root.CHzipPreview = {
        PREVIEW_MAX_SIZE,
        escapeHtml,
        formatSize,
        formatTextPreview,
        formatImagePreview,
        getFileExtension,
        getFileType,
        isImageFile,
        isPreviewable,
        isTextFile,
        revokeBlobUrl,
    };
}(typeof window !== "undefined" ? window : globalThis));
