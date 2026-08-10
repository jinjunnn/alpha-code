#!/usr/bin/env bun
// #857 — publish the governed models.dev base before the remaining internal plugins.
//
// Upstream PluginInternal registers every internal plugin inside one State.batch. That
// defers the ModelsDevPlugin catalog commit until the later config/provider/variant
// plugins finish, so the renderer's readiness marker cannot become visible early even
// when the generated models.dev base is already complete. ADR-005 forbids editing the
// upstream source, so Alpha moves that one generated registration in the gitignored
// embedded-server bundle immediately after build-node.
//
// This patch is deliberately strict. Generated-name suffixes may change, but the target
// must remain one unambiguous PluginInternal.boot block with one ModelsDevPlugin add and
// a contiguous prefix of plugin registrations. Any structural drift aborts the build.
import path from "node:path"

const FILE = path.resolve(import.meta.dir, "../../opencode/dist/node/node.js")
const MODEL_LINE = /^(\s*)yield\*\s+([A-Za-z_$][\w$]*)\(ModelsDevPlugin\);\s*$/
const BATCH_LINE = /^(\s*)yield\*\s+[A-Za-z_$][\w$]*\.batch\([A-Za-z_$][\w$]*\.gen\(function\*\s*\(\)\s*\{\s*$/

export function patchPluginInternalModels(text: string) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)
  const boot = lines.flatMap((line, index) => (line.includes('withSpan("PluginInternal.boot")') ? [index] : []))
  if (boot.length !== 1) throw new Error(`expected one PluginInternal.boot block, found ${boot.length}`)

  const start = Math.max(0, boot[0]! - 40)
  const models = lines
    .slice(start, boot[0]! + 1)
    .flatMap((line, offset) => (MODEL_LINE.test(line) ? [start + offset] : []))
  if (models.length !== 1) throw new Error(`expected one ModelsDevPlugin registration near boot, found ${models.length}`)

  const batches = lines
    .slice(start, boot[0]! + 1)
    .flatMap((line, offset) => (BATCH_LINE.test(line) ? [start + offset] : []))
  if (batches.length !== 1) throw new Error(`expected one State.batch near boot, found ${batches.length}`)

  const model = models[0]!
  const batch = batches[0]!
  const modelMatch = lines[model]!.match(MODEL_LINE)!
  const batchMatch = lines[batch]!.match(BATCH_LINE)!
  if (model === batch - 1 && modelMatch[1] === batchMatch[1]) return text
  if (model <= batch) throw new Error("ModelsDevPlugin registration is not inside or immediately before State.batch")
  if (modelMatch[1] !== `${batchMatch[1]}  `) throw new Error("ModelsDevPlugin registration indentation drifted")

  const add = modelMatch[2]!
  const escapedAdd = add.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pluginLine = new RegExp(`^${modelMatch[1]}yield\\*\\s+${escapedAdd}\\([^)]*\\.Plugin\\);\\s*$`)
  const prefix = lines.slice(batch + 1, model)
  if (prefix.length === 0 || prefix.some((line) => !pluginLine.test(line))) {
    throw new Error("unexpected PluginInternal.boot prefix before ModelsDevPlugin")
  }

  lines.splice(model, 1)
  lines.splice(batch, 0, `${batchMatch[1]}yield* ${add}(ModelsDevPlugin);`)
  return lines.join(newline)
}

if (import.meta.main) {
  const text = await Bun.file(FILE).text()
  const patched = patchPluginInternalModels(text)
  if (patched === text) {
    console.log("[alpha:patch-plugin-internal-models] embedded server already publishes ModelsDevPlugin before batch")
  } else {
    await Bun.write(FILE, patched)
    console.log("[alpha:patch-plugin-internal-models] moved ModelsDevPlugin before PluginInternal State.batch (#857)")
  }
}
