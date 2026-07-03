#!/usr/bin/env bun
// A4 fix — give the embedded opencode server a REAL InstallationVersion.
//
// The embedded server is bundled by upstream `packages/opencode/script/build-node.ts`, which defines
// OPENCODE_CHANNEL but NOT OPENCODE_VERSION. So the bundle's
//     InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
// resolves to "local". When any project with `.opencode` plugins loads, opencode's waitForDependencies
// tries to install `@opencode-ai/plugin@local` — which doesn't exist on npm — and the first request
// hangs (register A4; logged ~152×). We can't add a build `define` to the upstream build script
// (ADR-005: only-add, never edit `packages/opencode/**`), so we patch the BUILD OUTPUT (gitignored
// dist/node/node.js) instead: swap the "local" fallback for a real, npm-installable version.
//
// Purely additive alpha step (runs in prebuild after build-node). If upstream ever rewrites the
// expression, the substring won't match → we WARN and no-op (falls back to "local", loudly), so this
// can't silently rot. Bump ALPHA_OPENCODE_VERSION on upstream sync if you want it to track releases.
import path from "node:path"

// Latest published @opencode-ai/plugin (npm) — any real version makes the plugin install resolve.
const VERSION = process.env.ALPHA_OPENCODE_VERSION ?? "1.17.13"
const FILE = path.resolve(import.meta.dir, "../../opencode/dist/node/node.js")
const FROM = 'typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"'
const TO = `typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "${VERSION}"`

const text = await Bun.file(FILE).text()
if (!text.includes(FROM)) {
  console.warn(
    `[alpha:patch-server-version] InstallationVersion fallback not found in ${path.basename(FILE)} — ` +
      `upstream reworded it? Embedded server may report "local" and A4 (@opencode-ai/plugin@local) can recur. ` +
      `Update scripts/patch-server-version.ts.`,
  )
  process.exit(0)
}
await Bun.write(FILE, text.replaceAll(FROM, TO))
console.log(`[alpha:patch-server-version] embedded opencode InstallationVersion "local" → "${VERSION}" (A4)`)
