// The ONLY place alpha's key store (alpha-byok-keys.ts) touches Electron's safeStorage — REQ-226 `#1343`.
//
// Namespace import on purpose. bun's `mock.module("electron", …)` fixes the module's export-NAME set at the
// FIRST factory instantiated in the test process; later factories only update the values of those names and
// silently drop new ones (probe 2026-09-17: first factory `{a}`, second `{a, b}` ⇒ `import { b }` throws
// "Export named 'b' not found", namespace `.b` is undefined; bun's file order is not CLI order). With a named
// `import { safeStorage } from "electron"` every in-process consumer of the store would therefore link or
// fail depending on which unrelated test file's electron mock ran first. A namespace import always links;
// tests mock THIS module (one function, a key set we own) and the real store logic runs on top of it.
// Absent backend (no Electron, or a mock without safeStorage) ⇒ `undefined` ⇒ the store refuses (fail closed).

import * as electron from "electron"

export type KeychainBackend = Pick<typeof electron.safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">

export function keychainBackend(): KeychainBackend | undefined {
  return electron.safeStorage
}
