#!/usr/bin/env bun
// Bundle @alpha-code/ext into a SELF-CONTAINED ESM file the embedded Electron-Node
// server can load without resolving raw TS at runtime. See .claude/rules/DECISIONS.md ADR-006.
//
// Why bundle at all:
//   The desktop server runs under Electron's Node. Node type-strips `.ts` but does NOT
//   remap `.js`→`.ts` import specifiers. `@opencode-ai/plugin` ships only TS source whose
//   files import each other with `.js` specifiers (the nodenext convention), so loading it
//   raw under Node dies with ERR_MODULE_NOT_FOUND (.../tool.js from .../index.ts).
//   Bundling inlines `@opencode-ai/plugin` (+ the zod it pulls in) into one plain `.js`,
//   so the server only ever imports already-resolved JS.
import { createHash } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TOOL_TEXT } from "../src/context-injection"

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.chdir(pkgDir)
rmSync("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["./src/plugin.ts"],
  outdir: "./dist",
  target: "node", // Node-compatible output; Node built-ins stay external automatically
  format: "esm",
  sourcemap: "linked",
  // No `external`: inline EVERYTHING (incl. @opencode-ai/plugin + zod) so the embedded
  // Node server never has to resolve a raw `.ts` at runtime — the whole point of ADR-006.
  //
  // Known G1 caveat: the opencode server bundle carries its OWN zod/effect copy, so the
  // schemas this plugin builds (via `tool.schema`) live on a DIFFERENT instance than the
  // server's. opencode's tool ingestion must treat plugin schemas structurally. Validate
  // when wiring G1: load ext → `alpha_ping` appears in the tool list AND executes.
})

if (!result.success) {
  console.error("[@alpha-code/ext] bundle failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// #1578 AC5 (REQ-236 §2.6-7): the trusted bundled manifest, shipped next to plugin.js (electron-builder `alpha-ext/`).
// The engine gives `alpha-bundled` only to these tool names, and only when the plugin module it loaded hashes to this
// digest (packages/opencode/src/plugin/alpha-bundled-plugin.ts). Tool names = TOOL_TEXT's keys, which
// src/context-injection.test.ts pins to the real AlphaExt's own tool set; project plugins merged in at runtime are
// never listed.
const manifest = {
  moduleSha256: createHash("sha256").update(readFileSync("dist/plugin.js")).digest("hex"),
  tools: Object.keys(TOOL_TEXT).sort(),
}
writeFileSync("dist/bundled-tools.json", `${JSON.stringify(manifest, null, 2)}\n`)

const outputs = result.outputs.map((o) => path.relative(pkgDir, o.path)).join(", ")
console.log(`[@alpha-code/ext] bundled → ${outputs}, dist/bundled-tools.json`)
