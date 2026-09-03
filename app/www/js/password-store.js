(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.CHzipPasswordStore = api;
    }
}(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const STORAGE_KEY = "chzip.passwords.v2";
    const MAX_ENTRIES = 50;
    const SALT_STORAGE_KEY = "chzip.passwords.salt";
    const PBKDF2_ITERATIONS = 100000;
    const DERIVED_KEY_LENGTH = 256;

    function defaultRandomId() {
        if (globalThis.crypto?.randomUUID) {
            return globalThis.crypto.randomUUID();
        }
        return `password-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function validEntry(entry) {
        return entry
            && typeof entry.id === "string"
            && typeof entry.label === "string"
            && typeof entry.password === "string"
            && typeof entry.createdAt === "string"
            && typeof entry.lastUsedAt === "string";
    }

    function getSalt(storage) {
        try {
            let saltHex = storage.getItem(SALT_STORAGE_KEY);
            if (!saltHex) {
                const saltBytes = new Uint8Array(16);
                globalThis.crypto.getRandomValues(saltBytes);
                saltHex = Array.from(saltBytes)
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
                storage.setItem(SALT_STORAGE_KEY, saltHex);
            }
            return saltHex;
        } catch (error) {
            return null;
        }
    }

    async function deriveKey(saltHex) {
        if (!globalThis.crypto?.subtle) {
            return null;
        }
        const saltBytes = new Uint8Array(
            saltHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
        );
        const baseKey = await globalThis.crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode("chzip-password-store"),
            { name: "PBKDF2" },
            false,
            ["deriveKey"],
        );
        return globalThis.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: saltBytes,
                iterations: PBKDF2_ITERATIONS,
                hash: "SHA-256",
            },
            baseKey,
            { name: "AES-GCM", length: DERIVED_KEY_LENGTH },
            false,
            ["encrypt", "decrypt"],
        );
    }

    async function encryptPassword(key, password) {
        if (!key) {
            return null;
        }
        const iv = new Uint8Array(12);
        globalThis.crypto.getRandomValues(iv);
        const encoded = new TextEncoder().encode(password);
        const ciphertext = await globalThis.crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            encoded,
        );
        return {
            iv: Array.from(iv).map((byte) => byte.toString(16).padStart(2, "0")).join(""),
            data: Array.from(new Uint8Array(ciphertext))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join(""),
        };
    }

    async function decryptPassword(key, encrypted) {
        if (!key || !encrypted) {
            return null;
        }
        try {
            const iv = new Uint8Array(
                encrypted.iv.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
            );
            const data = new Uint8Array(
                encrypted.data.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
            );
            const decrypted = await globalThis.crypto.subtle.decrypt(
                { name: "AES-GCM", iv },
                key,
                data,
            );
            return new TextDecoder().decode(decrypted);
        } catch (error) {
            return null;
        }
    }

    function createPasswordStore(storage, options = {}) {
        const now = options.now || (() => new Date().toISOString());
        const randomId = options.randomId || defaultRandomId;
        const saltHex = getSalt(storage);
        let cryptoKeyPromise = saltHex ? deriveKey(saltHex) : null;

        async function getKey() {
            if (!cryptoKeyPromise) {
                return null;
            }
            return cryptoKeyPromise;
        }

        async function read() {
            try {
                const raw = storage.getItem(STORAGE_KEY);
                if (!raw) {
                    return [];
                }
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) {
                    return [];
                }
                const key = await getKey();
                if (!key) {
                    return parsed.filter(validEntry);
                }
                const entries = [];
                for (const item of parsed) {
                    if (!item || !item.encrypted) {
                        continue;
                    }
                    const password = await decryptPassword(key, item.encrypted);
                    if (password === null) {
                        continue;
                    }
                    entries.push({
                        id: item.id,
                        label: item.label || "",
                        password,
                        archiveKey: item.archiveKey || "",
                        createdAt: item.createdAt || "",
                        lastUsedAt: item.lastUsedAt || "",
                    });
                }
                return entries;
            } catch (error) {
                return [];
            }
        }

        async function write(entries) {
            try {
                if (!entries.length) {
                    storage.removeItem(STORAGE_KEY);
                    return true;
                }
                const key = await getKey();
                const records = [];
                for (const entry of entries.slice(0, MAX_ENTRIES)) {
                    if (!key) {
                        records.push(entry);
                        continue;
                    }
                    const encrypted = await encryptPassword(key, entry.password);
                    if (!encrypted) {
                        records.push(entry);
                        continue;
                    }
                    records.push({
                        id: entry.id,
                        label: entry.label,
                        encrypted,
                        archiveKey: entry.archiveKey || "",
                        createdAt: entry.createdAt,
                        lastUsedAt: entry.lastUsedAt,
                    });
                }
                storage.setItem(STORAGE_KEY, JSON.stringify(records));
                return true;
            } catch (error) {
                return false;
            }
        }

        async function list() {
            const entries = await read();
            return entries
                .slice()
                .sort((a, b) => (
                    b.lastUsedAt.localeCompare(a.lastUsedAt)
                    || a.label.localeCompare(b.label, undefined, {
                        numeric: true,
                        sensitivity: "base",
                    })
                ));
        }

        async function get(id) {
            const entries = await read();
            return entries.find((entry) => entry.id === id) || null;
        }

        async function save(input) {
            const password = String(input.password || "");
            if (!password) {
                throw new Error("保存的密码不能为空");
            }
            const timestamp = now();
            const entries = await read();
            const existingIndex = input.id
                ? entries.findIndex((entry) => entry.id === input.id)
                : -1;
            const existing = existingIndex >= 0 ? entries[existingIndex] : null;
            const entry = {
                id: existing?.id || randomId(),
                label: String(input.label || "").trim() || "已保存密码",
                password,
                archiveKey: String(input.archiveKey || ""),
                createdAt: existing?.createdAt || timestamp,
                lastUsedAt: timestamp,
            };
            if (existingIndex >= 0) {
                entries.splice(existingIndex, 1, entry);
            } else {
                entries.unshift(entry);
            }
            entries.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
            if (!write(entries)) {
                return null;
            }
            return { ...entry };
        }

        async function touch(id) {
            const entries = await read();
            const index = entries.findIndex((entry) => entry.id === id);
            if (index < 0) {
                return null;
            }
            entries[index] = {
                ...entries[index],
                lastUsedAt: now(),
            };
            if (!await write(entries)) {
                return null;
            }
            return { ...entries[index] };
        }

        async function matchArchive(archiveKey) {
            const key = String(archiveKey || "");
            if (!key) {
                return null;
            }
            const entries = await list();
            return entries.find((entry) => entry.archiveKey === key) || null;
        }

        async function remove(id) {
            const entries = await read();
            const filtered = entries.filter((entry) => entry.id !== id);
            if (filtered.length === entries.length) {
                return false;
            }
            return write(filtered);
        }

        async function clear() {
            return write([]);
        }

        return {
            clear,
            get,
            list,
            matchArchive,
            remove,
            save,
            touch,
            isEncrypted: Boolean(saltHex && cryptoKeyPromise),
        };
    }

    return {
        MAX_ENTRIES,
        STORAGE_KEY,
        createPasswordStore,
    };
}));
