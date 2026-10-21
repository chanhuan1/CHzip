"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { webcrypto } = require("node:crypto");
const {
  STORAGE_KEY,
  createPasswordStore,
} = require("../app/www/js/password-store");

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("password store refuses to save plaintext when WebCrypto is unavailable", async () => {
  const storage = createStorage();
  const store = createPasswordStore(storage, { crypto: null });

  const saved = await store.save({
    label: "NAS",
    password: "must-not-leak",
  });

  assert.equal(saved, null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem("chzip.passwords.salt"), null);
});

test("password store does not expose legacy plaintext records without a key", async () => {
  const storage = createStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify([{
    id: "legacy",
    label: "legacy",
    password: "plaintext",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  }]));
  const store = createPasswordStore(storage, { crypto: null });

  assert.deepEqual(await store.list(), []);
});

test("password store encrypts saved passwords and can decrypt them again", async () => {
  const storage = createStorage();
  const store = createPasswordStore(storage, { crypto: webcrypto });

  const saved = await store.save({
    label: "NAS",
    password: "correct horse battery staple",
  });
  assert.ok(saved);
  const raw = storage.getItem(STORAGE_KEY);
  assert.ok(raw);
  assert.equal(raw.includes("correct horse battery staple"), false);

  const entries = await store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].password, "correct horse battery staple");
  assert.equal(entries[0].label, "NAS");
});
