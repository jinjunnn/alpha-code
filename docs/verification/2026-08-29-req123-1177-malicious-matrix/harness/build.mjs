// REQ-123 / alpha-code#1177 — bundle the probe entry with the SAME vite plugin the merged
// office-preview.test.ts uses, then hand the single-file ESM bundle to the Electron main.
// Bundling (not raw ts) is required: the probe imports the production extraction modules,
// which import @zip.js and use JSX-free TS that the renderer build resolves.

import { build } from "vite"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
// Entry may be passed absolute (argv[2]) so this file can be executed from inside
// packages/ui-mac, where vite / @opencode-ai/app resolve. Defaults to the sibling.
const entry = process.argv[2] || join(here, "probe-entry.ts")
const outDir = mkdtempSync(join(tmpdir(), "req123-1177-probe-"))

// Anchor resolution at packages/ui-mac (argv[3]) so the probe's own @zip.js import
// resolves the same way the production modules' imports do.
const root = process.argv[3] || process.cwd()

await build({
  configFile: false,
  logLevel: "warn",
  root,
  plugins: [appPlugin.at(-1)],
  build: {
    emptyOutDir: true,
    outDir,
    lib: {
      entry,
      formats: ["es"],
      fileName: () => "probe-bundle.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

process.stdout.write(join(outDir, "probe-bundle.js"))
