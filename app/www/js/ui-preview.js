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

    // F11：PDF 走浏览器内置查看器（iframe src=blob:...），与图片一样按
    // base64 取回。仍受 PREVIEW_MAX_SIZE 限制 —— 后端 preview-file 的 12 MiB
    // 上限没放宽，前端跟着不放宽；更大的 PDF 在 previewFile 弹窗里走
    // PREVIEW_TOO_LARGE 的明确提示，不在此静默放行。
    const PDF_EXTENSIONS = new Set([".pdf"]);

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

    function isPdfFile(filename) {
        return PDF_EXTENSIONS.has(getFileExtension(filename));
    }

    function isPreviewable(filename, size) {
        if (size > PREVIEW_MAX_SIZE) {
            return false;
        }
        return isTextFile(filename) || isImageFile(filename) || isPdfFile(filename);
    }

    function getFileType(filename) {
        if (isTextFile(filename)) {
            return "text";
        }
        if (isImageFile(filename)) {
            return "image";
        }
        if (isPdfFile(filename)) {
            return "pdf";
        }
        return "unknown";
    }

    // 渲染行数上限 / 高亮行数上限。
    //
    // 预览内容上限是 10 MiB，按行算可能有几十万行。原实现会为每一行都
    // 生成行号 <span> 并逐行做正则高亮，几十万行 = 几十万个 DOM 节点，
    // 主线程直接假死。这里给渲染设一个上限：超出部分不渲染并明确提示；
    // 高亮只对前若干行做（高亮是最贵的部分）。
    // 注意：只影响"显示"，复制按钮仍然复制完整内容（previewContent 未截断）。
    const MAX_PREVIEW_LINES = 20000;
    const MAX_HIGHLIGHT_LINES = 3000;

    const HTML_ESCAPES = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\u00A0": "&nbsp;",
    };

    // 纯字符串转义。
    //
    // 原实现每次都 new 一个 <div>，把内容塞进 textContent 再读 innerHTML 取转义
    // 结果 —— 按行高亮时就是"每一行创建一个 DOM 元素"，大文件下代价极高。
    // 这里刻意只转义 & < > 与不换行空格（与原实现输出一致，包含 U+00A0 的处理）：
    // 引号不需要转义（内容只作为文本插入，不进属性），而且一旦把引号变成实体，
    // 下面针对字符串字面量的正则就再也匹配不到了。
    function escapeHtml(text) {
        return String(text).replace(/[&<>\u00A0]/g, (ch) => HTML_ESCAPES[ch]);
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

    function formatTextPreview(content, options) {
        const settings = options || {};
        const maxLines = settings.maxLines == null
            ? MAX_PREVIEW_LINES
            : settings.maxLines;
        const maxHighlightLines = settings.maxHighlightLines == null
            ? MAX_HIGHLIGHT_LINES
            : settings.maxHighlightLines;

        const text = String(content == null ? "" : content);
        if (!text) {
            return "";
        }
        const lines = text.split(/\r?\n/);
        const visible = maxLines > 0 ? lines.slice(0, maxLines) : lines;
        const rendered = visible.map((line, index) => {
            const lineNumber = `<span class="line-number">${String(index + 1).padStart(4, " ")}</span>`;
            const body = index < maxHighlightLines
                ? highlightSyntax(line)
                : escapeHtml(line);
            return `${lineNumber}${body}`;
        });
        if (visible.length < lines.length) {
            rendered.push(
                `<span class="line-number">    </span>`
                + `<em>（内容过长，仅显示前 ${visible.length} 行，`
                + `共 ${lines.length} 行；复制按钮仍可复制全文）</em>`,
            );
        }
        return rendered.join("\n");
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

    // F11：把 base64 PDF 字节包成 <iframe> 交给浏览器内置 PDF 查看器。
    // 与 formatImagePreview 一样返回已挂好 blob URL 的元素，URL 记在
    // dataset.blobUrl 上，沿用 revokeBlobUrl 的回收路径（上面已加查 .preview-pdf）。
    function formatPdfPreview(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const frame = document.createElement("iframe");
        frame.className = "preview-pdf";
        frame.src = url;
        frame.title = fileName;
        frame.dataset.blobUrl = url;
        return frame;
    }

    function revokeBlobUrl(element) {
        // 同时查 .preview-image 与 F11 的 .preview-pdf（iframe）——
        // 两者都把 blob URL 记在 dataset.blobUrl 上。
        const media = element.querySelector(".preview-image, .preview-pdf");
        if (media && media.dataset.blobUrl) {
            URL.revokeObjectURL(media.dataset.blobUrl);
        }
    }

    // ------------------------------------------------------------
    // F12 乱码检测（纯函数，无 DOM 依赖，Node 测试直接消费）。
    //
    // 误报红线（比漏报更糟）：
    //   1. 纯 ASCII 名永不命中。
    //   2. 已正确解码的 CJK（U+4E00-U+9FFF）、平/片假名、韩文音节、
    //      希腊/西里尔、越南文 Latin Extended Additional 都不算乱码。
    //   3. 欧洲语言文件名（Café / naïve / Łódź）只含零星高字节字符，
    //      要求「连续堆叠 >= 3」才命中，单字符不算。
    //   4. C1 控制符（U+0080-U+009F）在合法 UTF-8 解码结果里不可能出现，
    //      出现即说明字节流被 Latin-1/CP1252 误读，直接命中。
    //   5. U+FFFD 替换字符同理：合法文件名不会含它。
    //
    // UTF-8 被 Latin-1/CP1252 误读时的典型残留：原 UTF-8 lead byte
    //（0xC0-0xFF）落成 Latin-1 Supplement 字母（À-ÿ），continuation byte
    //（0x80-0xBF）落成 C1 或 ¡-¿；过 CP1252 还会把 0x80-0x9F 映射到
    // General Punctuation（‹ › • † ‡ … ‰ € 等）。Big5 / Shift-JIS
    // 被误读时落在同一批区间，只是分布不同。
    const MOJIBAKE_MAX_SCAN = 200;
    const MOJIBAKE_LATIN1 = "\u00c0-\u00ff";
    const MOJIBAKE_C1_PUNCT = "\u0080-\u00bf";
    const MOJIBAKE_CP1252 = "\u2013-\u203a\u20ac";
    const MOJIBAKE_STACK = new RegExp(
        `[${MOJIBAKE_LATIN1}${MOJIBAKE_C1_PUNCT}${MOJIBAKE_CP1252}]{3,}`,
        "u",
    );
    const MOJIBAKE_C1 = /[\u0080-\u009f]/u;
    const MOJIBAKE_PAIR = new RegExp(
        `[${MOJIBAKE_LATIN1}][${MOJIBAKE_C1_PUNCT}${MOJIBAKE_CP1252}]`,
        "gu",
    );

    function isMojibakeName(name) {
        const text = String(name == null ? "" : name);
        if (!text) {
            return false;
        }
        if (text.includes("\ufffd") || MOJIBAKE_C1.test(text)) {
            return true;
        }
        if (MOJIBAKE_STACK.test(text)) {
            return true;
        }
        // 弱信号兜底：两个及以上 lead+continuation 对。堆叠里夹着不在
        // 字符类内的字符时 STACK 可能断成两段长度 2 的串，靠 pair 计数接住。
        const pairs = text.match(MOJIBAKE_PAIR);
        return Boolean(pairs && pairs.length >= 2);
    }

    // 扫描文件名列表，返回 false（干净）或建议代码页字符串。
    // 命中时无法可靠区分 GBK/Big5/Shift-JIS 三种来源编码（字节被误读后
    // 落在同一批 Unicode 区间），统一建议 "gbk"（用户基数最大的场景），
    // 横幅同时给出 Big5 / Shift-JIS 按钮一键试。限扫前 200 条控制成本。
    function detectMojibake(names, options) {
        const limit = options && options.maxScan > 0
            ? options.maxScan
            : MOJIBAKE_MAX_SCAN;
        if (!Array.isArray(names)) {
            return false;
        }
        const slice = names.slice(0, limit);
        for (const name of slice) {
            if (isMojibakeName(name)) {
                return "gbk";
            }
        }
        return false;
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
        MAX_HIGHLIGHT_LINES,
        MAX_PREVIEW_LINES,
        MOJIBAKE_MAX_SCAN,
        PREVIEW_MAX_SIZE,
        detectMojibake,
        escapeHtml,
        formatSize,
        formatTextPreview,
        formatImagePreview,
        formatPdfPreview,
        getFileExtension,
        getFileType,
        highlightSyntax,
        isImageFile,
        isMojibakeName,
        isPdfFile,
        isPreviewable,
        isTextFile,
        revokeBlobUrl,
    };
}(typeof window !== "undefined" ? window : globalThis));
