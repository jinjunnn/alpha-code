// REQ-012:生成/刷新上游锚点契约清单 upstream-anchors.json。
// 用法:bun scripts/gen-upstream-anchors.ts   (在 packages/ui-mac 下)
// 语义:当前引用集里「渲染得到」的进 alive(断言红线),「悬空」的进 knownDead(= REQ-010 工作清单;
// 修复接线后重跑本脚本,dead 项自然迁回 alive/消失)。
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { checkAnchors, extractReferencedAnchors, loadSources, type AnchorManifest } from "../src/renderer/alpha-ui/anchor-audit"

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(pkgRoot, "..", "..")
const rendererDir = path.join(pkgRoot, "src", "renderer")

const refs = extractReferencedAnchors(rendererDir)
const checks = checkAnchors(refs, loadSources(repoRoot, rendererDir))
const alive = checks.filter((c) => c.rendered).map((c) => `${c.ref.kind}:${c.ref.value}`)
const knownDead = checks.filter((c) => !c.rendered).map((c) => `${c.ref.kind}:${c.ref.value}`)

const manifest: AnchorManifest = {
  note: "REQ-012 锚点契约清单(C14 收敛层载体)。由 scripts/gen-upstream-anchors.ts 生成;alive 为 CI 断言红线,knownDead 为 546-sync 遗留悬空锚点(= REQ-010 重接线工作清单)。手改无效——改 CSS/TSX 后重跑生成。",
  alive,
  knownDead,
}
const out = path.join(rendererDir, "alpha-ui", "upstream-anchors.json")
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n")
console.log(`written ${out}: alive=${alive.length} knownDead=${knownDead.length}`)
