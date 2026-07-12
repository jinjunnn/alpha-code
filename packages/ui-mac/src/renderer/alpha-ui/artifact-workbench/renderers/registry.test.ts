// REQ-095(#187)registry 路由单测:确定性、优先级(detected > claimed > extension > fallback)、
// 冲突诚实(warning chip)、恶意 fixture(html 冒充 image、带脚本 SVG、检测结论权威不回退)。
import { describe, expect, test } from "bun:test"
import { extensionOf, mimeForName, normalizeMime, routeArtifact, RENDERER_REGISTRY } from "./registry"

describe("normalizeMime / extension helpers", () => {
  test("小写 + 去参数", () => {
    expect(normalizeMime("Text/CSV; charset=utf-8")).toBe("text/csv")
  })
  test("非法形态 → null", () => {
    expect(normalizeMime("not a mime")).toBeNull()
    expect(normalizeMime("")).toBeNull()
    expect(normalizeMime(undefined)).toBeNull()
  })
  test("extensionOf:点文件/无扩展 → null", () => {
    expect(extensionOf("report.PDF")).toBe("pdf")
    expect(extensionOf(".gitignore")).toBeNull()
    expect(extensionOf("Makefile")).toBeNull()
    expect(extensionOf("archive.tar.gz")).toBe("gz")
  })
  test("mimeForName:代码扩展名 → text/x-<ext>", () => {
    expect(mimeForName("main.ts")).toBe("text/x-ts")
    expect(mimeForName("notes.md")).toBe("text/markdown")
    expect(mimeForName("unknown.zzz")).toBeNull()
  })
})

describe("路由优先级", () => {
  test("① detectedMime 优先于 claimed 与扩展名", () => {
    const d = routeArtifact({ name: "data.txt", claimedMime: "text/plain", detectedMime: "text/csv" })
    expect(d.rendererId).toBe("csv")
    expect(d.source).toBe("detected")
    expect(d.warnings.length).toBe(1) // 冲突诚实
  })
  test("② 无 detected → claimed", () => {
    const d = routeArtifact({ name: "blob.bin", claimedMime: "application/json" })
    expect(d.rendererId).toBe("json")
    expect(d.source).toBe("claimed")
  })
  test("③ 无任何 MIME → 扩展名", () => {
    const d = routeArtifact({ name: "report.md" })
    expect(d.rendererId).toBe("markdown")
    expect(d.source).toBe("extension")
  })
  test("④ 无线索 → fallback(确定终点)", () => {
    const d = routeArtifact({ name: "artifact-x" })
    expect(d.rendererId).toBe("fallback")
    expect(d.source).toBe("none")
  })
  test("detected 存在但无映射 → 直接 fallback,绝不回退 claimed/扩展名", () => {
    // 检测说是 zip 的东西,不因声明 text/plain 或 .txt 扩展名就按文本打开
    const d = routeArtifact({ name: "notes.txt", claimedMime: "text/plain", detectedMime: "application/zip" })
    expect(d.rendererId).toBe("fallback")
    expect(d.source).toBe("detected")
    expect(d.effectiveMime).toBe("application/zip")
  })
  test("claimed 无映射 → 扩展名兜底", () => {
    const d = routeArtifact({ name: "notes.md", claimedMime: "application/x-unknown-thing" })
    expect(d.rendererId).toBe("markdown")
    expect(d.source).toBe("extension")
  })
})

describe("确定性", () => {
  test("同输入两次路由结果逐字段一致", () => {
    const input = { name: "a.csv", claimedMime: "text/csv", detectedMime: "text/csv" }
    expect(routeArtifact(input)).toEqual(routeArtifact(input))
  })
  test("注册表内 priority/id 排序稳定(无同分歧义)", () => {
    const seen = new Set<string>()
    for (const r of RENDERER_REGISTRY) {
      const k = `${r.priority}:${r.id}`
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })
  test("MIME 冲突但同 renderer 仍给 warning(诚实并列)", () => {
    const d = routeArtifact({ name: "a.md", claimedMime: "text/markdown", detectedMime: "text/x-markdown" })
    expect(d.rendererId).toBe("markdown")
    expect(d.warnings.length).toBe(1)
  })
})

describe("恶意 fixture(REQ-095 恶意矩阵)", () => {
  test("HTML 冒充 image/*:检测为 text/html → html 卡片(不进 image renderer)", () => {
    const d = routeArtifact({ name: "totally-a.png", claimedMime: "image/png", detectedMime: "text/html" })
    expect(d.rendererId).toBe("html")
    expect(d.source).toBe("detected")
    expect(d.warnings.some((w) => w.includes("image/png"))).toBe(true)
  })
  test("无检测时 HTML 冒充 image/*:按声明进 image(<img> 被动解码,最多解码失败),但产扩展名不符 warning", () => {
    const d = routeArtifact({ name: "evil.html", claimedMime: "image/png" })
    expect(d.rendererId).toBe("image")
    expect(d.source).toBe("claimed")
    expect(d.warnings.length).toBe(1)
  })
  test("带脚本 SVG:无论声明/检测/扩展名,一律路由 code(源码只读),绝不 image-inline", () => {
    for (const input of [
      { name: "logo.svg" },
      { name: "logo.svg", claimedMime: "image/svg+xml" },
      { name: "x.bin", detectedMime: "image/svg+xml" },
    ]) {
      const d = routeArtifact(input)
      expect(d.rendererId).toBe("code")
    }
  })
  test("text/html 的所有来源路径都终结于 html 卡片(REQ-096 接线点),永不 text/code", () => {
    expect(routeArtifact({ name: "a", detectedMime: "text/html" }).rendererId).toBe("html")
    expect(routeArtifact({ name: "a", claimedMime: "text/html" }).rendererId).toBe("html")
    expect(routeArtifact({ name: "a.html" }).rendererId).toBe("html")
    expect(routeArtifact({ name: "a.xhtml" }).rendererId).toBe("html")
  })
  test("PDF → pdf 卡片(无伪造内置查看器路由)", () => {
    expect(routeArtifact({ name: "r.pdf" }).rendererId).toBe("pdf")
    expect(routeArtifact({ name: "r", detectedMime: "application/pdf" }).rendererId).toBe("pdf")
  })
  test("音视频/Office 无内置 renderer → fallback(诚实外部打开)", () => {
    expect(routeArtifact({ name: "a.mp4", claimedMime: "video/mp4" }).rendererId).toBe("fallback")
    expect(
      routeArtifact({
        name: "a.docx",
        claimedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }).rendererId,
    ).toBe("fallback")
  })
})

describe("常规格式覆盖", () => {
  const cases: Array<[string, string | undefined, string]> = [
    ["a.md", "text/markdown", "markdown"],
    ["a.json", "application/json", "json"],
    ["a.geojson", "application/geo+json", "json"],
    ["a.csv", "text/csv", "csv"],
    ["a.tsv", "text/tab-separated-values", "csv"],
    ["a.png", "image/png", "image"],
    ["a.webp", "image/webp", "image"],
    ["a.py", undefined, "code"],
    ["a.yaml", undefined, "code"],
    ["a.log", "text/plain", "text"],
    ["a.txt", undefined, "text"],
  ]
  for (const [name, claimed, expected] of cases) {
    test(`${name}${claimed ? ` (${claimed})` : ""} → ${expected}`, () => {
      expect(routeArtifact({ name, claimedMime: claimed }).rendererId).toBe(expected)
    })
  }
})
