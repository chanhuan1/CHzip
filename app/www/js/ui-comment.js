(function (root) {
    "use strict";

    function createCommentManager(state, api) {
        let currentComment = "";
        let originalComment = "";

        function updateCommentStatus() {
            const els = state.elements;
            if (!els.commentStatus) {
                return;
            }
            if (originalComment) {
                const preview = originalComment.slice(0, 50).replace(/\n/g, " ");
                els.commentStatus.textContent = preview + (originalComment.length > 50 ? "..." : "");
                els.commentStatus.classList.add("has-comment");
            } else {
                els.commentStatus.textContent = "无注释";
                els.commentStatus.classList.remove("has-comment");
            }
        }

        function openCommentDialog() {
            const els = state.elements;
            if (!state.info) {
                return;
            }
            els.commentError.textContent = "";
            els.commentError.hidden = true;
            els.commentTextarea.value = originalComment;
            els.commentDialog.hidden = false;
            setTimeout(() => els.commentTextarea.focus(), 0);
        }

        function closeCommentDialog() {
            state.elements.commentDialog.hidden = true;
        }

        async function loadComment() {
            if (!state.filePath) {
                return;
            }
            try {
                const result = await api.requestJson(api.apiUrl("comment", {
                    path: state.filePath,
                }));
                originalComment = result.comment || "";
            } catch (error) {
                originalComment = "";
            }
            updateCommentStatus();
        }

        async function saveComment() {
            const els = state.elements;
            const comment = els.commentTextarea.value;

            els.saveCommentBtn.disabled = true;
            els.saveCommentBtn.textContent = "保存中...";

            try {
                await api.postApi("comment", {
                    path: state.filePath,
                    comment,
                });
                originalComment = comment;
                closeCommentDialog();
            } catch (error) {
                els.commentError.textContent = error.message || "保存失败";
                els.commentError.hidden = false;
            } finally {
                els.saveCommentBtn.disabled = false;
                els.saveCommentBtn.textContent = "保存";
            }
        }

        async function copyComment() {
            const els = state.elements;
            const text = els.commentTextarea.value || originalComment;
            if (!text) {
                return;
            }
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    const textarea = document.createElement("textarea");
                    textarea.value = text;
                    textarea.style.position = "fixed";
                    textarea.style.opacity = "0";
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand("copy");
                    textarea.remove();
                }
                const originalText = els.commentCopyBtn.textContent;
                els.commentCopyBtn.textContent = "已复制";
                setTimeout(() => {
                    els.commentCopyBtn.textContent = originalText;
                }, 1500);
            } catch {
                // Ignore copy errors
            }
        }

        function getCurrentComment() {
            return originalComment;
        }

        function hasComment() {
            return Boolean(originalComment);
        }

        return {
            closeCommentDialog,
            copyComment,
            getCurrentComment,
            hasComment,
            loadComment,
            openCommentDialog,
            saveComment,
            updateCommentStatus,
        };
    }

    root.CHzipComment = { createCommentManager };
}(typeof window !== "undefined" ? window : globalThis));
