"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/www/js/ui-passwords");

function createElement() {
  return {
    className: "",
    textContent: "",
    classList: { toggle() {} },
    append() {},
    setAttribute() {},
    addEventListener() {},
  };
}

function createList() {
  return {
    replaceChildren() {},
    append() {},
  };
}

test("password manager clears a selected entry that no longer exists", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement,
  };
  try {
    const state = {
      selectedManagerPasswordId: "missing",
      activeSavedPasswordId: "",
      passwordRequired: false,
      passwordVerified: false,
      info: null,
      elements: {
        passwordPresetList: createList(),
        passwordRecordList: createList(),
        editPasswordBtn: { disabled: false },
        deletePasswordBtn: { disabled: false },
        passwordManagerStatus: { textContent: "" },
      },
    };
    const store = {
      list: async () => [],
      get: async () => null,
      touch: async () => null,
      save: async () => null,
      remove: async () => false,
    };
    const manager = globalThis.CHzipUiPasswords.createPasswordManager(
      state,
      store,
    );

    await manager.renderSavedPasswords();

    assert.equal(state.selectedManagerPasswordId, "");
    assert.equal(state.elements.editPasswordBtn.disabled, true);
    assert.equal(state.elements.deletePasswordBtn.disabled, true);
  } finally {
    if (originalDocument) {
      globalThis.document = originalDocument;
    } else {
      delete globalThis.document;
    }
  }
});
