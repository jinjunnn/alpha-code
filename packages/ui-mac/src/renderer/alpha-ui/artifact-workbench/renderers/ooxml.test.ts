import { describe, expect, test } from "bun:test"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import {
  OOXML_LIMITS,
  OOXML_SUBTYPES,
  detectOoxmlContainer,
  type OoxmlSubtype,
} from "./ooxml"

const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"

describe("detectOoxmlContainer:real minimal OOXML fixtures", () => {
  for (const subtype of ["xlsx", "docx", "pptx"] as const) {
    test(`${subtype} central directory + declared main part`, async () => {
      const result = await detectOoxmlContainer(await makeOoxmlFixture(subtype))
      expect(result.status).toBe("detected")
      if (result.status !== "detected") return
      expect(result.subtype).toBe(subtype)
      expect(result.mime).toBe(OOXML_SUBTYPES[subtype].mime)
      expect(result.entryCount).toBe(3)
    })
  }
})

describe("detectOoxmlContainer:fail-closed fixtures", () => {
  test("renaming bytes does not affect subtype detection", async () => {
    const renamedDocxBytes = await makeOoxmlFixture("xlsx")
    const result = await detectOoxmlContainer(renamedDocxBytes)
    expect(result.status).toBe("detected")
    if (result.status === "detected") expect(result.subtype).toBe("xlsx")
  })

  test("fake [Content_Types].xml declaration without its actual part is rejected", async () => {
    const result = await detectOoxmlContainer(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("xlsx")],
        ["_rels/.rels", relationshipsXml("xl/workbook.xml")],
        ["word/document.xml", "<document/>"]
      ]),
    )
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toContain("declared main part")
  })

  test("malformed ZIP is rejected without throwing", async () => {
    const result = await detectOoxmlContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toContain("malformed ZIP")
  })

  test("entry-count bomb style archive trips the production cap", async () => {
    const extras = Array.from(
      { length: OOXML_LIMITS.maxEntries - 2 },
      (_, index) => [`xl/worksheets/sheet-${index}.xml`, ""] as const,
    )
    const result = await detectOoxmlContainer(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("xlsx")],
        ["_rels/.rels", relationshipsXml("xl/workbook.xml")],
        ["xl/workbook.xml", mainPartXml("xlsx")],
        ...extras,
      ]),
    )
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toContain("entry limit")
  })

  test("forged central-directory size trips the production uncompressed-byte cap before inflate", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const forged = patchCentralUncompressedSize(
      fixture,
      "xl/workbook.xml",
      OOXML_LIMITS.maxUncompressedBytes + 1,
    )
    const result = await detectOoxmlContainer(forged)
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toContain("uncompressed byte limit")
  })

  test("[Content_Types].xml has its own inflate cap", async () => {
    const oversized = contentTypesXml("docx").replace("</Types>", `<!--${"x".repeat(OOXML_LIMITS.maxContentTypesBytes)}--></Types>`)
    const result = await detectOoxmlContainer(
      await makeZip([
        ["[Content_Types].xml", oversized],
        ["_rels/.rels", relationshipsXml("word/document.xml")],
        ["word/document.xml", mainPartXml("docx")],
      ]),
    )
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toContain("Content_Types")
  })

  test("path traversal entry rejects the whole container", async () => {
    const result = await detectOoxmlContainer(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("pptx")],
        ["_rels/.rels", relationshipsXml("ppt/presentation.xml")],
        ["ppt/presentation.xml", mainPartXml("pptx")],
        ["../escape.xml", "owned"],
      ]),
    )
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toContain("unsafe ZIP entry path")
  })
})

async function makeOoxmlFixture(subtype: OoxmlSubtype) {
  return makeZip([
    ["[Content_Types].xml", contentTypesXml(subtype)],
    ["_rels/.rels", relationshipsXml(OOXML_SUBTYPES[subtype].mainPart)],
    [OOXML_SUBTYPES[subtype].mainPart, mainPartXml(subtype)],
  ])
}

async function makeZip(entries: ReadonlyArray<readonly [string, string]>) {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output, { useWebWorkers: false })
  for (const entry of entries) await writer.add(entry[0], new TextReader(entry[1]))
  await writer.close()
  return output.getData()
}

function contentTypesXml(subtype: OoxmlSubtype) {
  const facts = OOXML_SUBTYPES[subtype]
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">`,
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    `<Override PartName="/${facts.mainPart}" ContentType="${facts.mainContentType}"/>`,
    `</Types>`,
  ].join("")
}

function relationshipsXml(target: string) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>`,
    `</Relationships>`,
  ].join("")
}

function mainPartXml(subtype: OoxmlSubtype) {
  if (subtype === "docx")
    return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`
  if (subtype === "xlsx")
    return `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>`
  return `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>`
}

function patchCentralUncompressedSize(bytes: Uint8Array, filename: string, size: number) {
  const patched = bytes.slice()
  const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength)
  const decoder = new TextDecoder()
  for (let offset = 0; offset + 46 <= patched.byteLength; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = decoder.decode(patched.subarray(offset + 46, offset + 46 + nameLength))
    if (name === filename) {
      view.setUint32(offset + 24, size, true)
      return patched
    }
    offset += 45 + nameLength + extraLength + commentLength
  }
  throw new Error(`central-directory entry not found:${filename}`)
}
