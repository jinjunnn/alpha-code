import {
  ooxmlOpenConflicts,
  shouldGateOoxml,
  type OoxmlClaimInput,
  type OoxmlDetection,
  type OoxmlErrorCode,
  type OoxmlSubtype,
} from "./ooxml"

export type OfficeRejectionCategory =
  | "invalid-document"
  | "encrypted"
  | "safety-limit"
  | "unsafe-path"
  | "incomplete-structure"
  | "type-mismatch"

export type OfficeStructurePresentation =
  | { status: "checking"; quickLook: false }
  | { status: "pass"; quickLook: true; subtype: OoxmlSubtype }
  | {
      status: "rejected"
      quickLook: false
      category: OfficeRejectionCategory
      code: OoxmlErrorCode | "OOXML_CLAIM_CONFLICT"
    }

export function presentOfficeStructure(
  input: OoxmlClaimInput & { detection?: OoxmlDetection },
): OfficeStructurePresentation | null {
  if (!shouldGateOoxml(input)) return null
  if (!input.detection) return { status: "checking", quickLook: false }
  if (input.detection.status !== "detected")
    return {
      status: "rejected",
      quickLook: false,
      category: rejectionCategory(input.detection.code),
      code: input.detection.code,
    }
  if (ooxmlOpenConflicts(input, input.detection).length > 0)
    return {
      status: "rejected",
      quickLook: false,
      category: "type-mismatch",
      code: "OOXML_CLAIM_CONFLICT",
    }
  return { status: "pass", quickLook: true, subtype: input.detection.subtype }
}

function rejectionCategory(code: OoxmlErrorCode): OfficeRejectionCategory {
  if (code === "ZIP_ENCRYPTED") return "encrypted"
  if (code.includes("LIMIT") || code.includes("TIMEOUT")) return "safety-limit"
  if (
    code === "ZIP_ENTRY_PATH" ||
    code === "ZIP_SYMLINK_ENTRY" ||
    code === "CONTENT_TYPES_UNSAFE_PART" ||
    code === "ROOT_RELS_EXTERNAL_TARGET" ||
    code === "ROOT_RELS_UNSAFE_TARGET"
  )
    return "unsafe-path"
  if (
    code.startsWith("CONTENT_TYPES_") ||
    code.startsWith("OOXML_MAIN_") ||
    code.startsWith("ROOT_RELS_")
  )
    return "incomplete-structure"
  return "invalid-document"
}
