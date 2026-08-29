// REQ-123 (#1174):the single bytes → `Document` gate for OOXML content parts.
//
// Chromium's DOMParser silently accepts `<!DOCTYPE` and expands internal entities
// (measured in the REQ-123 recon:6 nesting levels expanded to 125,000 characters — a
// billion-laughs DoS vector, not a hypothetical). It never fetches external entities, so
// the boundary this gate defends is DoS via entity expansion, not XXE file reads.
//
// M1 (baseline ③ class 2):the scan runs on the **decoded string**, never on raw bytes.
// A part encoded as UTF-16 (BOM + `encoding="UTF-16"`) gives a byte-level UTF-8 regex zero
// hits while the decoded DOCTYPE is intact — a byte-layer gate would be fake. Decode and
// scan therefore happen side by side in this one function, and `parseFromString` receives
// the *identical* string that was scanned;no re-decode can diverge between gate and parser.
//
// Extractors (docx/xlsx/pptx) must call this function and must not touch `DOMParser`
// themselves — enforced by src/ooxml-chokepoint.test.ts (an import-graph/text gate that
// catches an accidentally opened second path, not a malicious implementation).

export const OOXML_CONTENT_LIMITS = {
  /**
   * M2 (baseline ③):`parseFromString` runs synchronously on the renderer main thread. A
   * legal 20–30 MiB sheet XML passes every zip cap yet would freeze the UI for seconds, so
   * the content layer sets its own parse cap — an order of magnitude above the largest part
   * seen across the 7 real recon samples (438 KB). This deliberately does NOT touch
   * OOXML_LIMITS:over-cap parts take the honest degradation card, not a load failure.
   */
  maxPartParseBytes: 4 * 1024 * 1024,
} as const

export type OoxmlContentErrorCode =
  | "CONTENT_PART_PARSE_LIMIT"
  | "CONTENT_PART_INVALID_ENCODING"
  | "CONTENT_PART_FORBIDDEN_MARKUP"
  | "CONTENT_PART_INVALID_XML"

export type OoxmlContentParse =
  | { ok: true; document: Document }
  | { ok: false; code: OoxmlContentErrorCode; reason: string }

// Same shape as the package-layer gate in shared/ooxml.ts parseXmlRoot. CDATA ruling
// (required by baseline 末节, measured 2026-08-29 *before* implementation):across all
// 7 real recon samples (cocoa.docx, pydocx.docx, py.xlsx, py.pptx, real resume.docx,
// real test.pptx, real S2.1自评估.xlsx), the 28 parts matching the content allowlist
// contain **0** occurrences of `<![CDATA[`. Decision:**reject** — zero observed cost on
// real generators (Cocoa textutil, python-docx/openpyxl/python-pptx, MS Word/Excel/
// PowerPoint for Mac), one shared answer for all three extractors instead of three local
// ones, and the failure surface is the honest degradation card. Revisit only with a real
// generator sample that uses CDATA, not speculatively.
const FORBIDDEN_MARKUP = /<!\s*(?:DOCTYPE|ENTITY)|<!\[CDATA\[/i

/** Decode an OOXML content part and parse it, rejecting DTD/entity/CDATA markup first. */
export function parseOoxmlContentPart(bytes: Uint8Array): OoxmlContentParse {
  if (bytes.byteLength > OOXML_CONTENT_LIMITS.maxPartParseBytes)
    return failure(
      "CONTENT_PART_PARSE_LIMIT",
      `${bytes.byteLength} > ${OOXML_CONTENT_LIMITS.maxPartParseBytes}`,
    )
  const decoded = decodeXmlBytes(bytes)
  if (decoded === null) return failure("CONTENT_PART_INVALID_ENCODING", "not valid UTF-8/UTF-16")
  const forbidden = decoded.match(FORBIDDEN_MARKUP)
  if (forbidden) return failure("CONTENT_PART_FORBIDDEN_MARKUP", forbidden[0])
  let document: Document
  try {
    document = new DOMParser().parseFromString(decoded, "application/xml")
  } catch (error) {
    return failure("CONTENT_PART_INVALID_XML", error instanceof Error ? error.message : "parse threw")
  }
  // Qualified-name lookup:matches Chromium's prefix-less `<parsererror>` (mozilla error
  // namespace) and happy-dom's — the NS variant `getElementsByTagNameNS("*", …)` misses
  // happy-dom's element (probed 2026-08-29). A legitimate OOXML part has no element with
  // this name;a hostile one that plants it merely rejects itself (fail-closed, honest card).
  if (document.getElementsByTagName("parsererror").length > 0)
    return failure("CONTENT_PART_INVALID_XML", "parsererror")
  return { ok: true, document }
}

// OPC parts are UTF-8 or UTF-16;UTF-16 without a BOM is not well-formed XML, so BOM
// sniffing is the complete, closed set of cases. TextDecoder strips the BOM (measured:
// bun and Chromium both), so `decoded` starts at `<?xml`. A BOM-less UTF-16 part decodes
// as NUL-interleaved UTF-8 text and fails downstream as CONTENT_PART_INVALID_XML — the
// parser sees exactly what the scanner saw, so nothing can hide markup from the scan.
function decodeXmlBytes(bytes: Uint8Array): string | null {
  try {
    if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes)
    if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes)
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function failure(code: OoxmlContentErrorCode, reason: string): OoxmlContentParse {
  return { ok: false, code, reason: `${code}:${reason}` }
}
