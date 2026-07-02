import Store from "electron-store"
import electron from "electron"

import { SETTINGS_STORE } from "./store-keys"

const cache = new Map<string, Store>()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\opencode.settings vs good: %APPDATA%\ai.opencode.desktop.dev\opencode.settings).
export function getStore(name = SETTINGS_STORE) {
  // C1: `name` becomes a filename under userData; a renderer-supplied "../x" (via the store IPC) would
  // escape it. Reject path separators / traversal — internal callers only pass plain "opencode.*" names.
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("invalid store name")
  }
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(name, next)
  return next
}
