// REQ-123 (#1174):the text-layer DOCTYPE/ENTITY/CDATA gate and the 4 MiB parse cap.
// The gate is text-layer on purpose so bun (happy-dom) covers it faithfully;DOMParser
// *entity behaviour* differs between happy-dom and Chromium and is asserted in the t4
// real-Chromium matrix, not here (baseline ① 运行时陷阱).
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"

GlobalRegistrator.register()
const { OOXML_CONTENT_LIMITS, parseOoxmlContentPart } = await import("./ooxml-content")

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const WORKSHEET_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello-part</t></is></c></row></sheetData>` +
  `</worksheet>`

const utf8 = (source: string) => new TextEncoder().encode(source)

function utf16(source: string, endian: "le" | "be"): Uint8Array {
  const output = new Uint8Array(2 + source.length * 2)
  output[0] = endian === "be" ? 0xfe : 0xff
  output[1] = endian === "be" ? 0xff : 0xfe
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    output[2 + index * 2] = endian === "be" ? code >> 8 : code & 0xff
    output[3 + index * 2] = endian === "be" ? code & 0xff : code >> 8
  }
  return output
}

describe("parseOoxmlContentPart:decode + scan + parse in one gate", () => {
  test("well-formed UTF-8 part parses and yields its text nodes", () => {
    const result = parseOoxmlContentPart(utf8(WORKSHEET_XML))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.getElementsByTagName("t")[0]?.textContent).toBe("hello-part")
  })

  for (const endian of ["le", "be"] as const) {
    test(`well-formed UTF-16${endian.toUpperCase()} part decodes and parses`, () => {
      const result = parseOoxmlContentPart(utf16(WORKSHEET_XML.replace("UTF-8", "UTF-16"), endian))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.document.getElementsByTagName("t")[0]?.textContent).toBe("hello-part")
    })
  }

  const forbidden: Array<[string, string]> = [
    ["DOCTYPE", `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "b">]><r>&a;</r>`],
    ["lowercase doctype", `<?xml version="1.0"?><!doctype r><r/>`],
    ["spaced DOCTYPE", `<?xml version="1.0"?><! DOCTYPE r><r/>`],
    ["bare ENTITY", `<r><!ENTITY x "y"></r>`],
    ["CDATA", `<r><![CDATA[measured 0/28 across the 7 real samples — rejected]]></r>`],
  ]
  for (const [name, source] of forbidden) {
    test(`${name} is rejected at the text layer`, () => {
      const result = parseOoxmlContentPart(utf8(source))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("CONTENT_PART_FORBIDDEN_MARKUP")
    })
  }

  for (const endian of ["le", "be"] as const) {
    test(`M1:UTF-16${endian.toUpperCase()}-encoded DOCTYPE is caught on the decoded string`, () => {
      const source = `<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE r [<!ENTITY a "b">]><r>&a;</r>`
      const bytes = utf16(source, endian)
      // The threat made concrete:a byte-layer UTF-8 scan of these bytes has ZERO hits …
      const byteLayerView = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
      expect(/<!\s*(?:DOCTYPE|ENTITY)/i.test(byteLayerView)).toBe(false)
      // … while the real gate, scanning the decoded string, rejects.
      const result = parseOoxmlContentPart(bytes)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("CONTENT_PART_FORBIDDEN_MARKUP")
    })
  }

  test("exactly maxPartParseBytes passes the size gate", () => {
    const open = "<r>"
    const close = "</r>"
    const padding = OOXML_CONTENT_LIMITS.maxPartParseBytes - open.length - close.length
    const result = parseOoxmlContentPart(utf8(open + "x".repeat(padding) + close))
    expect(result.ok).toBe(true)
  })

  test("maxPartParseBytes + 1 is rejected before decode", () => {
    const result = parseOoxmlContentPart(new Uint8Array(OOXML_CONTENT_LIMITS.maxPartParseBytes + 1))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("CONTENT_PART_PARSE_LIMIT")
  })

  test("invalid UTF-8 is rejected as encoding, not parsed", () => {
    const result = parseOoxmlContentPart(new Uint8Array([0x3c, 0x61, 0x2f, 0x3e, 0xc3]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("CONTENT_PART_INVALID_ENCODING")
  })

  test("odd-length UTF-16 (truncated code unit) is rejected as encoding", () => {
    const result = parseOoxmlContentPart(new Uint8Array([0xff, 0xfe, 0x3c]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("CONTENT_PART_INVALID_ENCODING")
  })

  test("malformed XML is rejected as invalid XML (parsererror detection works)", () => {
    const result = parseOoxmlContentPart(utf8("<a><b></a>"))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("CONTENT_PART_INVALID_XML")
  })
})
