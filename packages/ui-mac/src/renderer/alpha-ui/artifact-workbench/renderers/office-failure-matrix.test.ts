// REQ-123 / alpha-code#1177 (AC4/AC5) — the honest-failure matrix, end to end from REAL
// malicious/boundary bytes.
//
// The merged office-structure.test.ts already proves the code→category mapping with
// *synthetic* `{status:"rejected", code}` objects, and ooxml-content.test.ts proves the
// text-layer gate on raw strings. What was missing — and what this ticket owns — is the
// full chain: real bad container/part bytes → detectOoxmlContainer / parseOoxmlContentPart
// → the presentation objects the workbench renders (presentOfficeStructure /
// officeTextExtractionOf). Each of the six named categories is proven two ways:
//   (a) a KNOWN-BAD input produces the honest failure surface (the "prove it can go red"
//       arm the ticket demands — the assertion is not vacuous), and
//   (b) a BENIGN twin through the identical pipeline does NOT trip that surface (the
//       control that proves the assertion actually discriminates).
//
// Runtime note (baseline ①): categories 3/4/6 rest on the TEXT-LAYER forbidden-markup
// regex and the byte-length cap — no DOMParser entity behavior — so bun/happy-dom is
// faithful here. The real-Chromium arm (docs/verification/2026-08-29-req123-1177-*/) has
// independently confirmed the identical CONTENT_PART_FORBIDDEN_MARKUP codes in production
// Chromium and that none of these inputs reaches the network.

import { describe, expect, test } from "bun:test"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { detectOoxmlContainer, OOXML_SUBTYPES, type OoxmlDetection } from "./ooxml"
import { presentOfficeStructure } from "./office-structure"
import { officeTextExtractionOf } from "./office-text"
import { OOXML_CONTENT_LIMITS } from "./ooxml-content"

const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
const DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
const DOCX_MAIN = "word/document.xml"

type Entry = [string, string]

async function zip(entries: Entry[]): Promise<Uint8Array> {
  const out = new Uint8ArrayWriter()
  const w = new ZipWriter(out, { useWebWorkers: false })
  for (const [n, b] of entries) await w.add(n, new TextReader(b), { dataDescriptor: false, extendedTimestamp: false })
  await w.close()
  return out.getData()
}
const contentTypes = (mainPart: string, ct: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${mainPart}" ContentType="${ct}"/></Types>`
const rootRels = (mainPart: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/></Relationships>`
const docBody = (inner: string) =>
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${inner}</w:t></w:r></w:p></w:body></w:document>`

/** A well-formed docx shell whose word/document.xml is the given raw bytes. */
function docxShell(documentXml: string | Uint8Array): Entry[] {
  return [
    ["[Content_Types].xml", contentTypes(DOCX_MAIN, DOCX_CT)],
    ["_rels/.rels", rootRels(DOCX_MAIN)],
    // ZipWriter TextReader takes a string; UTF-16 bytes are injected via a separate path below.
    [DOCX_MAIN, typeof documentXml === "string" ? documentXml : ""],
  ]
}

const docxClaim = { name: "report.docx", claimedMime: OOXML_SUBTYPES.docx.mime, detectedMime: "application/zip" }

/** Present as the workbench does: structure → office status; extraction → pass-branch content. */
async function surfaceOf(bytes: Uint8Array) {
  const detection = await detectOoxmlContainer(bytes, { retainContentParts: true })
  const structure = presentOfficeStructure({ ...docxClaim, detection })
  const extraction = officeTextExtractionOf(detection.status === "detected" ? detection : undefined)
  return { detection, structure, extraction }
}

// ─────────────────────────────────────────────────────────────────────────────
// Container-layer categories (1/2/5) → presentOfficeStructure rejection card.
// Each asserts: quickLook stays false (no in-app preview of an unverified container),
// but the rejected card is honest (category + code), and per office-preview.test.ts the
// external-open + reveal actions remain reachable off that card.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC5 honest-failure matrix — container layer (real bytes)", () => {
  test("1. over-budget container (>512 entries) → safety-limit card, benign twin passes", async () => {
    const overBudget: Entry[] = docxShell(docBody("hi"))
    for (let i = 0; i < 600; i++) overBudget.push([`extra/f${i}.xml`, "<a/>"])
    const bad = await surfaceOf(await zip(overBudget))
    expect(bad.detection.status).toBe("rejected")
    if (bad.detection.status === "rejected") expect(bad.detection.code).toBe("ZIP_ENTRY_LIMIT")
    expect(bad.structure).toMatchObject({ status: "rejected", quickLook: false, category: "safety-limit" })

    // control: same shell, few entries → detected + pass (proves the cap, not the shell, red it)
    const ok = await surfaceOf(await zip(docxShell(docBody("hi"))))
    expect(ok.structure).toMatchObject({ status: "pass", quickLook: true })
  })

  test("2. corrupt container (flipped deflate bytes) → invalid-document card, benign twin passes", async () => {
    const good = await zip(docxShell(docBody("hello world padded out for a deflate stream to corrupt")))
    const corrupt = good.slice()
    const mid = Math.floor(corrupt.length * 0.5)
    for (let i = mid; i < mid + 40 && i < corrupt.length; i++) corrupt[i] ^= 0xff
    const bad = await surfaceOf(corrupt)
    expect(bad.detection.status).toBe("rejected")
    if (bad.detection.status === "rejected") expect(bad.detection.code).toBe("ZIP_DECOMPRESSION_FAILED")
    expect(bad.structure).toMatchObject({ status: "rejected", quickLook: false, category: "invalid-document" })

    const ok = await surfaceOf(good)
    expect(ok.structure).toMatchObject({ status: "pass", quickLook: true })
  })

  test("5. structure-gate rejection (declared main part absent) → incomplete-structure card", async () => {
    const bad = await surfaceOf(
      await zip([["[Content_Types].xml", contentTypes(DOCX_MAIN, DOCX_CT)], ["_rels/.rels", rootRels(DOCX_MAIN)]]),
    )
    expect(bad.detection.status).toBe("rejected")
    if (bad.detection.status === "rejected") expect(bad.detection.code).toBe("OOXML_MAIN_PART_MISSING")
    expect(bad.structure).toMatchObject({ status: "rejected", quickLook: false, category: "incomplete-structure" })

    const ok = await surfaceOf(await zip(docxShell(docBody("present"))))
    expect(ok.structure).toMatchObject({ status: "pass", quickLook: true })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Content-part-layer categories (3/4/6): the container is a valid, detected docx, but the
// content part is hostile/over-cap. Surface = pass branch + extraction "failed" with the
// honest code (renderer-views.tsx renders [data-office-extract-failed] and keeps Quick
// Look reachable — asserted in office-preview.test.ts).
//
// RUNTIME HONESTY (baseline ①): these three codes — FORBIDDEN_MARKUP / INVALID_ENCODING /
// PARSE_LIMIT — are decided in parseOoxmlContentPart BEFORE `parseFromString`, so bun is
// faithful. The GREEN twin ("a clean part extracts") is NOT assertable here: happy-dom's
// DOMParser reports parsererror on well-formed OOXML that Chromium parses cleanly (measured
// this run: even `<root><child/></root>` → CONTENT_PART_INVALID_XML under happy-dom). The
// true green is owned by the real-Chromium harness (results/chromium-run.json:
// production:url-in-text-and-rels → status "extracted"). So the discriminating control here
// asserts the text-layer gate reacts SPECIFICALLY to the hostile marker: the benign twin's
// failure code is anything BUT this category's code — proving the assertion is not vacuous.
// ─────────────────────────────────────────────────────────────────────────────

describe("AC4/AC5 honest-failure matrix — content-part layer (real bytes)", () => {
  test("3. <!DOCTYPE in content part → extraction failed CONTENT_PART_FORBIDDEN_MARKUP", async () => {
    const hostile = `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "boom">]>${docBody("&x;")}`
    const bad = await surfaceOf(await zip(docxShell(hostile)))
    expect(bad.structure).toMatchObject({ status: "pass", quickLook: true }) // container is valid…
    expect(bad.extraction).toEqual({ status: "failed", code: "CONTENT_PART_FORBIDDEN_MARKUP" }) // …part is not

    // Control: identical doc WITHOUT the DOCTYPE is not caught by the markup gate.
    const clean = await surfaceOf(await zip(docxShell(docBody("clean text"))))
    expect(clean.extraction).not.toEqual({ status: "failed", code: "CONTENT_PART_FORBIDDEN_MARKUP" })
  })

  test("4. UTF-16-encoded <!DOCTYPE → caught on the decoded string, extraction failed", async () => {
    // Inject genuine UTF-16LE bytes for word/document.xml (bypasses TextReader, which is UTF-8).
    const xml = `<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE w:document [<!ENTITY x "boom">]>${docBody("&x;")}`
    const utf16 = new Uint8Array(2 + xml.length * 2)
    utf16[0] = 0xff
    utf16[1] = 0xfe
    for (let i = 0; i < xml.length; i++) {
      utf16[2 + i * 2] = xml.charCodeAt(i) & 0xff
      utf16[2 + i * 2 + 1] = (xml.charCodeAt(i) >> 8) & 0xff
    }
    // A byte-layer UTF-8 regex over these bytes finds no DOCTYPE — the gate must decode first.
    const asLatin1 = Array.from(utf16, (b) => String.fromCharCode(b)).join("")
    expect(/<!\s*(?:DOCTYPE|ENTITY)/i.test(asLatin1)).toBe(false)

    const bytes = await zipWithRawPart(docxShell(""), DOCX_MAIN, utf16)
    const bad = await surfaceOf(bytes)
    expect(bad.structure).toMatchObject({ status: "pass", quickLook: true })
    expect(bad.extraction).toEqual({ status: "failed", code: "CONTENT_PART_FORBIDDEN_MARKUP" })
  })

  test("6. content part above the 4 MiB parse cap → extraction failed CONTENT_PART_PARSE_LIMIT", async () => {
    // High-entropy filler: a low-entropy run ("x".repeat) trips the container ratio cap
    // (ZIP_DECLARED_RATIO_LIMIT) long before the content cap, so the part must be roughly
    // incompressible to isolate the 4 MiB parse cap.
    const filler = highEntropy(OOXML_CONTENT_LIMITS.maxPartParseBytes + 1024)
    const bad = await surfaceOf(await zip(docxShell(docBody(filler))))
    expect(bad.structure).toMatchObject({ status: "pass", quickLook: true })
    expect(bad.extraction).toEqual({ status: "failed", code: "CONTENT_PART_PARSE_LIMIT" })

    // Control: a part comfortably under the cap is not caught by the size gate.
    const small = await surfaceOf(await zip(docxShell(docBody("small"))))
    expect(small.extraction).not.toEqual({ status: "failed", code: "CONTENT_PART_PARSE_LIMIT" })
  })
})

function highEntropy(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 "
  const rnd = new Uint8Array(length)
  crypto.getRandomValues(rnd)
  let out = ""
  for (let i = 0; i < length; i++) out += alphabet[rnd[i]! % alphabet.length]
  return out
}

// Build a zip where one part is supplied as raw bytes (ZipWriter's TextReader is UTF-8 only).
async function zipWithRawPart(shell: Entry[], rawName: string, rawBytes: Uint8Array): Promise<Uint8Array> {
  const { Uint8ArrayReader } = await import("@zip.js/zip.js")
  const out = new Uint8ArrayWriter()
  const w = new ZipWriter(out, { useWebWorkers: false })
  for (const [n, b] of shell) {
    if (n === rawName) await w.add(n, new Uint8ArrayReader(rawBytes), { dataDescriptor: false, extendedTimestamp: false })
    else await w.add(n, new TextReader(b), { dataDescriptor: false, extendedTimestamp: false })
  }
  await w.close()
  return out.getData()
}
