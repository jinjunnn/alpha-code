#!/usr/bin/env bun
// Install the freshly packaged .app into /Applications so Spotlight (Cmd+Space)
// opens the LATEST build — not the stale one left in dist/ or a running dev shell.
//
// Why this exists: `bun run dev` launches a hot-reload instance that only the
// developer sees. The app the user actually opens via Spotlight is the packaged
// bundle. After every code change we must rebuild → repackage → reinstall so the
// Spotlight-launched app is current. This is the last step of `ship:mac`.
import { spawnSync } from "node:child_process"
import { existsSync, rmSync, cpSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, "..")

const DIST_DIR = path.join(packageDir, "dist")
const SRC = path.join(DIST_DIR, "mac-arm64", "alpha-code.app")
const DEST = "/Applications/alpha-code.app"
const APP_ID = "ai.opencode.desktop.dev"

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if (!existsSync(SRC)) {
  console.error(`✗ packaged app not found at ${SRC}\n  Run \`bun run build && bun run package:mac\` first (or use \`bun run ship:mac\`).`)
  process.exit(1)
}

// 1. Quit any running instance so we can overwrite it and release the single-instance lock.
spawnSync("pkill", ["-f", "alpha-code.app/Contents/MacOS"], { stdio: "ignore" })

// 2. Clear the single-instance lock (dev and packaged share bundle id → would otherwise
//    block the next launch). electron-store / chromium singleton files live under userData.
const singletonDir = path.join(homedir(), "Library", "Application Support", APP_ID)
for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
  try {
    rmSync(path.join(singletonDir, f), { force: true })
  } catch {}
}

// 3. Replace the installed bundle.
rmSync(DEST, { recursive: true, force: true })
cpSync(SRC, DEST, { recursive: true })

// 4. Drop the redundant build artifact so Spotlight only ever shows ONE
//    "alpha-code" (the /Applications install). The dist copy is just an
//    intermediate; /Applications is canonical. Unregister it from
//    LaunchServices first so Cmd+Space forgets it immediately.
if (existsSync(lsregister)) spawnSync(lsregister, ["-u", SRC], { stdio: "ignore" })
rmSync(SRC, { recursive: true, force: true })
// Belt-and-suspenders: tell Spotlight never to index anything under dist/, so a
// future `package:mac` artifact can't reappear in Cmd+Space before we move it.
try {
  writeFileSync(path.join(DIST_DIR, ".metadata_never_index"), "")
} catch {}

// 5. Nudge LaunchServices + Spotlight so Cmd+Space resolves the new bundle.
if (existsSync(lsregister)) spawnSync(lsregister, ["-f", DEST], { stdio: "ignore" })
spawnSync("mdimport", [DEST], { stdio: "ignore" })

console.log(`✓ installed → ${DEST}`)
console.log(`  removed redundant dist artifact (Spotlight now shows one app)`)
console.log(`  Open with Cmd+Space → "alpha-code". (No dev instance needed.)`)
