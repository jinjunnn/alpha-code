// Artifact renderer registry — REQ-095 核心(alpha-code#187)。纯逻辑、零 DOM、零 IPC,bun:test 可全测。
//
// 确定性路由(优先级从高到低,同源内按 priority 降序、id 升序稳定裁决):
//   ① 本地 OOXML 结构检测(strict raw ZIP + bounded all-entry inflate + package root relationship)——
//      只有检测成功且扩展名/claimed/detected 声称不冲突时,才允许外部 Office 特权打开;
//      检测中、检测失败、畸形/超限容器、结构冲突一律 non-privileged fallback;
//   ② detectedMime(magic 检测,local.detectedMime ?? descriptor.detectedMime)——
//      一旦存在即**权威**:仅按它路由;它映射不到 renderer 就直接 fallback,
//      绝不再退回 claimed/扩展名(检测说是 zip 的东西,不因声明是 text 就当文本打开);
//   ③ claimedMime(产出端按扩展名声明)—— 无检测结果时使用;
//   ④ 文件扩展名 —— 无任何 MIME 时的最后猜测;
//   ⑤ fallback renderer(descriptor 事实 + 外部打开)。
// 冲突诚实(REQ-093 内容鉴别诚实原则):claimed 与 detected 不一致 → 按 detected 路由 + warning;
// claimed 与扩展名指向不同 renderer(且无 detected)→ 按 claimed 路由 + warning。
//
// 安全路由决策(恶意 fixture 矩阵的依据,见 registry.test.ts):
//   · text/html / xhtml 永不内联渲染 —— 路由到 "html" 卡片(下载/外部打开)。
//     ⚠️ REQ-096 集成点:隔离 HTML 预览落地后,把 RENDERER_COMPONENTS["html"](workbench 侧)
//     换成其组件即可,本注册表的路由结果("html")保持不变。
//   · image/svg+xml 永不作为内联图片/DOM —— 路由到 "code"(源码只读)。SVG 净化渲染是后续
//     深化;在此之前源码视图是唯一诚实且安全的呈现。
//   · "image" renderer 只经 <img> + blob 呈现(被动解码,不执行脚本);声明为 image/* 的
//     非图片内容最多解码失败 → 可恢复错误卡,不会执行。

import {
  OOXML_SUBTYPES,
  ooxmlOpenConflicts,
  shouldGateOoxml,
  type OoxmlDetection,
  type OoxmlSubtype,
} from "./ooxml"

export type RendererId =
  | "markdown"
  | "code"
  | "text"
  | "json"
  | "csv"
  | "image"
  | "pdf"
  | "html" // 占位卡片;REQ-096 隔离预览的接线点(见文件头注释)
  | "fallback"

/** 路由候选:某一来源解析出的 MIME(已规范化)+ 文件名(供 canRender 参考扩展名)。 */
export type RouteCandidate = { mime: string | null; name: string }

/** 注册表条目(REQ-095 交付 1 的 declarative 形状;render 组件由 workbench 侧按 id 查表)。 */
export type RendererRegistration = {
  id: RendererId
  /** 同一来源命中多个 renderer 时的裁决序(降序;相同则按 id 字典序 —— 完全确定)。 */
  priority: number
  canRender: (candidate: RouteCandidate) => boolean
}

export type RouteSource = "detected" | "claimed" | "extension" | "none"

export type RouteDecision = {
  rendererId: RendererId
  /** 实际用于路由的 MIME(fallback 时为 null)。 */
  effectiveMime: string | null
  source: RouteSource
  /** 可解释的选择原因(REQ-095 AC#1:Metadata 明确显示选中的 renderer 和原因)。 */
  reason: string
  /** 诚实警告(MIME 冲突、扩展名不符等)—— UI 以 chip 呈现。 */
  warnings: string[]
  /** 系统外部打开是 renderer 的特权动作;疑似 OOXML 必须先过结构闸。 */
  externalOpen: "allowed" | "blocked"
  /** 仅本地结构检测成功时存在;从不由扩展名/claimedMime 合成。 */
  ooxmlSubtype?: OoxmlSubtype
}

export type RouteInput = {
  name: string
  claimedMime?: string | null
  detectedMime?: string | null
  ooxml?: OoxmlDetection | null
}

// ---------------------------------------------------------------------------
// MIME / 扩展名规范化
// ---------------------------------------------------------------------------

/** 小写 + 去参数("; charset=utf-8")+ trim;空/非法 → null。 */
export function normalizeMime(mime: string | null | undefined): string | null {
  if (typeof mime !== "string") return null
  const m = mime.split(";")[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(m) ? m : null
}

export function extensionOf(name: string): string | null {
  const base = name.split("/").pop() ?? name
  const idx = base.lastIndexOf(".")
  if (idx <= 0 || idx === base.length - 1) return null
  return base.slice(idx + 1).toLowerCase()
}

const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const CODE_MIMES = new Set([
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-typescript",
  "application/xml",
  "text/xml",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-yaml",
  "application/yaml",
  "text/yaml",
  "application/toml",
  "text/css",
  "application/sql",
  "image/svg+xml", // 安全路由决策:SVG → 源码只读(见文件头)
])

const EXTENSION_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  geojson: "application/geo+json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  tab: "text/tab-separated-values",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  txt: "text/plain",
  log: "text/plain",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  css: "text/css",
  sh: "application/x-sh",
  sql: "application/sql",
}

/** 代码文件扩展名 → 内部 text/x-<lang>(仅路由用,不外泄为真 MIME 结论)。 */
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "scss", "less", "vue", "svelte", "zig", "lua",
  "diff", "patch", "ini", "conf", "mdx",
])

export function mimeForName(name: string): string | null {
  const ext = extensionOf(name)
  if (!ext) return null
  if (EXTENSION_MIME[ext]) return EXTENSION_MIME[ext]
  if (CODE_EXTS.has(ext)) return `text/x-${ext}`
  return null
}

/** Workbench uses this pure predicate to decide whether it must read bytes before routing. */
export function shouldDetectOoxml(input: Pick<RouteInput, "name" | "claimedMime" | "detectedMime">): boolean {
  return shouldGateOoxml(input)
}

// ---------------------------------------------------------------------------
// 内置注册表(REQ-095 交付 2 的本切片:markdown / text / code / json / csv / image / pdf +
// html 占位 + fallback;audio/video/Office 归 fallback,诚实外部打开 —— 见 workbench 报告)
// ---------------------------------------------------------------------------

const is = (mime: string | null, ...values: string[]) => mime !== null && values.includes(mime)

export const RENDERER_REGISTRY: readonly RendererRegistration[] = [
  { id: "markdown", priority: 90, canRender: (c) => is(c.mime, "text/markdown", "text/x-markdown") },
  { id: "json", priority: 80, canRender: (c) => is(c.mime, "application/json", "text/json") || (c.mime?.endsWith("+json") ?? false) },
  { id: "csv", priority: 80, canRender: (c) => is(c.mime, "text/csv", "application/csv", "text/tab-separated-values") },
  { id: "image", priority: 70, canRender: (c) => c.mime !== null && INLINE_IMAGE_MIMES.has(c.mime) },
  { id: "pdf", priority: 70, canRender: (c) => is(c.mime, "application/pdf") },
  { id: "html", priority: 70, canRender: (c) => is(c.mime, "text/html", "application/xhtml+xml") },
  {
    id: "code",
    priority: 40,
    canRender: (c) => c.mime !== null && (CODE_MIMES.has(c.mime) || c.mime.startsWith("text/x-") || c.mime.endsWith("+xml")),
  },
  { id: "text", priority: 10, canRender: (c) => c.mime !== null && c.mime.startsWith("text/") },
  // fallback 不在匹配序列里参与 canRender —— 它是无候选命中时的确定终点。
] as const

function pickRenderer(candidate: RouteCandidate): RendererId | null {
  const hits = RENDERER_REGISTRY.filter((r) => r.canRender(candidate))
  if (hits.length === 0) return null
  hits.sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.id < b.id ? -1 : 1))
  return hits[0].id
}

// ---------------------------------------------------------------------------
// 确定性路由
// ---------------------------------------------------------------------------

export function routeArtifact(input: RouteInput): RouteDecision {
  const detected = normalizeMime(input.detectedMime)
  const claimed = normalizeMime(input.claimedMime)
  const extMime = mimeForName(input.name)
  const warnings: string[] = []

  // OOXML is the one format family whose privileged consumer is external Office. The local byte
  // detector is the only authority:generic ZIP/Office claims merely require the gate;only a
  // matching non-macro .docx/.xlsx/.pptx claim can receive renderer-side provisional allowance.
  if (shouldDetectOoxml(input)) {
    if (input.ooxml?.status === "detected") {
      const conflicts = ooxmlOpenConflicts(input, input.ooxml)
      if (conflicts.length > 0) {
        warnings.push(`OOXML 结构为 ${input.ooxml.subtype},但与${conflicts.join("、")}冲突 —— 已阻止特权渲染`)
        return {
          rendererId: "fallback",
          effectiveMime: input.ooxml.mime,
          source: "detected",
          reason: `OOXML ${input.ooxml.subtype} 结构与声称不符 → non-privileged fallback`,
          warnings,
          externalOpen: "blocked",
          ooxmlSubtype: input.ooxml.subtype,
        }
      }

      const id = pickRenderer({ mime: input.ooxml.mime, name: input.name })
      return {
        rendererId: id ?? "fallback",
        effectiveMime: input.ooxml.mime,
        source: "detected",
        reason: id
          ? `检测 OOXML ${input.ooxml.subtype} 结构(${input.ooxml.mime})→ ${id}`
          : `检测 OOXML ${input.ooxml.subtype} 结构(${input.ooxml.mime});无内置 renderer → fallback`,
        warnings,
        externalOpen: "allowed",
        ooxmlSubtype: input.ooxml.subtype,
      }
    }

    const failure = input.ooxml ? input.ooxml.reason : "结构检测尚未完成"
    warnings.push(`OOXML/ZIP 结构未获证:${failure} —— 已阻止特权渲染`)
    return {
      rendererId: "fallback",
      effectiveMime: detected ?? claimed ?? extMime,
      source: detected ? "detected" : claimed ? "claimed" : extensionOf(input.name) ? "extension" : "none",
      reason: `OOXML/ZIP 结构未获证 → non-privileged fallback`,
      warnings,
      externalOpen: "blocked",
    }
  }

  if (detected && claimed && detected !== claimed)
    warnings.push(`MIME 冲突:声明 ${claimed},检测 ${detected} —— 按检测结果路由`)

  // ① detected 权威:存在即只按它路由(映射不到 → 直接 fallback,不退回声明/扩展名)。
  if (detected) {
    const id = pickRenderer({ mime: detected, name: input.name })
    if (id)
      return { rendererId: id, effectiveMime: detected, source: "detected", reason: `检测 MIME ${detected} → ${id}`, warnings, externalOpen: "allowed" }
    return {
      rendererId: "fallback",
      effectiveMime: detected,
      source: "detected",
      reason: `检测 MIME ${detected} 无内置 renderer → fallback`,
      warnings,
      externalOpen: "allowed",
    }
  }

  // ② claimed(产出端按扩展名声明)。与文件扩展名指向不同 renderer 时诚实提示(仍按声明路由)。
  if (claimed) {
    const id = pickRenderer({ mime: claimed, name: input.name })
    if (extMime && normalizeMime(extMime) !== claimed) {
      const extId = pickRenderer({ mime: extMime, name: input.name })
      if (extId !== id) warnings.push(`扩展名(${extMime})与声明 MIME(${claimed})不一致,且无 magic 检测结果`)
    }
    if (id)
      return { rendererId: id, effectiveMime: claimed, source: "claimed", reason: `声明 MIME ${claimed} → ${id}`, warnings, externalOpen: "allowed" }
    // claimed 无映射 → 扩展名兜底(与 claimed 同保真度,都是名字派生)。
    if (extMime) {
      const extId = pickRenderer({ mime: extMime, name: input.name })
      if (extId)
        return {
          rendererId: extId,
          effectiveMime: extMime,
          source: "extension",
          reason: `声明 MIME ${claimed} 无内置 renderer;按扩展名 ${extMime} → ${extId}`,
          warnings,
          externalOpen: "allowed",
        }
    }
    return {
      rendererId: "fallback",
      effectiveMime: claimed,
      source: "claimed",
      reason: `声明 MIME ${claimed} 无内置 renderer → fallback`,
      warnings,
      externalOpen: "allowed",
    }
  }

  // ③ 扩展名。
  if (extMime) {
    const id = pickRenderer({ mime: extMime, name: input.name })
    if (id)
      return { rendererId: id, effectiveMime: extMime, source: "extension", reason: `扩展名 MIME ${extMime} → ${id}`, warnings, externalOpen: "allowed" }
  }

  // ④ 确定 fallback。
  return { rendererId: "fallback", effectiveMime: null, source: "none", reason: "无 MIME/扩展名线索 → fallback", warnings, externalOpen: "allowed" }
}
