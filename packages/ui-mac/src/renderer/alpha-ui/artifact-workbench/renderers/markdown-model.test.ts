// REQ-095(#187)markdown 恶意 corpus:script / SVG / URL / CSS / 事件属性 / mutation-XSS 变体
// (issue #187 审计追加项)。断言口径 = 构造性安全:模型里不存在任何可执行/可注入节点 ——
// raw HTML 只会以 rawhtml/text 字面出现;链接/图片 URL 经白名单;远程图默认不加载。
import { describe, expect, test } from "bun:test"
import {
  imagePolicy,
  parseMarkdownModel,
  safeLinkHref,
  type MdBlock,
  type MdInline,
} from "./markdown-model"

function collectInlines(blocks: MdBlock[]): MdInline[] {
  const out: MdInline[] = []
  const walkInline = (nodes: MdInline[]) => {
    for (const n of nodes) {
      out.push(n)
      if (n.kind === "strong" || n.kind === "em" || n.kind === "del" || n.kind === "link") walkInline(n.children)
    }
  }
  const walkBlocks = (bs: MdBlock[]) => {
    for (const b of bs) {
      switch (b.kind) {
        case "heading":
        case "paragraph":
          walkInline(b.children)
          break
        case "blockquote":
          walkBlocks(b.children)
          break
        case "list":
          b.items.forEach(walkBlocks)
          break
        case "table":
          b.header.forEach(walkInline)
          b.rows.forEach((row) => row.forEach(walkInline))
          break
        default:
          break
      }
    }
  }
  walkBlocks(blocks)
  return out
}

/** 恶意载荷绝不能作为可执行面出现:link.href 只可能是白名单 scheme;image.src 只可能是 https。 */
function assertNoExecutableSurface(blocks: MdBlock[]) {
  for (const n of collectInlines(blocks)) {
    if (n.kind === "link" && n.href !== null) {
      expect(/^(https?:|mailto:)/.test(n.href)).toBe(true)
    }
    if (n.kind === "image" && n.src !== null) {
      expect(n.src.startsWith("https://")).toBe(true)
    }
  }
}

describe("safeLinkHref 白名单", () => {
  test("http/https/mailto 保留", () => {
    expect(safeLinkHref("https://a.example/x")).toBe("https://a.example/x")
    expect(safeLinkHref("mailto:a@b.c")).toBe("mailto:a@b.c")
  })
  test("javascript:/data:/vbscript:/file:/相对路径 → 剥除", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "../secret.md",
      "not a url",
    ]) {
      expect(safeLinkHref(bad)).toBeNull()
    }
  })
})

describe("imagePolicy(追踪图默认不发请求,REQ-095 AC#4)", () => {
  test("https 远程图:保留 URL 但标记 remote(用户显式点击才加载)", () => {
    expect(imagePolicy("https://cdn.example/a.png")).toEqual({ src: "https://cdn.example/a.png", blocked: "remote" })
  })
  test("http/data:/相对 → unsafe,永不可加载", () => {
    for (const bad of ["http://t.example/1px.gif", "data:image/svg+xml,<svg onload=alert(1)/>", "./x.png"]) {
      expect(imagePolicy(bad)).toEqual({ src: null, blocked: "unsafe" })
    }
  })
})

describe("恶意 corpus(#187 审计追加:script/SVG/URL/CSS/事件属性/mXSS)", () => {
  test("script 块 → rawhtml 字面块,原文保留、零解释", () => {
    const m = parseMarkdownModel(`before\n\n<script>fetch("https://evil")</script>\n\nafter`)
    const raw = m.blocks.find((b) => b.kind === "rawhtml")
    expect(raw && raw.kind === "rawhtml" && raw.text.includes("<script>")).toBe(true)
    assertNoExecutableSurface(m.blocks)
  })
  test("内联事件属性 HTML → 字面文本(不成为元素)", () => {
    const m = parseMarkdownModel(`click <img src=x onerror=alert(1)> here`)
    const inlines = collectInlines(m.blocks)
    // 模型里没有任何 image 节点(它是 raw HTML,不是 markdown 图);文本里保留原文
    expect(inlines.some((n) => n.kind === "image")).toBe(false)
    expect(inlines.some((n) => n.kind === "text" && n.text.includes("onerror=alert(1)"))).toBe(true)
  })
  test("SVG 块(含 script/foreignObject)→ rawhtml 字面块", () => {
    const m = parseMarkdownModel(`<svg><script>alert(1)</script><foreignObject></foreignObject></svg>`)
    expect(m.blocks.every((b) => b.kind === "rawhtml" || b.kind === "paragraph")).toBe(true)
    assertNoExecutableSurface(m.blocks)
  })
  test("style/CSS 注入块 → rawhtml 字面块", () => {
    const m = parseMarkdownModel(`<style>body{background:url("https://evil/track")}</style>`)
    const raw = m.blocks.find((b) => b.kind === "rawhtml")
    expect(raw !== undefined).toBe(true)
    assertNoExecutableSurface(m.blocks)
  })
  test("javascript: 链接 → href 剥除,文本保留", () => {
    const m = parseMarkdownModel(`[click me](javascript:alert(1))`)
    const link = collectInlines(m.blocks).find((n) => n.kind === "link")
    expect(link && link.kind === "link" && link.href).toBeNull()
    assertNoExecutableSurface(m.blocks)
  })
  test("data: URL 图片 → src 剥除(unsafe),https 图默认 blocked=remote", () => {
    const m = parseMarkdownModel(`![a](data:image/svg+xml,<svg/>) ![b](https://ok.example/b.png)`)
    const images = collectInlines(m.blocks).filter((n) => n.kind === "image")
    expect(images.length).toBe(2)
    expect(images[0].kind === "image" && images[0].src).toBeNull()
    expect(images[1].kind === "image" && images[1].blocked === "remote").toBe(true)
    assertNoExecutableSurface(m.blocks)
  })
  test("mutation-XSS 变体(截断标签/嵌套引号)不产生任何非字面节点", () => {
    const corpus = [
      `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
      `<math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`,
      `<div><div title="</div><script>alert(2)</script>">`,
    ]
    for (const src of corpus) {
      const m = parseMarkdownModel(src)
      // 全部落在 rawhtml / 段落文本;绝无 link/image 携带危险 URL
      assertNoExecutableSurface(m.blocks)
      const kinds = new Set(m.blocks.map((b) => b.kind))
      for (const k of kinds) expect(["rawhtml", "paragraph"]).toContain(k)
    }
  })
})

describe("正常渲染 + 预算", () => {
  test("标题/列表/表格/代码块结构完整", () => {
    const m = parseMarkdownModel(`# Title\n\n- a\n- b\n\n| h1 | h2 |\n| -- | -- |\n| x | y |\n\n\`\`\`js\nconst a = 1\n\`\`\`\n`)
    expect(m.blocks.some((b) => b.kind === "heading")).toBe(true)
    expect(m.blocks.some((b) => b.kind === "list")).toBe(true)
    expect(m.blocks.some((b) => b.kind === "table")).toBe(true)
    expect(m.blocks.some((b) => b.kind === "code" && b.lang === "js")).toBe(true)
    expect(m.truncated).toBe(false)
  })
  test("块数超限 → 截断 + 诚实标记", () => {
    const src = Array.from({ length: 50 }, (_, i) => `paragraph ${i}`).join("\n\n")
    const m = parseMarkdownModel(src, { maxBlocks: 10 })
    expect(m.truncated).toBe(true)
    expect(m.blocks.length).toBeLessThanOrEqual(10)
  })
})
