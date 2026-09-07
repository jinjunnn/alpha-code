#!/usr/bin/env bun
// A4 fix — give the embedded opencode server a REAL InstallationVersion.
//
// The embedded server is bundled by upstream `packages/opencode/script/build-node.ts`. Any project
// with `.opencode` plugins makes upstream `config.ts` background-install
// `@opencode-ai/plugin@${InstallationVersion}` — so whatever version is baked into the bundle must
// exist on npm, or every plugin project silently loses that dependency (register A4; logged ~152×
// when the bundle said "local"). We can't add a build `define` to the upstream build script
// (ADR-005: only-add, never edit `packages/opencode/**`), so we patch the BUILD OUTPUT (gitignored
// dist/node/node.js) instead.
//
// What the bundle carries (ac#1248, upstream e11dbd020): build-node.ts now defines
// `OPENCODE_VERSION: Script.version`, so the bundler constant-folds the old
// `typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"` fallback away and emits one
// baked literal — `InstallationVersion = "<x>"`. In every alpha build `<x>` is not an npm version:
// Script.version is a preview string (`0.0.0-<channel|branch>-<yyyymmddhhmm>`) whenever
// OPENCODE_CHANNEL !== "latest" (alpha builds run dev/beta/prod or the bare git branch), and a
// packaging job that exports OPENCODE_VERSION bakes the *app* version (e.g. 0.1.10) instead.
// Real build on the sync stack, 2026-09-07:
//   var InstallationVersion = "0.0.0-verify/1248-bump-on-sync-202609070253", InstallationChannel = …
// The previous version of this script looked for the pre-fold substring, warned, and exited 0 —
// a silent no-op, and A4 was back without any gate going red. It now targets the baked literal,
// always replaces it, and FAILS CLOSED (non-zero ⇒ prebuild aborts) when the shape drifts again.
// Judged by packages/ui-mac/src/main/embedded-server-version.test.ts.
import path from "node:path"

// Latest published @opencode-ai/plugin (npm) — any real version makes the plugin install resolve.
export const ALPHA_OPENCODE_VERSION_DEFAULT = "1.17.13"
const FILE = path.resolve(import.meta.dir, "../../opencode/dist/node/node.js")
const TARGET = /\bInstallationVersion = "([^"]*)"/g
const RELEASE = /^\d+\.\d+\.\d+$/

export function patchServerVersion(text: string, version: string) {
  if (!RELEASE.test(version)) {
    throw new Error(
      `refusing InstallationVersion ${JSON.stringify(version)}: @opencode-ai/plugin@<version> must be a published release`,
    )
  }
  const hits = [...text.matchAll(TARGET)]
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one baked InstallationVersion literal in the embedded server bundle, found ${hits.length} — ` +
        `upstream build-node.ts / installation/version.ts drifted? update scripts/patch-server-version.ts`,
    )
  }
  const baked = hits[0]![1]!
  if (baked === version) return { text, baked, changed: false }
  return { text: text.replace(TARGET, `InstallationVersion = "${version}"`), baked, changed: true }
}

if (import.meta.main) {
  const version = process.env.ALPHA_OPENCODE_VERSION ?? ALPHA_OPENCODE_VERSION_DEFAULT
  const text = await Bun.file(FILE).text()
  const result = patchServerVersion(text, version)
  if (result.changed) {
    await Bun.write(FILE, result.text)
    console.log(`[alpha:patch-server-version] embedded opencode InstallationVersion "${result.baked}" → "${version}" (A4)`)
  } else {
    console.log(`[alpha:patch-server-version] embedded opencode InstallationVersion already "${version}" (A4)`)
  }
}
