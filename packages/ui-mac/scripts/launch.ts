#!/usr/bin/env bun
// Launch electron-vite with the electron binary path resolved explicitly.
//
// Why: electron-vite is installed at the workspace ROOT, but opencode uses a
// non-hoisted install so ui-mac's electron lives in packages/ui-mac/node_modules.
// electron-vite can't find it from root and throws "Electron uninstall". We
// resolve electron's binary here and pass it via ELECTRON_EXEC_PATH.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
// electron's package main exports the absolute path to the Electron binary.
const ELECTRON_EXEC_PATH = require("electron") as unknown as string

const mode = process.argv[2] ?? "dev"
const result = spawnSync("bunx", ["electron-vite", mode], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_EXEC_PATH },
})
process.exit(result.status ?? 1)
