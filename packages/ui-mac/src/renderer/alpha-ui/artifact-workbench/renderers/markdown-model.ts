// Markdown 安全模型 — REQ-095(#187)。纯逻辑(marked lexer → 净化中间树),零 DOM、零 innerHTML,
// bun:test 可全测(malicious corpus 见 markdown-model.test.ts)。
//
// 净化策略(比「HTML 净化」更强的构造性安全):渲染端(renderer-views.tsx)只把本模型映射为
// Solid 文本节点/元素 —— **不存在 HTML 字符串注入路径**:
//   · markdown 内嵌的 raw HTML(块级/内联)一律降级为字面文本呈现(escaped by construction),
//     script/style/事件属性/mXSS 变体因此整类不可达;
//   · 链接:仅 http/https/mailto 保留 href(渲染端仍只经系统外部打开);javascript:/data:/file:/
//     vbscript:/相对路径 → href 剥除,只显示文本;
//   · 图片:默认**不发请求**(REQ-095 AC#4 追踪图);https 远程图保留 URL 供用户显式点击加载,
//     其余(data:/http:/相对)标记 unsafe,永不可加载;
//   · 块数上限:超限截断 + 诚实 truncated 标记。

import { marked, type Token, type Tokens } from "marked"

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em" | "del"; children: MdInline[] }
  | { kind: "codespan"; text: string }
  | { kind: "br" }
  | { kind: "link"; href: string | null; children: MdInline[] }
  | { kind: "image"; src: string | null; alt: string; blocked: "remote" | "unsafe" }

export type MdBlock =
  | { kind: "heading"; depth: number; children: MdInline[] }
  | { kind: "paragraph"; children: MdInline[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "blockquote"; children: MdBlock[] }
  | { kind: "list"; ordered: boolean; start: number | null; items: MdBlock[][] }
  | { kind: "table"; header: MdInline[][]; rows: MdInline[][][] }
  | { kind: "hr" }
  | { kind: "rawhtml"; text: string } // 字面呈现(不解析、不执行)

export type MarkdownModel = { blocks: MdBlock[]; truncated: boolean; blockCount: number }

export const MARKDOWN_MAX_BLOCKS = 2000

/** 链接 scheme 白名单:http/https/mailto。其余(含相对路径 —— artifact 预览无导航基准)剥除。 */
export function safeLinkHref(href: unknown): string | null {
  if (typeof href !== "string" || href.length === 0) return null
  try {
    const u = new URL(href)
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? href : null
  } catch {
    return null // 相对/畸形 URL:无基准,不导航
  }
}

/** 图片策略:https 远程图可由用户显式点击加载("remote");其余一律不可加载("unsafe")。 */
export function imagePolicy(src: unknown): { src: string | null; blocked: "remote" | "unsafe" } {
  if (typeof src !== "string" || src.length === 0) return { src: null, blocked: "unsafe" }
  try {
    const u = new URL(src)
    if (u.protocol === "https:") return { src, blocked: "remote" }
  } catch {
    /* relative / malformed */
  }
  return { src: null, blocked: "unsafe" }
}

function inlineChildren(tokens: Token[] | undefined, budget: { left: number }): MdInline[] {
  if (!tokens) return []
  const out: MdInline[] = []
  for (const tok of tokens) {
    if (budget.left <= 0) break
    switch (tok.type) {
      case "text": {
        const t = tok as Tokens.Text
        // inline text 可能自带子 token(例如列表项内的强调);有则递归,无则纯文本。
        if (t.tokens && t.tokens.length > 0) out.push(...inlineChildren(t.tokens, budget))
        else out.push({ kind: "text", text: t.raw })
        break
      }
      case "escape":
        out.push({ kind: "text", text: (tok as Tokens.Escape).text })
        break
      case "strong":
      case "em":
      case "del":
        out.push({ kind: tok.type, children: inlineChildren((tok as Tokens.Strong).tokens, budget) })
        break
      case "codespan":
        out.push({ kind: "codespan", text: (tok as Tokens.Codespan).text })
        break
      case "br":
        out.push({ kind: "br" })
        break
      case "link": {
        const l = tok as Tokens.Link
        out.push({ kind: "link", href: safeLinkHref(l.href), children: inlineChildren(l.tokens, budget) })
        break
      }
      case "image": {
        const img = tok as Tokens.Image
        const policy = imagePolicy(img.href)
        out.push({ kind: "image", src: policy.src, alt: img.text ?? "", blocked: policy.blocked })
        break
      }
      case "html":
        // 内联 HTML → 字面文本(构造性净化:整类脚本/事件/mXSS 不可达)。
        out.push({ kind: "text", text: (tok as Tokens.HTML).raw })
        break
      default:
        // 未知 inline token:诚实降级为原文文本,不丢内容也不解释。
        out.push({ kind: "text", text: (tok as { raw?: string }).raw ?? "" })
    }
  }
  return out
}

function blockOf(tok: Token, budget: { left: number }): MdBlock | null {
  switch (tok.type) {
    case "heading": {
      const h = tok as Tokens.Heading
      return { kind: "heading", depth: h.depth, children: inlineChildren(h.tokens, budget) }
    }
    case "paragraph":
      return { kind: "paragraph", children: inlineChildren((tok as Tokens.Paragraph).tokens, budget) }
    case "code": {
      const c = tok as Tokens.Code
      return { kind: "code", lang: c.lang || null, text: c.text }
    }
    case "blockquote": {
      const q = tok as Tokens.Blockquote
      return { kind: "blockquote", children: blocksOf(q.tokens, budget) }
    }
    case "list": {
      const l = tok as Tokens.List
      const items = l.items.map((item) => blocksOf(item.tokens, budget))
      const start = typeof l.start === "number" ? l.start : null
      return { kind: "list", ordered: l.ordered, start, items }
    }
    case "table": {
      const t = tok as Tokens.Table
      return {
        kind: "table",
        header: t.header.map((cell) => inlineChildren(cell.tokens, budget)),
        rows: t.rows.map((row) => row.map((cell) => inlineChildren(cell.tokens, budget))),
      }
    }
    case "hr":
      return { kind: "hr" }
    case "html":
      // 块级 HTML → 字面文本块(<pre> 呈现原文,零解释)。
      return { kind: "rawhtml", text: (tok as Tokens.HTML).raw }
    case "space":
      return null
    case "text":
      return { kind: "paragraph", children: inlineChildren((tok as Tokens.Text).tokens ?? [tok], budget) }
    default:
      return { kind: "paragraph", children: [{ kind: "text", text: (tok as { raw?: string }).raw ?? "" }] }
  }
}

function blocksOf(tokens: Token[], budget: { left: number }): MdBlock[] {
  const out: MdBlock[] = []
  for (const tok of tokens) {
    if (budget.left <= 0) break
    const block = blockOf(tok, budget)
    if (block) {
      out.push(block)
      budget.left -= 1
    }
  }
  return out
}

export function parseMarkdownModel(source: string, opts?: { maxBlocks?: number }): MarkdownModel {
  const maxBlocks = Math.max(1, opts?.maxBlocks ?? MARKDOWN_MAX_BLOCKS)
  let tokens: Token[]
  try {
    tokens = marked.lexer(source, { gfm: true, breaks: false })
  } catch {
    // lexer 失败:诚实降级为单块纯文本(绝不半解析)。
    return { blocks: [{ kind: "code", lang: null, text: source }], truncated: false, blockCount: 1 }
  }
  const budget = { left: maxBlocks }
  const blocks = blocksOf(tokens, budget)
  return { blocks, truncated: budget.left <= 0, blockCount: blocks.length }
}
