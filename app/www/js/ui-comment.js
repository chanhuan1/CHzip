(function (root) {
    "use strict";

    function createCommentManager(state, api) {
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
            if (
                !state.info
                || state.running
                || state.previewing
                || (state.info.partCount || 1) > 1
                || !["zip", "7z"].includes(state.info.selection?.format)
            ) {
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
            if (state.running || state.previewing) {
                els.commentError.textContent = "解压或体检进行中，暂时不能修改压缩包注释。";
                els.commentError.hidden = false;
                return;
            }

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
                els.saveCommentBtn.disabled = state.running || state.previewing;
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

        return {
            closeCommentDialog,
            copyComment,
            loadComment,
            openCommentDialog,
            saveComment,
            updateCommentStatus,
        };
    }

    root.CHzipComment = { createCommentManager };
}(typeof window !== "undefined" ? window : globalThis));
