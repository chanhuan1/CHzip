(function (root) {
    "use strict";

    function createPasswordManager(state, passwordStore) {
        function passwordPresetLabel(entry) {
            return entry.password;
        }

        async function renderPasswordPresetList() {
            const els = state.elements;
            const entries = await passwordStore.list();
            els.passwordPresetList.replaceChildren();
            if (!entries.length) {
                const empty = document.createElement("div");
                empty.className = "password-preset-empty";
                empty.textContent = "暂无已保存密码";
                els.passwordPresetList.append(empty);
                return;
            }
            for (const entry of entries) {
                const option = document.createElement("button");
                option.type = "button";
                option.className = "password-preset-option";
                option.textContent = passwordPresetLabel(entry);
                option.title = entry.label || entry.password;
                option.setAttribute("role", "option");
                option.addEventListener("click", () => selectPasswordPreset(entry.id));
                els.passwordPresetList.append(option);
            }
        }

        async function renderPasswordManagerList() {
            const els = state.elements;
            const entries = await passwordStore.list();
            if (
                state.selectedManagerPasswordId
                && !passwordStore.get(state.selectedManagerPasswordId)
            ) {
                state.selectedManagerPasswordId = "";
            }
            const activeEntry = state.activeSavedPasswordId
                ? await passwordStore.get(state.activeSavedPasswordId)
                : null;
            if (!state.selectedManagerPasswordId && entries.length) {
                state.selectedManagerPasswordId = activeEntry?.id || entries[0].id;
            }

            els.passwordRecordList.replaceChildren();
            if (!entries.length) {
                const empty = document.createElement("div");
                empty.className = "password-preset-empty";
                empty.textContent = "暂无已保存密码";
                els.passwordRecordList.append(empty);
            } else {
                for (const entry of entries) {
                    const row = document.createElement("button");
                    row.type = "button";
                    row.className = "password-record-row";
                    row.classList.toggle(
                        "is-selected",
                        entry.id === state.selectedManagerPasswordId,
                    );
                    row.setAttribute("role", "option");
                    row.setAttribute(
                        "aria-selected",
                        entry.id === state.selectedManagerPasswordId ? "true" : "false",
                    );
                    const password = document.createElement("span");
                    password.textContent = entry.password;
                    const label = document.createElement("span");
                    label.textContent = entry.label || "";
                    row.append(password, label);
                    row.addEventListener("click", () => selectManagerPassword(entry.id));
                    els.passwordRecordList.append(row);
                }
            }
            const hasSelection = Boolean(state.selectedManagerPasswordId);
            els.editPasswordBtn.disabled = !hasSelection;
            els.deletePasswordBtn.disabled = !hasSelection;
        }

        async function renderSavedPasswords() {
            await renderPasswordPresetList();
            await renderPasswordManagerList();
            updatePasswordManagerStatus();
        }

        function openPasswordPrompt(message) {
            renderSavedPasswords();
            state.elements.passwordPromptError.textContent = message || "";
            state.elements.passwordPromptError.hidden = !message;
            closePasswordPresetList();
            state.elements.passwordPromptDialog.hidden = false;
            window.setTimeout(() => state.elements.passwordInput.focus(), 0);
        }

        function closePasswordPrompt(force = false) {
            if (state.previewing && !force) {
                return;
            }
            closePasswordPresetList();
            state.elements.passwordPromptDialog.hidden = true;
            state.elements.passwordPromptError.textContent = "";
            state.elements.passwordPromptError.hidden = true;
        }

        function togglePasswordPresetList() {
            state.passwordPresetOpen = !state.passwordPresetOpen;
            if (state.passwordPresetOpen) {
                renderPasswordPresetList();
            }
            state.elements.passwordPresetList.hidden = !state.passwordPresetOpen;
            state.elements.passwordPresetToggleBtn.setAttribute(
                "aria-expanded",
                state.passwordPresetOpen ? "true" : "false",
            );
        }

        function closePasswordPresetList() {
            state.passwordPresetOpen = false;
            state.elements.passwordPresetList.hidden = true;
            state.elements.passwordPresetToggleBtn.setAttribute("aria-expanded", "false");
        }

        function selectPasswordPreset(id) {
            passwordStore.get(id).then((selected) => {
                if (!selected) {
                    return;
                }
                state.activeSavedPasswordId = selected.id;
                state.elements.passwordInput.value = selected.password;
                closePasswordPresetList();
                state.elements.passwordPromptError.textContent = "";
                state.elements.passwordPromptError.hidden = true;
                invalidatePasswordVerification();
                updatePasswordManagerStatus();
            });
        }

        function selectManagerPassword(id) {
            state.selectedManagerPasswordId = id;
            renderPasswordManagerList();
        }

        function openPasswordManager(source = "main") {
            state.returnToPasswordPrompt = source === "prompt"
                && !state.elements.passwordPromptDialog.hidden;
            if (state.returnToPasswordPrompt) {
                state.elements.passwordPromptDialog.hidden = true;
            }
            renderSavedPasswords();
            state.elements.passwordManagerDialog.hidden = false;
        }

        function closePasswordManager() {
            state.elements.passwordManagerDialog.hidden = true;
            if (state.returnToPasswordPrompt) {
                state.returnToPasswordPrompt = false;
                state.elements.passwordPromptDialog.hidden = false;
                window.setTimeout(() => state.elements.passwordInput.focus(), 0);
            }
        }

        function openPasswordRecordDialog(mode) {
            const els = state.elements;
            const editing = mode === "edit"
                ? passwordStore.get(state.selectedManagerPasswordId)
                : null;
            if (mode === "edit") {
                editing.then((entry) => {
                    if (!entry) {
                        return;
                    }
                    state.editingPasswordId = entry.id;
                    els.recordPasswordInput.value = entry.password || "";
                    els.recordLabelInput.value = entry.label || "";
                    els.passwordRecordDialogTitle.textContent = "编辑密码";
                    els.passwordRecordError.textContent = "";
                    els.passwordRecordError.hidden = true;
                    els.passwordRecordDialog.hidden = false;
                    window.setTimeout(() => els.recordPasswordInput.focus(), 0);
                });
                return;
            }
            state.editingPasswordId = "";
            els.recordPasswordInput.value = "";
            els.recordLabelInput.value = "";
            els.passwordRecordDialogTitle.textContent = "添加密码";
            els.passwordRecordError.textContent = "";
            els.passwordRecordError.hidden = true;
            els.passwordRecordDialog.hidden = false;
            window.setTimeout(() => els.recordPasswordInput.focus(), 0);
        }

        function closePasswordRecordDialog() {
            state.elements.passwordRecordDialog.hidden = true;
            state.elements.passwordRecordError.textContent = "";
            state.elements.passwordRecordError.hidden = true;
        }

        function invalidatePasswordVerification() {
            if (!state.passwordRequired) {
                return;
            }
            state.passwordVerified = false;
            updatePasswordManagerStatus();
        }

        async function rememberPasswordAfterSuccessfulPreview(previewRequest) {
            const password = previewRequest.password;
            if (!password) {
                return true;
            }

            const active = previewRequest.activeSavedPasswordId
                ? await passwordStore.get(previewRequest.activeSavedPasswordId)
                : null;
            if (active && active.password === password) {
                const touched = await passwordStore.touch(active.id);
                await renderSavedPasswords();
                return Boolean(touched);
            }
            return true;
        }

        async function savePasswordRecord() {
            const els = state.elements;
            const password = els.recordPasswordInput.value;
            if (!password) {
                els.passwordRecordError.textContent = "请输入需要保存的密码。";
                els.passwordRecordError.hidden = false;
                return;
            }
            const label = els.recordLabelInput.value.trim();
            const previous = state.editingPasswordId
                ? await passwordStore.get(state.editingPasswordId)
                : null;
            const saved = await passwordStore.save({
                id: state.editingPasswordId || undefined,
                label,
                password,
                archiveKey: "",
            });
            if (!saved) {
                els.passwordRecordError.textContent = "浏览器无法保存密码，请检查本地存储权限。";
                els.passwordRecordError.hidden = false;
                return;
            }
            state.selectedManagerPasswordId = saved.id;
            if (previous?.id === state.activeSavedPasswordId) {
                state.activeSavedPasswordId = saved.id;
                els.passwordInput.value = saved.password;
                invalidatePasswordVerification();
            }
            closePasswordRecordDialog();
            await renderSavedPasswords();
        }

        async function deleteSelectedPassword() {
            const id = state.selectedManagerPasswordId;
            if (!id) {
                return;
            }
            await passwordStore.remove(id);
            if (state.activeSavedPasswordId === id) {
                state.activeSavedPasswordId = "";
                state.elements.passwordInput.value = "";
                invalidatePasswordVerification();
            }
            state.selectedManagerPasswordId = "";
            await renderSavedPasswords();
        }

        function updatePasswordManagerStatus() {
            const els = state.elements;
            let status = "等待文件";
            if (state.info) {
                if (state.passwordRequired && !state.passwordVerified) {
                    status = "待验证";
                } else if (state.passwordRequired && state.passwordVerified) {
                    status = "密码已验证";
                } else {
                    passwordStore.list().then((entries) => {
                        const count = entries.length;
                        els.passwordManagerStatus.textContent = count ? `已保存 ${count} 个密码` : "未保存密码";
                    });
                    return;
                }
            }
            els.passwordManagerStatus.textContent = status;
        }

        return {
            closePasswordManager,
            closePasswordPresetList,
            closePasswordPrompt,
            closePasswordRecordDialog,
            deleteSelectedPassword,
            invalidatePasswordVerification,
            openPasswordManager,
            openPasswordPrompt,
            openPasswordRecordDialog,
            rememberPasswordAfterSuccessfulPreview,
            renderSavedPasswords,
            savePasswordRecord,
            selectManagerPassword,
            selectPasswordPreset,
            togglePasswordPresetList,
            updatePasswordManagerStatus,
        };
    }

    root.CHzipUiPasswords = { createPasswordManager };
}(typeof window !== "undefined" ? window : globalThis));
