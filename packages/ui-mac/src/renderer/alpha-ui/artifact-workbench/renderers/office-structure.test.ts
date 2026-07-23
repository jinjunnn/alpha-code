import { describe, expect, test } from "bun:test"
import { OOXML_SUBTYPES, type OoxmlDetection, type OoxmlErrorCode } from "./ooxml"
import { presentOfficeStructure } from "./office-structure"

const claim = {
  name: "report.docx",
  claimedMime: OOXML_SUBTYPES.docx.mime,
  detectedMime: "application/zip",
}

const pass: OoxmlDetection = {
  status: "detected",
  subtype: "docx",
  mime: OOXML_SUBTYPES.docx.mime,
  entryCount: 3,
  uncompressedBytes: 100,
}

describe("Office structure status presentation", () => {
  test("checking, PASS, and rejection map to honest status-area states", () => {
    expect(presentOfficeStructure(claim)).toEqual({ status: "checking", quickLook: false })
    expect(presentOfficeStructure({ ...claim, detection: pass })).toEqual({
      status: "pass",
      quickLook: true,
      subtype: "docx",
    })
    expect(
      presentOfficeStructure({
        ...claim,
        detection: { status: "rejected", code: "ZIP_ENCRYPTED", reason: "ZIP_ENCRYPTED" },
      }),
    ).toEqual({
      status: "rejected",
      quickLook: false,
      category: "encrypted",
      code: "ZIP_ENCRYPTED",
    })
  })

  test.each([
    ["NOT_ZIP", "invalid-document"],
    ["ZIP_EOCD_MISSING", "invalid-document"],
    ["ZIP_ENCRYPTED", "encrypted"],
    ["ZIP_ENTRY_LIMIT", "safety-limit"],
    ["ZIP_INFLATE_TIMEOUT", "safety-limit"],
    ["ZIP_ENTRY_PATH", "unsafe-path"],
    ["ZIP_SYMLINK_ENTRY", "unsafe-path"],
    ["CONTENT_TYPES_UNSAFE_PART", "unsafe-path"],
    ["CONTENT_TYPES_MISSING", "incomplete-structure"],
    ["OOXML_MAIN_PART_CONFLICT", "incomplete-structure"],
    ["ROOT_RELS_MISSING", "incomplete-structure"],
  ] as const)("classifies %s as %s", (code, category) => {
    expect(
      presentOfficeStructure({
        ...claim,
        detection: { status: "rejected", code: code as OoxmlErrorCode, reason: code },
      }),
    ).toMatchObject({ status: "rejected", quickLook: false, category, code })
  })

  test("claim conflicts reject Quick Look even when the container itself is valid", () => {
    expect(presentOfficeStructure({ ...claim, name: "report.xlsx", detection: pass })).toEqual({
      status: "rejected",
      quickLook: false,
      category: "type-mismatch",
      code: "OOXML_CLAIM_CONFLICT",
    })
  })

  test("non-Office artifacts do not receive an Office status region", () => {
    expect(presentOfficeStructure({ name: "notes.txt" })).toBeNull()
  })
})
