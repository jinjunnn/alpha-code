import { describe, expect, test } from "bun:test"
import { TextReader, Uint8ArrayWriter, ZipWriter, type ZipWriterAddDataOptions } from "@zip.js/zip.js"
import {
  OOXML_LIMITS,
  OOXML_SUBTYPES,
  detectOoxmlContainer,
  type OoxmlErrorCode,
  type OoxmlSubtype,
} from "./ooxml"

const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"

describe("detectOoxmlContainer:canonical real fixtures", () => {
  for (const subtype of ["xlsx", "docx", "pptx"] as const) {
    test(`${subtype}:strict structure, bounded inflate, and root relationship`, async () => {
      const contents = fixtureEntries(subtype)
      const result = await detectOoxmlContainer(await makeZip(contents))
      expect(result.status).toBe("detected")
      if (result.status !== "detected") return
      expect(result.subtype).toBe(subtype)
      expect(result.mime).toBe(OOXML_SUBTYPES[subtype].mime)
      expect(result.entryCount).toBe(3)
      expect(result.uncompressedBytes).toBe(
        contents.reduce((total, entry) => total + new TextEncoder().encode(entry[1]).byteLength, 0),
      )
    })
  }

  test("CP437 is the sole non-UTF-8 filename interpretation", async () => {
    const fixture = await makeZip([...fixtureEntries("xlsx"), ["e.txt", "ok"]], { useUnicodeFileNames: false })
    const result = await detectOoxmlContainer(patchEntryName(fixture, "e.txt", new Uint8Array([0x82, 0x2e, 0x74, 0x78, 0x74])))
    expect(result.status).toBe("detected")
  })
})

describe("canonical EOCD and central-directory interpretation", () => {
  test("truncated local-file container has no EOCD", async () => {
    await expectCode(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), "ZIP_EOCD_MISSING")
  })

  test("EOCD comment length must consume exactly to EOF", async () => {
    await expectCode(concat(await makeOoxmlFixture("xlsx"), new Uint8Array([1])), "ZIP_EOCD_COMMENT_LENGTH")
  })

  test("a second EOCD signature hidden in the real EOCD comment is rejected", async () => {
    const fake = new Uint8Array(22)
    new DataView(fake.buffer).setUint32(0, 0x06054b50, true)
    await expectCode(appendEocdComment(await makeOoxmlFixture("xlsx"), fake), "ZIP_EOCD_MULTIPLE")
  })

  test("archive ZIP64 locator or record signature is rejected even without 32-bit sentinels", async () => {
    for (const signature of [0x06064b50, 0x07064b50]) {
      const record = new Uint8Array(4)
      new DataView(record.buffer).setUint32(0, signature, true)
      await expectCode(appendEocdComment(await makeOoxmlFixture("xlsx"), record), "ZIP64_ARCHIVE")
    }
  })

  test("split EOCD fields are rejected", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    new DataView(patched.buffer).setUint16(eocdOffset(patched) + 4, 1, true)
    await expectCode(patched, "ZIP_SPLIT_ARCHIVE")
  })

  test("central size/offset must end exactly at EOCD", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const view = new DataView(patched.buffer)
    const eocd = eocdOffset(patched)
    view.setUint32(eocd + 12, view.getUint32(eocd + 12, true) - 1, true)
    await expectCode(patched, "ZIP_CENTRAL_BOUNDS")
  })

  test("central entry count must match both EOCD count fields", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const view = new DataView(patched.buffer)
    const eocd = eocdOffset(patched)
    view.setUint16(eocd + 8, 4, true)
    view.setUint16(eocd + 10, 4, true)
    await expectCode(patched, "ZIP_CENTRAL_COUNT")
  })

  test("a canonical archive cannot have prepended data", async () => {
    await expectCode(prependAndRebase(await makeOoxmlFixture("xlsx"), new Uint8Array([1, 2, 3, 4])), "ZIP_PREPENDED_DATA")
  })

  test("entry byte ranges cannot overlap", async () => {
    await expectCode(makeOverlappingStoredZip(), "ZIP_ENTRY_OVERLAP")
  })

  test("the 513th central entry stops parsing immediately", async () => {
    const extras = Array.from(
      { length: OOXML_LIMITS.maxEntries - 2 },
      (_, index) => [`xl/worksheets/sheet-${index}.xml`, ""] as FixtureEntry,
    )
    await expectCode(await makeZip([...fixtureEntries("xlsx"), ...extras]), "ZIP_ENTRY_LIMIT")
  })
})

describe("entry names, flags, attributes, and extras", () => {
  const unsafeNames = [
    new TextEncoder().encode("/abs000"),
    new TextEncoder().encode("C:/x000"),
    new TextEncoder().encode("a\\b.txt"),
    new Uint8Array([0x61, 0x00, 0x62, 0x2e, 0x74, 0x78, 0x74]),
    new Uint8Array([0x61, 0x01, 0x62, 0x2e, 0x74, 0x78, 0x74]),
    new TextEncoder().encode("a//b.xx"),
    new TextEncoder().encode("a/./b.x"),
  ]

  for (const [index, rawName] of unsafeNames.entries()) {
    test(`unsafe absolute/control/ambiguous path form ${index + 1}`, async () => {
      const fixture = await makeZip([...fixtureEntries("xlsx"), ["safe000", "x"]])
      await expectCode(patchEntryName(fixture, "safe000", rawName), "ZIP_ENTRY_PATH")
    })
  }

  test("raw filename cannot be empty", async () => {
    await expectCode(makeStoredZip([{ rawName: new Uint8Array(), data: new Uint8Array() }]), "ZIP_ENTRY_NAME_LENGTH")
  })

  test("raw filename cannot exceed 1024 bytes", async () => {
    await expectCode(
      makeStoredZip([{ rawName: new Uint8Array(OOXML_LIMITS.maxEntryNameBytes + 1).fill(0x61), data: new Uint8Array() }]),
      "ZIP_ENTRY_NAME_LENGTH",
    )
  })

  test("UTF-8 filename decoding is fatal", async () => {
    const fixture = await makeZip([...fixtureEntries("xlsx"), ["x.txt", "x"]])
    await expectCode(patchEntryName(fixture, "x.txt", new Uint8Array([0xff, 0x2e, 0x74, 0x78, 0x74])), "ZIP_ENTRY_NAME_ENCODING")
  })

  test("case-folded entry identities are unique", async () => {
    await expectCode(await makeZip([...fixtureEntries("xlsx"), ["A.txt", "a"], ["a.TXT", "b"]]), "ZIP_DUPLICATE_ENTRY")
  })

  test("encryption flag is rejected", async () => {
    await expectCode(patchFlags(await makeOoxmlFixture("xlsx"), "xl/workbook.xml", 1), "ZIP_ENCRYPTED")
  })

  test("data descriptors are rejected", async () => {
    await expectCode(await makeZip(fixtureEntries("xlsx"), { dataDescriptor: true }), "ZIP_DATA_DESCRIPTOR")
  })

  test("entry ZIP64 extra is rejected", async () => {
    const extraField = new Map([[0x0001, new Uint8Array([0, 0, 0, 0])]])
    await expectCode(await makeZip([...fixtureEntries("xlsx"), ["x.bin", "", { extraField }]]), "ZIP64_ENTRY")
  })

  test("Unicode-path extra is rejected", async () => {
    await expectCode(
      makeStoredZip([{
        rawName: new TextEncoder().encode("x.bin"),
        data: new Uint8Array(),
        extra: new Uint8Array([0x75, 0x70, 0x01, 0x00, 0x01]),
      }]),
      "ZIP_UNICODE_PATH_EXTRA",
    )
  })

  test("malformed extra field is rejected", async () => {
    const extraField = new Map([[0x5455, new Uint8Array([1])]])
    const fixture = await makeZip([...fixtureEntries("xlsx"), ["x.bin", "", { extraField }]])
    const patched = patchExtraSize(fixture, "x.bin", 0xffff)
    await expectCode(patched, "ZIP_EXTRA_FIELD_MALFORMED")
  })

  test("diskNumberStart is rejected", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const record = centralRecord(patched, "xl/workbook.xml")
    new DataView(patched.buffer).setUint16(record.centralOffset + 34, 1, true)
    await expectCode(patched, "ZIP_SPLIT_ENTRY")
  })

  test("compression methods other than store/deflate are rejected", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = patchLocalAndCentral16(fixture, "xl/workbook.xml", 8, 10, 9)
    await expectCode(patched, "ZIP_UNSUPPORTED_COMPRESSION")
  })

  test("Unix symlink attributes are rejected", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const record = centralRecord(patched, "xl/workbook.xml")
    const view = new DataView(patched.buffer)
    view.setUint16(record.centralOffset + 4, 0x0314, true)
    view.setUint32(record.centralOffset + 38, 0xa0000000, true)
    await expectCode(patched, "ZIP_SYMLINK_ENTRY")
  })
})

describe("local headers must exactly match the central directory", () => {
  test("local header must be in bounds", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const record = centralRecord(patched, "xl/workbook.xml")
    new DataView(patched.buffer).setUint32(record.centralOffset + 42, patched.byteLength, true)
    await expectCode(patched, "ZIP_LOCAL_HEADER_BOUNDS")
  })

  test("local signature must be exact", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const record = centralRecord(patched, "xl/workbook.xml")
    new DataView(patched.buffer).setUint32(record.localOffset, 0, true)
    await expectCode(patched, "ZIP_LOCAL_HEADER_SIGNATURE")
  })

  for (const field of [
    { name: "version", local: 4 },
    { name: "flags", local: 6 },
    { name: "method", local: 8 },
    { name: "modification time", local: 10 },
    { name: "modification date", local: 12 },
  ]) {
    test(`local ${field.name} mismatch`, async () => {
      const fixture = await makeOoxmlFixture("xlsx")
      const patched = fixture.slice()
      const record = centralRecord(patched, "xl/workbook.xml")
      const view = new DataView(patched.buffer)
      view.setUint16(record.localOffset + field.local, view.getUint16(record.localOffset + field.local, true) ^ 2, true)
      await expectCode(patched, "ZIP_LOCAL_HEADER_MISMATCH")
    })
  }

  for (const field of [
    { name: "CRC", local: 14 },
    { name: "compressed size", local: 18 },
    { name: "uncompressed size", local: 22 },
  ]) {
    test(`local ${field.name} mismatch`, async () => {
      const fixture = await makeOoxmlFixture("xlsx")
      const patched = fixture.slice()
      const record = centralRecord(patched, "xl/workbook.xml")
      const view = new DataView(patched.buffer)
      view.setUint32(record.localOffset + field.local, view.getUint32(record.localOffset + field.local, true) ^ 1, true)
      await expectCode(patched, "ZIP_LOCAL_HEADER_MISMATCH")
    })
  }

  test("local raw filename mismatch", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const record = centralRecord(patched, "xl/workbook.xml")
    patched[record.localOffset + 30] ^= 1
    await expectCode(patched, "ZIP_LOCAL_HEADER_MISMATCH")
  })

  test("local extra field mismatch", async () => {
    const extraField = new Map([[0x5455, new Uint8Array([1])]])
    const fixture = await makeZip([...fixtureEntries("xlsx"), ["x.bin", "x", { extraField }]])
    const patched = fixture.slice()
    const record = centralRecord(patched, "x.bin")
    const view = new DataView(patched.buffer)
    const nameLength = view.getUint16(record.localOffset + 26, true)
    patched[record.localOffset + 30 + nameLength + 4] ^= 1
    await expectCode(patched, "ZIP_LOCAL_HEADER_MISMATCH")
  })
})

describe("declared and actual inflate budgets", () => {
  test("declared per-entry size is rejected before inflate", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    await expectCode(
      patchLocalAndCentral32(
        fixture,
        "xl/workbook.xml",
        22,
        24,
        OOXML_LIMITS.maxEntryUncompressedBytes + 1,
      ),
      "ZIP_DECLARED_ENTRY_LIMIT",
    )
  })

  test("declared compression ratio is rejected before inflate", async () => {
    await expectCode(
      await makeZip([...fixtureEntries("xlsx"), ["xl/large.bin", "x".repeat(512 * 1024)]]),
      "ZIP_DECLARED_RATIO_LIMIT",
    )
  })

  test("Content Types uses a real-time sink when declared small but actual output is large", async () => {
    const oversized = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><!--${noise(OOXML_LIMITS.maxContentTypesBytes + 64 * 1024)}--></Types>`
    const fixture = await makeZip([
      ["[Content_Types].xml", oversized],
      ["_rels/.rels", relationshipsXml("xl/workbook.xml")],
      ["xl/workbook.xml", mainPartXml("xlsx")],
    ])
    await expectCode(
      patchLocalAndCentral32(fixture, "[Content_Types].xml", 22, 24, 32),
      "CONTENT_TYPES_INFLATE_LIMIT",
    )
  })

  test("actual output must equal the declared uncompressed size", async () => {
    const fixture = await makeZip([...fixtureEntries("xlsx"), ["xl/random.bin", noise(4096)]])
    const record = centralRecord(fixture, "xl/random.bin")
    const declared = new DataView(fixture.buffer).getUint32(record.centralOffset + 24, true)
    await expectCode(
      patchLocalAndCentral32(fixture, "xl/random.bin", 22, 24, declared - 1),
      "ZIP_INFLATE_SIZE_MISMATCH",
    )
  })

  test("actual compression ratio is enforced while inflating", async () => {
    const fixture = await makeZip([...fixtureEntries("xlsx"), ["xl/bomb.bin", "x".repeat(512 * 1024)]])
    await expectCode(
      patchLocalAndCentral32(fixture, "xl/bomb.bin", 22, 24, 32),
      "ZIP_INFLATE_RATIO_LIMIT",
    )
  })

  test("root relationships use their own real-time retained-content cap", async () => {
    const oversized = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><!--${noise(OOXML_LIMITS.maxRelationshipsBytes + 64 * 1024)}--></Relationships>`
    const fixture = await makeZip([
      ["[Content_Types].xml", contentTypesXml("xlsx")],
      ["_rels/.rels", oversized],
      ["xl/workbook.xml", mainPartXml("xlsx")],
    ])
    await expectCode(
      patchLocalAndCentral32(fixture, "_rels/.rels", 22, 24, 32),
      "ROOT_RELS_INFLATE_LIMIT",
    )
  })

  test("non-retained parts are still streamed and CRC-checked", async () => {
    const fixture = await makeOoxmlFixture("xlsx")
    const patched = fixture.slice()
    const record = centralRecord(patched, "xl/workbook.xml")
    const view = new DataView(patched.buffer)
    const dataOffset = record.localOffset + 30 + view.getUint16(record.localOffset + 26, true) + view.getUint16(record.localOffset + 28, true)
    patched[dataOffset] ^= 1
    await expectCode(patched, "ZIP_DECOMPRESSION_FAILED")
  })
})

describe("OOXML package entry relationship", () => {
  test("declared main part must exist", async () => {
    await expectCode(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("xlsx")],
        ["_rels/.rels", relationshipsXml("xl/workbook.xml")],
        ["word/document.xml", "<document/>"]
      ]),
      "OOXML_MAIN_PART_MISSING",
    )
  })

  test("main part must be a real non-directory file", async () => {
    await expectCode(
      makeStoredZip([
        { rawName: new TextEncoder().encode("[Content_Types].xml"), data: new TextEncoder().encode(contentTypesXml("xlsx")) },
        { rawName: new TextEncoder().encode("_rels/.rels"), data: new TextEncoder().encode(relationshipsXml("xl/workbook.xml")) },
        {
          rawName: new TextEncoder().encode("xl/workbook.xml"),
          data: new Uint8Array(),
          versionMadeBy: 0x0314,
          externalFileAttributes: 0x40000000,
        },
      ]),
      "OOXML_MAIN_PART_DIRECTORY",
    )
  })

  test("root relationship must point to the detected main part", async () => {
    await expectCode(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("xlsx")],
        ["_rels/.rels", relationshipsXml("word/document.xml")],
        ["xl/workbook.xml", mainPartXml("xlsx")],
      ]),
      "ROOT_RELS_TARGET_MISMATCH",
    )
  })

  test("exactly one officeDocument relationship is required", async () => {
    const relationships = [
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
      relationshipXml("rId1", "xl/workbook.xml"),
      relationshipXml("rId2", "xl/workbook.xml"),
      `</Relationships>`,
    ].join("")
    await expectCode(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("xlsx")],
        ["_rels/.rels", relationships],
        ["xl/workbook.xml", mainPartXml("xlsx")],
      ]),
      "ROOT_RELS_OFFICE_DOCUMENT_COUNT",
    )
  })

  test("external officeDocument relationship is rejected", async () => {
    const relationships = [
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
      relationshipXml("rId1", "https://example.invalid/book", ` TargetMode="External"`),
      `</Relationships>`,
    ].join("")
    await expectCode(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("xlsx")],
        ["_rels/.rels", relationships],
        ["xl/workbook.xml", mainPartXml("xlsx")],
      ]),
      "ROOT_RELS_EXTERNAL_TARGET",
    )
  })

  test("an explicitly empty TargetMode is not accepted as an internal relationship", async () => {
    const relationships = [
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
      relationshipXml("rId1", "xl/workbook.xml", ` TargetMode=""`),
      `</Relationships>`,
    ].join("")
    await expectCode(
      await makeZip([
        ["[Content_Types].xml", contentTypesXml("xlsx")],
        ["_rels/.rels", relationships],
        ["xl/workbook.xml", mainPartXml("xlsx")],
      ]),
      "ROOT_RELS_EXTERNAL_TARGET",
    )
  })
})

type FixtureEntry = readonly [string, string, ZipWriterAddDataOptions?]

async function expectCode(bytes: Uint8Array, code: OoxmlErrorCode) {
  const result = await detectOoxmlContainer(bytes)
  expect(result.status).not.toBe("detected")
  if (result.status === "detected") return
  expect(result.code).toBe(code)
}

function fixtureEntries(subtype: OoxmlSubtype): FixtureEntry[] {
  return [
    ["[Content_Types].xml", contentTypesXml(subtype)],
    ["_rels/.rels", relationshipsXml(OOXML_SUBTYPES[subtype].mainPart)],
    [OOXML_SUBTYPES[subtype].mainPart, mainPartXml(subtype)],
  ]
}

async function makeOoxmlFixture(subtype: OoxmlSubtype) {
  return makeZip(fixtureEntries(subtype))
}

async function makeZip(entries: ReadonlyArray<FixtureEntry>, defaults: ZipWriterAddDataOptions = {}) {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output, { useWebWorkers: false })
  for (const entry of entries)
    await writer.add(entry[0], new TextReader(entry[1]), {
      dataDescriptor: false,
      extendedTimestamp: false,
      ...defaults,
      ...entry[2],
    })
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
    relationshipXml("rId1", target),
    `</Relationships>`,
  ].join("")
}

function relationshipXml(id: string, target: string, suffix = "") {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"${suffix}/>`
}

function mainPartXml(subtype: OoxmlSubtype) {
  if (subtype === "docx")
    return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`
  if (subtype === "xlsx")
    return `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>`
  return `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>`
}

function eocdOffset(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = bytes.byteLength - 22; offset >= 0; offset--)
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  throw new Error("fixture EOCD missing")
}

function centralRecords(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = eocdOffset(bytes)
  const count = view.getUint16(eocd + 10, true)
  const records: Array<{ filename: string; centralOffset: number; localOffset: number }> = []
  let offset = view.getUint32(eocd + 16, true)
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("fixture central header missing")
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    records.push({
      filename: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      centralOffset: offset,
      localOffset: view.getUint32(offset + 42, true),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return records
}

function centralRecord(bytes: Uint8Array, filename: string) {
  const record = centralRecords(bytes).find((candidate) => candidate.filename === filename)
  if (!record) throw new Error(`fixture entry missing:${filename}`)
  return record
}

function patchEntryName(bytes: Uint8Array, filename: string, rawName: Uint8Array) {
  const patched = bytes.slice()
  const record = centralRecord(patched, filename)
  const view = new DataView(patched.buffer)
  const centralLength = view.getUint16(record.centralOffset + 28, true)
  const localLength = view.getUint16(record.localOffset + 26, true)
  if (rawName.byteLength !== centralLength || rawName.byteLength !== localLength) throw new Error("replacement name length differs")
  patched.set(rawName, record.centralOffset + 46)
  patched.set(rawName, record.localOffset + 30)
  return patched
}

function patchFlags(bytes: Uint8Array, filename: string, flag: number) {
  const patched = bytes.slice()
  const record = centralRecord(patched, filename)
  const view = new DataView(patched.buffer)
  view.setUint16(record.centralOffset + 8, view.getUint16(record.centralOffset + 8, true) | flag, true)
  view.setUint16(record.localOffset + 6, view.getUint16(record.localOffset + 6, true) | flag, true)
  return patched
}

function patchLocalAndCentral16(bytes: Uint8Array, filename: string, localField: number, centralField: number, value: number) {
  const patched = bytes.slice()
  const record = centralRecord(patched, filename)
  const view = new DataView(patched.buffer)
  view.setUint16(record.localOffset + localField, value, true)
  view.setUint16(record.centralOffset + centralField, value, true)
  return patched
}

function patchLocalAndCentral32(bytes: Uint8Array, filename: string, localField: number, centralField: number, value: number) {
  const patched = bytes.slice()
  const record = centralRecord(patched, filename)
  const view = new DataView(patched.buffer)
  view.setUint32(record.localOffset + localField, value, true)
  view.setUint32(record.centralOffset + centralField, value, true)
  return patched
}

function patchExtraSize(bytes: Uint8Array, filename: string, size: number) {
  const patched = bytes.slice()
  const record = centralRecord(patched, filename)
  const view = new DataView(patched.buffer)
  const centralNameLength = view.getUint16(record.centralOffset + 28, true)
  const localNameLength = view.getUint16(record.localOffset + 26, true)
  view.setUint16(record.centralOffset + 46 + centralNameLength + 2, size, true)
  view.setUint16(record.localOffset + 30 + localNameLength + 2, size, true)
  return patched
}

function appendEocdComment(bytes: Uint8Array, comment: Uint8Array) {
  const output = concat(bytes, comment)
  new DataView(output.buffer).setUint16(eocdOffset(bytes) + 20, comment.byteLength, true)
  return output
}

function prependAndRebase(bytes: Uint8Array, prefix: Uint8Array) {
  const output = concat(prefix, bytes)
  const view = new DataView(output.buffer)
  const shiftedEocd = prefix.byteLength + eocdOffset(bytes)
  const originalCentral = view.getUint32(shiftedEocd + 16, true)
  view.setUint32(shiftedEocd + 16, originalCentral + prefix.byteLength, true)
  centralRecords(bytes).forEach((record) =>
    view.setUint32(prefix.byteLength + record.centralOffset + 42, record.localOffset + prefix.byteLength, true))
  return output
}

function noise(length: number) {
  let state = 0x12345678
  return Array.from({ length }, () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return String.fromCharCode(33 + (state % 90))
  }).join("")
}

type StoredEntry = {
  rawName: Uint8Array
  data: Uint8Array
  flags?: number
  extra?: Uint8Array
  versionMadeBy?: number
  externalFileAttributes?: number
}

function makeStoredZip(entries: readonly StoredEntry[]) {
  const locals: Uint8Array[] = []
  const offsets: number[] = []
  let localOffset = 0
  entries.forEach((entry) => {
    offsets.push(localOffset)
    const local = localRecord(entry)
    locals.push(local)
    localOffset += local.byteLength
  })
  const central = entries.map((entry, index) => centralStoredRecord(entry, offsets[index]))
  const centralSize = central.reduce((total, record) => total + record.byteLength, 0)
  return concat(...locals, ...central, eocdRecord(entries.length, localOffset, centralSize))
}

function makeOverlappingStoredZip() {
  const inner: StoredEntry = { rawName: new TextEncoder().encode("b.txt"), data: new TextEncoder().encode("b"), flags: 0x0800 }
  const innerLocal = localRecord(inner)
  const prefix = new TextEncoder().encode("prefix")
  const outer: StoredEntry = { rawName: new TextEncoder().encode("a.txt"), data: concat(prefix, innerLocal), flags: 0x0800 }
  const outerLocal = localRecord(outer)
  const innerOffset = 30 + outer.rawName.byteLength + prefix.byteLength
  const central = [centralStoredRecord(outer, 0), centralStoredRecord(inner, innerOffset)]
  const centralSize = central[0].byteLength + central[1].byteLength
  return concat(outerLocal, ...central, eocdRecord(2, outerLocal.byteLength, centralSize))
}

function localRecord(entry: StoredEntry) {
  const extra = entry.extra ?? new Uint8Array()
  const header = new Uint8Array(30)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, entry.flags ?? 0x0800, true)
  view.setUint16(8, 0, true)
  view.setUint32(14, crc32(entry.data), true)
  view.setUint32(18, entry.data.byteLength, true)
  view.setUint32(22, entry.data.byteLength, true)
  view.setUint16(26, entry.rawName.byteLength, true)
  view.setUint16(28, extra.byteLength, true)
  return concat(header, entry.rawName, extra, entry.data)
}

function centralStoredRecord(entry: StoredEntry, localOffset: number) {
  const extra = entry.extra ?? new Uint8Array()
  const header = new Uint8Array(46)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, entry.versionMadeBy ?? 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, entry.flags ?? 0x0800, true)
  view.setUint16(10, 0, true)
  view.setUint32(16, crc32(entry.data), true)
  view.setUint32(20, entry.data.byteLength, true)
  view.setUint32(24, entry.data.byteLength, true)
  view.setUint16(28, entry.rawName.byteLength, true)
  view.setUint16(30, extra.byteLength, true)
  view.setUint32(38, entry.externalFileAttributes ?? 0, true)
  view.setUint32(42, localOffset, true)
  return concat(header, entry.rawName, extra)
}

function eocdRecord(entries: number, centralOffset: number, centralSize: number) {
  const eocd = new Uint8Array(22)
  const view = new DataView(eocd.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, entries, true)
  view.setUint16(10, entries, true)
  view.setUint32(12, centralSize, true)
  view.setUint32(16, centralOffset, true)
  return eocd
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  bytes.forEach((byte) => {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  })
  return (crc ^ 0xffffffff) >>> 0
}

function concat(...arrays: readonly Uint8Array[]) {
  const output = new Uint8Array(arrays.reduce((total, array) => total + array.byteLength, 0))
  let offset = 0
  arrays.forEach((array) => {
    output.set(array, offset)
    offset += array.byteLength
  })
  return output
}
