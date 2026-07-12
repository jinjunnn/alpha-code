// REQ-096(#188):跨运行时契约单测 —— canPreviewHtml 的诚实裁决(detectedMime 优先)与
// 静态 CSP 文本的关键指令存在性(host 侧对每个响应注入,主 renderer CSP 不因预览放宽)。

import { describe, expect, test } from "bun:test"
import { canPreviewHtml, HTML_PREVIEW_CSP, HTML_PREVIEW_SCHEME } from "./html-preview"

describe("canPreviewHtml — detectedMime 是唯一裁决,缺席才看 claimed/扩展名", () => {
  test("扩展名 .html/.htm(无任何 mime)→ 可预览", () => {
    expect(canPreviewHtml({ name: "report.html" })).toBe(true)
    expect(canPreviewHtml({ name: "REPORT.HTM" })).toBe(true)
  })

  test("claimedMime text/html(名字无扩展)→ 可预览", () => {
    expect(canPreviewHtml({ name: "artifact-0", claimedMime: "text/html" })).toBe(true)
  })

  test("detectedMime 带参数形态(text/html; charset=utf-8)→ 可预览", () => {
    expect(canPreviewHtml({ name: "x.bin", detectedMime: "text/html; charset=utf-8" })).toBe(true)
  })

  test("检测与声明冲突:claimed html 但 detected text/plain → 拒绝(检测赢)", () => {
    expect(canPreviewHtml({ name: "evil.html", claimedMime: "text/html", detectedMime: "text/plain" })).toBe(false)
  })

  test("本地检测(manifest entry.local)优先于 descriptor 携带的产出端检测", () => {
    expect(canPreviewHtml({ name: "a.html", detectedMime: "text/html" }, "application/pdf")).toBe(false)
    expect(canPreviewHtml({ name: "a.bin", detectedMime: "text/plain" }, "text/html")).toBe(true)
  })

  test("非 HTML(pdf/png/无线索)→ 拒绝", () => {
    expect(canPreviewHtml({ name: "report.pdf" })).toBe(false)
    expect(canPreviewHtml({ name: "chart.png", claimedMime: "image/png" })).toBe(false)
    expect(canPreviewHtml({ name: "artifact-1" })).toBe(false)
  })

  test("mime 前缀伪装(text/html-evil)不匹配", () => {
    expect(canPreviewHtml({ name: "x", claimedMime: "text/html-evil" })).toBe(false)
  })
})

describe("HTML_PREVIEW_CSP — REQ-096 交付 3 的静态指令面", () => {
  test("全 none 基线 + 受控 style/img/font 放行", () => {
    for (const directive of [
      "default-src 'none'",
      "script-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "style-src 'unsafe-inline'",
      `img-src data: ${HTML_PREVIEW_SCHEME}:`,
      `font-src data: ${HTML_PREVIEW_SCHEME}:`,
      "sandbox",
    ]) {
      expect(HTML_PREVIEW_CSP).toContain(directive)
    }
  })

  test("绝不含任何 http/https 放行", () => {
    expect(HTML_PREVIEW_CSP).not.toMatch(/https?:/)
  })
})
