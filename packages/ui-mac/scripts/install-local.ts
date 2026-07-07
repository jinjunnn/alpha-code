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

// Resolve app name + bundle id from the channel, mirroring electron-builder.config.ts so a prod
// (or beta) ship installs/cleans the RIGHT bundle instead of the hardcoded dev one (ADR-012 fix).
const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  return raw === "prod" || raw === "beta" ? raw : "dev"
})()
const PRODUCT_NAMES = { dev: "alpha-code", beta: "alpha-code Beta", prod: "alpha-code" } as const
const APP_IDS = {
  dev: "com.tide.alphacode.dev",
  beta: "com.tide.alphacode.beta",
  prod: "com.tide.alphacode",
} as const
const appName = `${PRODUCT_NAMES[channel]}.app`

const DIST_DIR = path.join(packageDir, "dist")
const SRC = path.join(DIST_DIR, "mac-arm64", appName)
const DEST = `/Applications/${appName}`
const APP_ID = APP_IDS[channel]

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if (!existsSync(SRC)) {
  console.error(`✗ packaged app not found at ${SRC}\n  Run \`bun run build && bun run package:mac\` first (or use \`bun run ship:mac\`).`)
  process.exit(1)
}

// 1. Quit any running instance so we can overwrite it and release the single-instance lock.
spawnSync("pkill", ["-f", `${appName}/Contents/MacOS`], { stdio: "ignore" })

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

// 3.5 macOS SIGKILLs unsigned bundles at launch ("Code Signature Invalid" — REQ-057 real-machine
//    2026-07-07: local channels pack with identity:null → electron-builder skips signing entirely,
//    leaving the raw linker-signed Electron binary; the installed app then dies silently with no
//    window). If the installed bundle fails verification, stamp an ad-hoc signature (cert-free,
//    local-only). A properly signed build (Developer ID prod) passes verification and is untouched.
//    Loud-fail: never report "installed" for an app that cannot launch.
const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", DEST], { stdio: "ignore" })
if (verify.status !== 0) {
  console.log("  bundle unsigned/invalid — stamping ad-hoc signature (macOS launch requirement)")
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", DEST], { stdio: "inherit" })
  const recheck = sign.status === 0 && spawnSync("codesign", ["--verify", "--deep", "--strict", DEST], { stdio: "ignore" }).status === 0
  if (!recheck) {
    console.error("✗ ad-hoc codesign failed — app would be SIGKILLed on launch (Code Signature Invalid). Aborting.")
    process.exit(1)
  }
}

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
