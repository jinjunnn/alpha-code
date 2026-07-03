// REQ-012 / C14:上游 DOM 锚点契约的抽取与核对(纯 node fs,electron-free;test 与生成脚本共用)。
//
// 「锚点」= alpha reskin CSS/TSX 引用的上游 `data-component` / `data-slot` / `data-action` 值——
// 上游内部约定、非公开契约,上游可随时改名(546-sync 一次作废 94/192,见
// docs/audits/2026-07-03-frontend-reskin-regression.md)。本模块把散落引用收敛成单一机器可读清单
// (upstream-anchors.json,C14 收敛层的载体),并提供存在性核对:
//   引用集 = src/renderer/**.{css,tsx,ts} 里的 data-* 属性选择器值(排除 alpha 自有 data-alpha-*);
//   渲染集 = 上游 packages/{app,ui}/src + alpha 自有 renderer TSX(自渲染的值不算上游依赖断裂);
//   悬空(dead)= 被引用但无人渲染 → 换肤静默失效的根源。
//
// 局限(诚实):字面量匹配——上游动态拼接的 data-* 值会误报 dead;当前上游组件均为字面量,失控再升级 AST。

import * as fs from "node:fs"
import * as path from "node:path"

export type AnchorKind = "component" | "slot" | "action"
export type AnchorRef = { kind: AnchorKind; value: string }

const ATTR_RE = /data-(component|slot|action)=(?:"|')([^"']+)(?:"|')/g

const SCAN_EXT = new Set([".css", ".tsx", ".ts"])

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    // 测试文件的 fixture 锚点不是 reskin 引用,也不是渲染证据——两侧都排除。
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (SCAN_EXT.has(path.extname(entry.name))) yield p
  }
}

function readAll(dir: string): string {
  let out = ""
  for (const f of walk(dir)) out += fs.readFileSync(f, "utf8") + "\n"
  return out
}

const keyOf = (r: AnchorRef) => `${r.kind}:${r.value}`

/** alpha renderer 里被引用的上游锚点(去重排序;排除 alpha 自有 data-alpha-*)。 */
export function extractReferencedAnchors(rendererDir: string): AnchorRef[] {
  const text = readAll(rendererDir)
  const seen = new Map<string, AnchorRef>()
  for (const m of text.matchAll(ATTR_RE)) {
    const value = m[2]
    if (value.startsWith("alpha-") || value.includes("${")) continue
    const ref: AnchorRef = { kind: m[1] as AnchorKind, value }
    seen.set(keyOf(ref), ref)
  }
  return [...seen.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
}

export type AnchorCheck = { ref: AnchorRef; rendered: boolean }

export type AnchorSources = {
  /** 上游 packages/{app,ui}/src 全文(上游选择/渲染任一形态都算活——它选它必渲)。 */
  upstream: string
  /** alpha 自有 renderer 的 TSX/TS(**不含 CSS**):只认 JSX 属性渲染形态,排除 `[data-…` 选择器
   *  引用——否则 CSS/querySelector 里的引用串会自证存活(本模块首版踩过的假阳性)。 */
  alphaTsx: string
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** 存在性核对:上游宽匹配(属性字面量),alpha 自渲染须为非选择器形态的 JSX 属性。 */
export function checkAnchors(refs: AnchorRef[], sources: AnchorSources): AnchorCheck[] {
  return refs.map((ref) => {
    const attrForms = [
      `data-${ref.kind}="${ref.value}"`,
      `data-${ref.kind}='${ref.value}'`,
      // JSX 属性值为字面量表达式:data-component={"x"} / data-component={cond ? "x" : …}
      `data-${ref.kind}={"${ref.value}"`,
      `data-${ref.kind}={'${ref.value}'`,
    ]
    const inUpstream = attrForms.some((n) => sources.upstream.includes(n))
    const selfRendered = new RegExp(`(?<!\\[)data-${ref.kind}=(?:"|'|\\{"|\\{')${esc(ref.value)}(?:"|'|")`).test(
      sources.alphaTsx,
    )
    return { ref, rendered: inUpstream || selfRendered }
  })
}

/** 清单文件形状(upstream-anchors.json)。alive = 断言红线;knownDead = REQ-010 工作清单(546-sync 遗留)。 */
export type AnchorManifest = {
  note: string
  alive: string[] // "kind:value" 排序
  knownDead: string[]
}

function readTsxOnly(dir: string): string {
  let out = ""
  for (const f of walk(dir)) {
    const ext = path.extname(f)
    if (ext === ".tsx" || ext === ".ts") out += fs.readFileSync(f, "utf8") + "\n"
  }
  return out
}

/** alpha 自有包(不算上游渲染源)。 */
const ALPHA_PACKAGES = new Set(["ui-mac", "ext"])

export function loadSources(repoRoot: string, rendererDir: string): AnchorSources {
  // 扫全部非 alpha 包的 src——上游会把组件拆进新包(546 后 dock-prompt 已迁 packages/session-ui),
  // 只扫 app/ui 会把「搬家」误判成「死亡」。
  const pkgsDir = path.join(repoRoot, "packages")
  let upstream = ""
  for (const entry of fs.readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || ALPHA_PACKAGES.has(entry.name)) continue
    const src = path.join(pkgsDir, entry.name, "src")
    if (fs.existsSync(src)) upstream += readAll(src)
  }
  return { upstream, alphaTsx: readTsxOnly(rendererDir) }
}
