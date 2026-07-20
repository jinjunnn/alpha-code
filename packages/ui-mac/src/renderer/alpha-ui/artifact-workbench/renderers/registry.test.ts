// REQ-095(#187)registry 路由单测:确定性、优先级(detected > claimed > extension > fallback)、
// 冲突诚实(warning chip)、恶意 fixture(html 冒充 image、带脚本 SVG、检测结论权威不回退)。
import { describe, expect, test } from "bun:test"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { NON_OOXML_OPEN_GATE_REGRESSION_FORMATS } from "../../../../shared/ooxml-gate.test-support"
import {
  OFFICE_OPEN_GATE_FORMATS,
  OOXML_SUBTYPES,
  detectOoxmlContainer,
  type OoxmlDetection,
} from "./ooxml"
import { extensionOf, mimeForName, normalizeMime, routeArtifact, RENDERER_REGISTRY, shouldDetectOoxml } from "./registry"

const DETECTED_XLSX: OoxmlDetection = {
  status: "detected",
  subtype: "xlsx",
  mime: OOXML_SUBTYPES.xlsx.mime,
  entryCount: 3,
  uncompressedBytes: 1024,
}

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
    const d = routeArtifact({ name: "data.md", claimedMime: "text/markdown", detectedMime: "application/json" })
    expect(d.rendererId).toBe("json")
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

describe("OOXML 结构闸(REQ-093 #281)", () => {
  test("只有 OOXML 家族扩展名/MIME 要求结构检测", () => {
    expect(shouldDetectOoxml({ name: "book.xlsx" })).toBe(true)
    expect(shouldDetectOoxml({ name: "book", claimedMime: OOXML_SUBTYPES.xlsx.mime })).toBe(true)
    expect(shouldDetectOoxml({ name: "book.bin", detectedMime: "application/zip" })).toBe(false)
    expect(shouldDetectOoxml({ name: "notes.md", detectedMime: "text/markdown" })).toBe(false)
  })

  test("真实 xlsx 结构 + 一致声称:仍走既有 fallback,但允许外部 Office 打开", () => {
    const decision = routeArtifact({
      name: "book.xlsx",
      claimedMime: OOXML_SUBTYPES.xlsx.mime,
      detectedMime: "application/zip",
      ooxml: DETECTED_XLSX,
    })
    expect(decision.rendererId).toBe("fallback")
    expect(decision.effectiveMime).toBe(OOXML_SUBTYPES.xlsx.mime)
    expect(decision.ooxmlSubtype).toBe("xlsx")
    expect(decision.externalOpen).toBe("allowed")
  })

  test("真实 bytes → detector → 冲突扩展名 registry 生产链 fail-closed", async () => {
    const detection = await detectOoxmlContainer(await makeXlsxFixture())
    expect(detection.status).toBe("detected")
    const decision = routeArtifact({
      name: "renamed.docx",
      claimedMime: OOXML_SUBTYPES.docx.mime,
      detectedMime: "application/zip",
      ooxml: detection,
    })
    expect(decision.rendererId).toBe("fallback")
    expect(decision.ooxmlSubtype).toBe("xlsx")
    expect(decision.externalOpen).toBe("blocked")
    expect(decision.warnings).toEqual([
      "OOXML 结构为 xlsx,但与extension:docx、claimed-mime:application/vnd.openxmlformats-officedocument.wordprocessingml.document冲突 —— 已阻止特权渲染",
    ])
  })

  test("结构与非中性 claimed/detected MIME 任一冲突都阻止特权渲染", () => {
    for (const input of [
      { name: "book.xlsx", claimedMime: "application/pdf", detectedMime: "application/zip" },
      { name: "book.xlsx", claimedMime: OOXML_SUBTYPES.xlsx.mime, detectedMime: "text/html" },
    ]) {
      expect(routeArtifact({ ...input, ooxml: DETECTED_XLSX }).externalOpen).toBe("blocked")
    }
  })

  test("域内检测中/非 OOXML/畸形或超限一律 fail-closed,普通 ZIP 不受影响", () => {
    const input = { name: "book.xlsx", claimedMime: OOXML_SUBTYPES.xlsx.mime }
    expect(routeArtifact(input).externalOpen).toBe("blocked")
    expect(routeArtifact({ ...input, ooxml: { status: "not-ooxml", code: "CONTENT_TYPES_MISSING", reason: "CONTENT_TYPES_MISSING" } }).externalOpen).toBe("blocked")
    expect(routeArtifact({ ...input, ooxml: { status: "rejected", code: "ZIP_ENTRY_LIMIT", reason: "ZIP_ENTRY_LIMIT" } }).externalOpen).toBe("blocked")
    expect(routeArtifact({ name: "archive.zip", detectedMime: "application/zip" }).externalOpen).toBe("allowed")
    expect(routeArtifact({ name: "archive.bin" }).externalOpen).toBe("allowed")
  })

  test("移出项恢复外部打开且保留既有应用内 renderer", () => {
    for (const [name, rendererId] of [
      ["page.html", "html"],
      ["page.xhtml", "html"],
      ["data.xml", "code"],
      ["notes.txt", "text"],
      ["table.tsv", "csv"],
    ] as const) {
      const decision = routeArtifact({ name })
      expect(decision.rendererId).toBe(rendererId)
      expect(decision.externalOpen).toBe("allowed")
    }
  })

  test("全部 63 个移出项的扩展名及 MIME 保持闸前外部打开策略", () => {
    expect(NON_OOXML_OPEN_GATE_REGRESSION_FORMATS).toHaveLength(63)
    expect(new Set(NON_OOXML_OPEN_GATE_REGRESSION_FORMATS.map((format) => format.extension)).size).toBe(63)
    for (const format of NON_OOXML_OPEN_GATE_REGRESSION_FORMATS) {
      expect(shouldDetectOoxml({ name: `artifact.${format.extension}` })).toBe(false)
      expect(routeArtifact({ name: `artifact.${format.extension}` }).externalOpen).toBe("allowed")
      for (const claimedMime of format.mimes) {
        expect(shouldDetectOoxml({ name: "artifact", claimedMime })).toBe(false)
        expect(routeArtifact({ name: "artifact", claimedMime }).externalOpen).toBe("allowed")
      }
    }
  })

  test("authoritative table is normalized,non-empty,and extension-unique", () => {
    const extensions = OFFICE_OPEN_GATE_FORMATS.map((format) => format.extension)
    expect(extensions).toHaveLength(20)
    expect(new Set(extensions).size).toBe(extensions.length)
    expect(new Set(OFFICE_OPEN_GATE_FORMATS.flatMap((format) => format.mimes)).size).toBe(20)
    for (const format of OFFICE_OPEN_GATE_FORMATS) {
      expect(format.extension).toBe(format.extension.toLowerCase())
      expect(format.mimes.length).toBeGreaterThan(0)
      expect(new Set(format.mimes).size).toBe(format.mimes.length)
      for (const mime of format.mimes) expect(normalizeMime(mime)).toBe(mime.toLowerCase())
    }
  })

  for (const format of OFFICE_OPEN_GATE_FORMATS) {
    test(`${format.family} .${format.extension} ${format.kind}:extension × missing/neutral/claimed MIME stays gated`, () => {
      for (const variant of [
        { label: "missing" },
        { label: "neutral", claimedMime: "application/octet-stream" },
        ...format.mimes.map((claimedMime, index) => ({ label: `claimed-${index}`, claimedMime })),
      ]) {
        const input = { name: `artifact-${variant.label}.${format.extension}`, ...(variant.claimedMime ? { claimedMime: variant.claimedMime } : {}) }
        expect(shouldDetectOoxml(input)).toBe(true)
        expect(routeArtifact(input).externalOpen).toBe("blocked")
      }
      for (const claimedMime of format.mimes) {
        expect(shouldDetectOoxml({ name: "artifact", claimedMime })).toBe(true)
        expect(routeArtifact({ name: "artifact", claimedMime }).externalOpen).toBe("blocked")
      }
      if (!Object.prototype.hasOwnProperty.call(OOXML_SUBTYPES, format.extension))
        expect(routeArtifact({ name: `artifact.${format.extension}`, ooxml: DETECTED_XLSX }).externalOpen)
          .toBe("blocked")
    })
  }
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
    expect(d.externalOpen).toBe("allowed")
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
    for (const input of [
      { name: "a", detectedMime: "text/html" },
      { name: "a", claimedMime: "text/html" },
      { name: "a.html" },
      { name: "a.xhtml" },
    ]) {
      const decision = routeArtifact(input)
      expect(decision.rendererId).toBe("html")
      expect(decision.externalOpen).toBe("allowed")
    }
  })
  test("PDF → pdf 卡片(无伪造内置查看器路由)", () => {
    for (const input of [{ name: "r.pdf" }, { name: "r", detectedMime: "application/pdf" }]) {
      const decision = routeArtifact(input)
      expect(decision.rendererId).toBe("pdf")
      expect(decision.externalOpen).toBe("allowed")
    }
  })
  test("音视频可 fallback;Office 在检测前必须保持 blocked fallback", () => {
    const media = routeArtifact({ name: "a.mp4", claimedMime: "video/mp4" })
    expect(media.rendererId).toBe("fallback")
    expect(media.externalOpen).toBe("allowed")
    const office = routeArtifact({
      name: "a.docx",
      claimedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
    expect(office.rendererId).toBe("fallback")
    expect(office.externalOpen).toBe("blocked")
  })
})

async function makeXlsxFixture() {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output, { useWebWorkers: false })
  const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="${OOXML_SUBTYPES.xlsx.mainContentType}"/></Types>`
  const relationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  for (const [name, content] of [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", relationships],
    ["xl/workbook.xml", "<workbook/>"],
  ] as const)
    await writer.add(name, new TextReader(content), { dataDescriptor: false, extendedTimestamp: false })
  await writer.close()
  return output.getData()
}

describe("常规格式覆盖", () => {
  const cases: Array<[string, string | undefined, string]> = [
    ["a.md", "text/markdown", "markdown"],
    ["a.json", "application/json", "json"],
    ["a.geojson", "application/geo+json", "json"],
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
