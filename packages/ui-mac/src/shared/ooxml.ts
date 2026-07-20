// REQ-093(#281):one strict OOXML/ZIP interpretation shared by renderer hints and the main gate.
// Raw EOCD, central-directory, and local-header structure is validated before zip.js is loaded.
// zip.js is used only as a bounded inflater after its view is proven identical to this canonical view.

import type { Entry } from "@zip.js/zip.js"

export const OOXML_LIMITS = {
  maxCompressedBytes: 20 * 1024 * 1024,
  maxEntries: 512,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxContentTypesBytes: 256 * 1024,
  maxRelationshipsBytes: 256 * 1024,
  maxEntryNameBytes: 1024,
  maxCompressionRatio: 200,
  maxInflateMilliseconds: 5_000,
  maxInflateInputChunkBytes: 16 * 1024,
  // DEFLATE can emit at most 1,032 output bytes per compressed byte;the extra byte covers a
  // partially buffered symbol at an append boundary. One fallback delivery is therefore bounded
  // by 16,909,320 bytes. While zip.js joins its fragments, live unchecked inflated storage is at
  // most fragments + result + its 32 KiB reusable buffer = 33,851,408 bytes. The sink checks every
  // delivery before accepting another compressed chunk.
  maxInflateDeliveryBytes: (16 * 1024 + 1) * 1_032,
  maxUncheckedInflateMaterializedBytes: 2 * ((16 * 1024 + 1) * 1_032) + 2 * 16 * 1024,
} as const

export const OOXML_SUBTYPES = {
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mainPart: "word/document.xml",
    mainContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    mainPart: "xl/workbook.xml",
    mainContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mainPart: "ppt/presentation.xml",
    mainContentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  },
} as const

export type OoxmlSubtype = keyof typeof OOXML_SUBTYPES

export type OoxmlErrorCode =
  | "NOT_ZIP"
  | "ZIP_COMPRESSED_LIMIT"
  | "ZIP_PREFLIGHT_TIMEOUT"
  | "ZIP_EOCD_MISSING"
  | "ZIP_EOCD_MULTIPLE"
  | "ZIP_EOCD_WINDOW"
  | "ZIP_EOCD_COMMENT_LENGTH"
  | "ZIP64_ARCHIVE"
  | "ZIP64_ENTRY"
  | "ZIP_SPLIT_ARCHIVE"
  | "ZIP_CENTRAL_BOUNDS"
  | "ZIP_CENTRAL_SIGNATURE"
  | "ZIP_CENTRAL_COUNT"
  | "ZIP_CENTRAL_NOT_CONSUMED"
  | "ZIP_EMPTY"
  | "ZIP_ENTRY_LIMIT"
  | "ZIP_ENTRY_NAME_LENGTH"
  | "ZIP_ENTRY_NAME_ENCODING"
  | "ZIP_ENTRY_PATH"
  | "ZIP_DUPLICATE_ENTRY"
  | "ZIP_ENCRYPTED"
  | "ZIP_DATA_DESCRIPTOR"
  | "ZIP_UNSUPPORTED_FLAGS"
  | "ZIP_UNSUPPORTED_VERSION"
  | "ZIP_UNSUPPORTED_COMPRESSION"
  | "ZIP_SPLIT_ENTRY"
  | "ZIP_SYMLINK_ENTRY"
  | "ZIP_EXTRA_FIELD_MALFORMED"
  | "ZIP_UNICODE_PATH_EXTRA"
  | "ZIP_DIRECTORY_DATA"
  | "ZIP_STORED_SIZE_MISMATCH"
  | "ZIP_DECLARED_ENTRY_LIMIT"
  | "ZIP_DECLARED_TOTAL_LIMIT"
  | "ZIP_DECLARED_RATIO_LIMIT"
  | "ZIP_LOCAL_HEADER_BOUNDS"
  | "ZIP_LOCAL_HEADER_SIGNATURE"
  | "ZIP_LOCAL_HEADER_MISMATCH"
  | "ZIP_ENTRY_OVERLAP"
  | "ZIP_PREPENDED_DATA"
  | "ZIP_ADDITIONAL_DATA"
  | "ZIP_LIBRARY_MISMATCH"
  | "ZIP_ENTRY_UNREADABLE"
  | "ZIP_INFLATE_ENTRY_LIMIT"
  | "ZIP_INFLATE_TOTAL_LIMIT"
  | "ZIP_INFLATE_RATIO_LIMIT"
  | "ZIP_INFLATE_INPUT_LIMIT"
  | "ZIP_INFLATE_TIMEOUT"
  | "ZIP_INFLATE_SIZE_MISMATCH"
  | "ZIP_DECOMPRESSION_FAILED"
  | "CONTENT_TYPES_MISSING"
  | "CONTENT_TYPES_NOT_FILE"
  | "CONTENT_TYPES_DECLARED_LIMIT"
  | "CONTENT_TYPES_INFLATE_LIMIT"
  | "CONTENT_TYPES_INVALID_UTF8"
  | "CONTENT_TYPES_INVALID_XML"
  | "CONTENT_TYPES_UNSAFE_PART"
  | "CONTENT_TYPES_DUPLICATE_OVERRIDE"
  | "OOXML_MAIN_DECLARATION_MISSING"
  | "OOXML_MAIN_DECLARATION_AMBIGUOUS"
  | "OOXML_MAIN_PART_MISSING"
  | "OOXML_MAIN_PART_DIRECTORY"
  | "OOXML_MAIN_PART_CONFLICT"
  | "ROOT_RELS_MISSING"
  | "ROOT_RELS_NOT_FILE"
  | "ROOT_RELS_DECLARED_LIMIT"
  | "ROOT_RELS_INFLATE_LIMIT"
  | "ROOT_RELS_INVALID_UTF8"
  | "ROOT_RELS_INVALID_XML"
  | "ROOT_RELS_OFFICE_DOCUMENT_COUNT"
  | "ROOT_RELS_EXTERNAL_TARGET"
  | "ROOT_RELS_UNSAFE_TARGET"
  | "ROOT_RELS_TARGET_MISMATCH"

export type OoxmlDetection =
  | {
      status: "detected"
      subtype: OoxmlSubtype
      mime: (typeof OOXML_SUBTYPES)[OoxmlSubtype]["mime"]
      entryCount: number
      uncompressedBytes: number
    }
  | { status: "not-ooxml"; code: OoxmlErrorCode; reason: string }
  | { status: "rejected"; code: OoxmlErrorCode; reason: string }

export type OoxmlClaimInput = {
  name: string
  claimedMime?: string | null
  detectedMime?: string | null
}

export type OoxmlDetectionOptions = {
  /** Test/diagnostic observation after each bounded compressed-input delivery, before fallback inflate. */
  onInflateInput?: (input: { filename: string; compressedBytes: number }) => void
}

const CONTENT_TYPES_NAME = "[Content_Types].xml"
const ROOT_RELS_NAME = "_rels/.rels"
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
const OFFICE_DOCUMENT_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD_LENGTH = 22
const MAX_ZIP_COMMENT = 65_535
const FLAG_ENCRYPTED = 1 << 0
const FLAG_DATA_DESCRIPTOR = 1 << 3
const FLAG_UTF8 = 1 << 11
const SUPPORTED_FLAGS = (1 << 1) | (1 << 2) | FLAG_UTF8
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8])
const CP437 = Array.from(
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
)

// Single authority for native Word/Excel/PowerPoint formats that the OS may hand to Office.
// Rows follow Microsoft's supported file-format tables and IANA's registered Office media types.
// Legacy compiled add-ins have no dedicated registered media type, so they retain the family MIME;
// extension matching remains independently authoritative. Only docx/xlsx/pptx can ever pass after
// byte-level OOXML proof; every other row is deliberately denied external-open fallback.
export const OFFICE_OPEN_GATE_FORMATS = [
  { family: "word", kind: "document", extension: "docx", mime: OOXML_SUBTYPES.docx.mime },
  { family: "word", kind: "template", extension: "dotx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.template" },
  { family: "word", kind: "macro-document", extension: "docm", mime: "application/vnd.ms-word.document.macroEnabled.12" },
  { family: "word", kind: "macro-template", extension: "dotm", mime: "application/vnd.ms-word.template.macroEnabled.12" },
  { family: "word", kind: "legacy-binary-document", extension: "doc", mime: "application/msword" },
  { family: "word", kind: "legacy-binary-template", extension: "dot", mime: "application/msword" },
  { family: "word", kind: "legacy-binary-addin", extension: "wll", mime: "application/msword" },
  { family: "excel", kind: "workbook", extension: "xlsx", mime: OOXML_SUBTYPES.xlsx.mime },
  { family: "excel", kind: "template", extension: "xltx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.template" },
  { family: "excel", kind: "macro-workbook", extension: "xlsm", mime: "application/vnd.ms-excel.sheet.macroEnabled.12" },
  { family: "excel", kind: "macro-template", extension: "xltm", mime: "application/vnd.ms-excel.template.macroEnabled.12" },
  { family: "excel", kind: "macro-addin", extension: "xlam", mime: "application/vnd.ms-excel.addin.macroEnabled.12" },
  { family: "excel", kind: "binary-workbook", extension: "xlsb", mime: "application/vnd.ms-excel.sheet.binary.macroEnabled.12" },
  { family: "excel", kind: "legacy-binary-workbook", extension: "xls", mime: "application/vnd.ms-excel" },
  { family: "excel", kind: "legacy-binary-template", extension: "xlt", mime: "application/vnd.ms-excel" },
  { family: "excel", kind: "legacy-binary-addin", extension: "xla", mime: "application/vnd.ms-excel" },
  { family: "excel", kind: "legacy-binary-workbook", extension: "xlw", mime: "application/vnd.ms-excel" },
  { family: "excel", kind: "legacy-macro-sheet", extension: "xlm", mime: "application/vnd.ms-excel" },
  { family: "excel", kind: "compiled-addin", extension: "xll", mime: "application/vnd.ms-excel" },
  { family: "powerpoint", kind: "presentation", extension: "pptx", mime: OOXML_SUBTYPES.pptx.mime },
  { family: "powerpoint", kind: "template", extension: "potx", mime: "application/vnd.openxmlformats-officedocument.presentationml.template" },
  { family: "powerpoint", kind: "slideshow", extension: "ppsx", mime: "application/vnd.openxmlformats-officedocument.presentationml.slideshow" },
  { family: "powerpoint", kind: "slide", extension: "sldx", mime: "application/vnd.openxmlformats-officedocument.presentationml.slide" },
  { family: "powerpoint", kind: "theme", extension: "thmx", mime: "application/vnd.ms-officetheme" },
  { family: "powerpoint", kind: "macro-presentation", extension: "pptm", mime: "application/vnd.ms-powerpoint.presentation.macroEnabled.12" },
  { family: "powerpoint", kind: "macro-template", extension: "potm", mime: "application/vnd.ms-powerpoint.template.macroEnabled.12" },
  { family: "powerpoint", kind: "macro-slideshow", extension: "ppsm", mime: "application/vnd.ms-powerpoint.slideshow.macroEnabled.12" },
  { family: "powerpoint", kind: "macro-slide", extension: "sldm", mime: "application/vnd.ms-powerpoint.slide.macroEnabled.12" },
  { family: "powerpoint", kind: "macro-addin", extension: "ppam", mime: "application/vnd.ms-powerpoint.addin.macroEnabled.12" },
  { family: "powerpoint", kind: "legacy-binary-presentation", extension: "ppt", mime: "application/vnd.ms-powerpoint" },
  { family: "powerpoint", kind: "legacy-binary-template", extension: "pot", mime: "application/vnd.ms-powerpoint" },
  { family: "powerpoint", kind: "legacy-binary-slideshow", extension: "pps", mime: "application/vnd.ms-powerpoint" },
  { family: "powerpoint", kind: "legacy-binary-addin", extension: "ppa", mime: "application/vnd.ms-powerpoint" },
] as const

const OFFICE_GATE_EXTENSIONS = new Set<string>(OFFICE_OPEN_GATE_FORMATS.map((format) => format.extension))
const OFFICE_GATE_MIMES = new Set<string>(OFFICE_OPEN_GATE_FORMATS.map((format) => format.mime.toLowerCase()))
const ZIP_GATE_EXTENSIONS = new Set<string>(["zip"])
const ZIP_GATE_MIMES = new Set<string>(["application/zip", "application/x-zip-compressed", "multipart/x-zip"])

const NEUTRAL_CONTAINER_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "multipart/x-zip",
  "application/octet-stream",
])

type CanonicalEntry = {
  filename: string
  rawFilename: Uint8Array
  rawExtraField: Uint8Array
  versionMadeBy: number
  versionNeeded: number
  flags: number
  compressionMethod: number
  modificationTime: number
  modificationDate: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  diskNumberStart: number
  externalFileAttributes: number
  localHeaderOffset: number
  directory: boolean
}

type PreflightResult =
  | { ok: true; entries: CanonicalEntry[] }
  | { ok: false; detection: Exclude<OoxmlDetection, { status: "detected" }> }

class OoxmlLimitError extends Error {
  constructor(readonly code: OoxmlErrorCode, message: string) {
    super(message)
  }
}

/** True whenever a ZIP/Office claim must not reach a privileged external consumer without this gate. */
export function shouldGateOoxml(input: OoxmlClaimInput): boolean {
  const extension = extensionOf(input.name)
  if (extension && (OFFICE_GATE_EXTENSIONS.has(extension) || ZIP_GATE_EXTENSIONS.has(extension))) return true
  return [normalizeMime(input.claimedMime), normalizeMime(input.detectedMime)].some(
    (mime) => mime !== null && (OFFICE_GATE_MIMES.has(mime) || ZIP_GATE_MIMES.has(mime)),
  )
}

/** Shared claim check used by renderer routing and independently by the main external-open gate. */
export function ooxmlOpenConflicts(input: OoxmlClaimInput, detection: OoxmlDetection): string[] {
  if (detection.status !== "detected") return [detection.code]
  const extension = extensionOf(input.name)
  const claimed = normalizeMime(input.claimedMime)
  const detected = normalizeMime(input.detectedMime)
  return [
    extension !== detection.subtype ? `extension:${extension ?? "none"}` : null,
    claimed && claimed !== detection.mime && !NEUTRAL_CONTAINER_MIMES.has(claimed) ? `claimed-mime:${claimed}` : null,
    detected && detected !== detection.mime && !NEUTRAL_CONTAINER_MIMES.has(detected) ? `detected-mime:${detected}` : null,
  ].filter((value): value is string => value !== null)
}

export function isPrivilegedOoxmlOpen(input: OoxmlClaimInput, detection: OoxmlDetection): boolean {
  return detection.status === "detected" && ooxmlOpenConflicts(input, detection).length === 0
}

/** Detect docx/xlsx/pptx from canonical ZIP bytes. All malformed, ambiguous, or over-limit input fails closed. */
export async function detectOoxmlContainer(
  bytes: Uint8Array,
  options: OoxmlDetectionOptions = {},
): Promise<OoxmlDetection> {
  if (bytes.byteLength > OOXML_LIMITS.maxCompressedBytes)
    return rejected("ZIP_COMPRESSED_LIMIT", `${bytes.byteLength} > ${OOXML_LIMITS.maxCompressedBytes}`)

  const deadline = now() + OOXML_LIMITS.maxInflateMilliseconds
  const preflight = preflightZip(bytes, deadline)
  if (!preflight.ok) return preflight.detection

  const contentTypes = preflight.entries.find((entry) => entry.filename === CONTENT_TYPES_NAME)
  if (!contentTypes) return notOoxml("CONTENT_TYPES_MISSING")
  if (contentTypes.directory) return rejected("CONTENT_TYPES_NOT_FILE")
  const rootRels = preflight.entries.find((entry) => entry.filename === ROOT_RELS_NAME)
  if (!rootRels) return rejected("ROOT_RELS_MISSING")
  if (rootRels.directory) return rejected("ROOT_RELS_NOT_FILE")

  let reader: { close: () => Promise<void> } | undefined
  let limitError: OoxmlLimitError | undefined
  try {
    if (now() > deadline) throw new OoxmlLimitError("ZIP_INFLATE_TIMEOUT", "budget exhausted before inflate")
    const { Uint8ArrayReader, ZipReader, configure } = await import("@zip.js/zip.js")
    // zip.js otherwise aggregates reader chunks to its 512 KiB global default before the fallback's
    // synchronous Inflate.append(). Pinning both the public chunk configuration and fallback path
    // limits one unchecked append to OOXML_LIMITS.maxInflateDeliveryBytes and transient fallback
    // storage to OOXML_LIMITS.maxUncheckedInflateMaterializedBytes. The sink checks that delivery
    // before the pipeline can accept another compressed chunk;time can overrun by one bounded
    // append, then the same boundary returns ZIP_INFLATE_TIMEOUT.
    configure({ chunkSize: OOXML_LIMITS.maxInflateInputChunkBytes })
    const zipReader = new ZipReader(new Uint8ArrayReader(bytes), {
      useWebWorkers: false,
      decodeText: (value, encoding) => {
        if (encoding === "utf-8") {
          const decoded = decodeUtf8(value)
          if (decoded === null) throw new Error("invalid UTF-8 filename")
          return decoded
        }
        return decodeCp437(value)
      },
    })
    reader = zipReader
    const entries = await zipReader.getEntries()
    if (!sameLibraryView(entries, preflight.entries)) return rejected("ZIP_LIBRARY_MISMATCH")

    let total = 0
    const retained = new Map<string, Uint8Array>()
    for (let index = 0; index < entries.length; index++) {
      const canonical = preflight.entries[index]
      if (canonical.directory) continue
      const entry = entries[index]
      if (!entry.getData) return rejected("ZIP_ENTRY_UNREADABLE", canonical.filename)
      const perEntryLimit =
        canonical.filename === CONTENT_TYPES_NAME
          ? OOXML_LIMITS.maxContentTypesBytes
          : canonical.filename === ROOT_RELS_NAME
            ? OOXML_LIMITS.maxRelationshipsBytes
            : OOXML_LIMITS.maxEntryUncompressedBytes
      const perEntryCode =
        canonical.filename === CONTENT_TYPES_NAME
          ? "CONTENT_TYPES_INFLATE_LIMIT" as const
          : canonical.filename === ROOT_RELS_NAME
            ? "ROOT_RELS_INFLATE_LIMIT" as const
            : "ZIP_INFLATE_ENTRY_LIMIT" as const
      const chunks: Uint8Array[] = []
      const abort = new AbortController()
      if (now() > deadline) return rejected("ZIP_INFLATE_TIMEOUT", canonical.filename)
      const timer = setTimeout(() => {
        limitError = new OoxmlLimitError("ZIP_INFLATE_TIMEOUT", canonical.filename)
        abort.abort("ZIP_INFLATE_TIMEOUT")
      }, Math.max(0, deadline - now()))
      let count = 0
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          count += chunk.byteLength
          total += chunk.byteLength
          const code =
            now() > deadline
              ? "ZIP_INFLATE_TIMEOUT"
              : count > perEntryLimit
                ? perEntryCode
                : total > OOXML_LIMITS.maxUncompressedBytes
                  ? "ZIP_INFLATE_TOTAL_LIMIT"
                  : exceedsRatio(count, canonical.compressedSize)
                    ? "ZIP_INFLATE_RATIO_LIMIT"
                    : null
          if (code) {
            abort.abort(code)
            limitError = new OoxmlLimitError(code, canonical.filename)
            throw limitError
          }
          if (canonical.filename === CONTENT_TYPES_NAME || canonical.filename === ROOT_RELS_NAME)
            chunks.push(chunk.slice())
        },
      })
      try {
        let compressedRead = 0
        await entry.getData(writable, {
          checkSignature: true,
          signal: abort.signal,
          useWebWorkers: false,
          useCompressionStream: false,
          async onprogress(compressedBytes) {
            if (compressedBytes - compressedRead > OOXML_LIMITS.maxInflateInputChunkBytes) {
              limitError = new OoxmlLimitError("ZIP_INFLATE_INPUT_LIMIT", canonical.filename)
              abort.abort("ZIP_INFLATE_INPUT_LIMIT")
              throw limitError
            }
            compressedRead = compressedBytes
            if (now() > deadline) {
              limitError = new OoxmlLimitError("ZIP_INFLATE_TIMEOUT", canonical.filename)
              abort.abort("ZIP_INFLATE_TIMEOUT")
              throw limitError
            }
            options.onInflateInput?.({ filename: canonical.filename, compressedBytes })
          },
        })
      } finally {
        clearTimeout(timer)
      }
      if (now() > deadline) return rejected("ZIP_INFLATE_TIMEOUT", canonical.filename)
      if (count !== canonical.uncompressedSize)
        return rejected("ZIP_INFLATE_SIZE_MISMATCH", `${canonical.filename}:${count} != ${canonical.uncompressedSize}`)
      if (chunks.length > 0 || count === 0) retained.set(canonical.filename, concatenate(chunks, count))
    }

    const overrides = parseContentTypeOverrides(retained.get(CONTENT_TYPES_NAME)!)
    if (!overrides.ok) return overrides.detection
    const declared = Object.entries(OOXML_SUBTYPES).filter(([, facts]) =>
      overrides.values.some((override) => override.partName === `/${facts.mainPart}` && override.contentType === facts.mainContentType),
    ) as Array<[OoxmlSubtype, (typeof OOXML_SUBTYPES)[OoxmlSubtype]]>
    if (declared.length === 0) return notOoxml("OOXML_MAIN_DECLARATION_MISSING")
    if (declared.length !== 1) return rejected("OOXML_MAIN_DECLARATION_AMBIGUOUS")

    const subtype = declared[0][0]
    const facts = OOXML_SUBTYPES[subtype]
    const mainPart = preflight.entries.find((entry) => entry.filename === facts.mainPart)
    if (!mainPart) return rejected("OOXML_MAIN_PART_MISSING", facts.mainPart)
    if (mainPart.directory) return rejected("OOXML_MAIN_PART_DIRECTORY", facts.mainPart)
    if (Object.values(OOXML_SUBTYPES).some((candidate) =>
      candidate.mainPart !== facts.mainPart && preflight.entries.some((entry) => entry.filename === candidate.mainPart)))
      return rejected("OOXML_MAIN_PART_CONFLICT")

    const relationship = parseRootRelationship(retained.get(ROOT_RELS_NAME)!)
    if (!relationship.ok) return relationship.detection
    if (relationship.target !== facts.mainPart)
      return rejected("ROOT_RELS_TARGET_MISMATCH", `${relationship.target} != ${facts.mainPart}`)

    return {
      status: "detected",
      subtype,
      mime: facts.mime,
      entryCount: preflight.entries.length,
      uncompressedBytes: total,
    }
  } catch (error) {
    if (limitError) return rejected(limitError.code, limitError.message)
    if (error instanceof OoxmlLimitError) return rejected(error.code, error.message)
    return rejected("ZIP_DECOMPRESSION_FAILED", error instanceof Error ? error.message : undefined)
  } finally {
    if (reader) await reader.close().catch(() => undefined)
  }
}

function preflightZip(bytes: Uint8Array, deadline: number): PreflightResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffsets: number[] = []
  let hasZip64 = false
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset++) {
    if ((offset & 0xffff) === 0 && now() > deadline)
      return { ok: false, detection: rejected("ZIP_PREFLIGHT_TIMEOUT") }
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b) continue
    const signature = view.getUint32(offset, true)
    if (signature === EOCD_SIGNATURE) eocdOffsets.push(offset)
    if (signature === ZIP64_EOCD_SIGNATURE || signature === ZIP64_LOCATOR_SIGNATURE) hasZip64 = true
  }
  if (hasZip64) return { ok: false, detection: rejected("ZIP64_ARCHIVE") }
  if (eocdOffsets.length === 0) {
    const looksZip = bytes.byteLength >= 4 && (view.getUint32(0, true) === LOCAL_FILE_HEADER_SIGNATURE || view.getUint32(0, true) === 0x08074b50)
    return { ok: false, detection: looksZip ? rejected("ZIP_EOCD_MISSING") : notOoxml("NOT_ZIP") }
  }
  if (eocdOffsets.length !== 1) return { ok: false, detection: rejected("ZIP_EOCD_MULTIPLE") }

  const eocdOffset = eocdOffsets[0]
  if (eocdOffset < Math.max(0, bytes.byteLength - EOCD_LENGTH - MAX_ZIP_COMMENT))
    return { ok: false, detection: rejected("ZIP_EOCD_WINDOW") }
  if (eocdOffset + EOCD_LENGTH > bytes.byteLength)
    return { ok: false, detection: rejected("ZIP_EOCD_COMMENT_LENGTH") }
  const commentLength = view.getUint16(eocdOffset + 20, true)
  if (eocdOffset + EOCD_LENGTH + commentLength !== bytes.byteLength)
    return { ok: false, detection: rejected("ZIP_EOCD_COMMENT_LENGTH") }

  const diskNumber = view.getUint16(eocdOffset + 4, true)
  const centralDisk = view.getUint16(eocdOffset + 6, true)
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true)
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralSize = view.getUint32(eocdOffset + 12, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)
  if (diskNumber === 0xffff || centralDisk === 0xffff || entriesOnDisk === 0xffff || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    return { ok: false, detection: rejected("ZIP64_ARCHIVE") }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount)
    return { ok: false, detection: rejected("ZIP_SPLIT_ARCHIVE") }
  if (centralOffset > eocdOffset || centralSize > eocdOffset || centralOffset + centralSize !== eocdOffset)
    return { ok: false, detection: rejected("ZIP_CENTRAL_BOUNDS") }

  const entries: CanonicalEntry[] = []
  const seen = new Set<string>()
  let declaredTotal = 0
  let offset = centralOffset
  const centralEnd = centralOffset + centralSize
  while (offset < centralEnd) {
    if (entries.length === OOXML_LIMITS.maxEntries)
      return { ok: false, detection: rejected("ZIP_ENTRY_LIMIT", String(OOXML_LIMITS.maxEntries)) }
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER_SIGNATURE)
      return { ok: false, detection: rejected("ZIP_CENTRAL_SIGNATURE") }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const entryCommentLength = view.getUint16(offset + 32, true)
    const end = offset + 46 + nameLength + extraLength + entryCommentLength
    if (end > centralEnd) return { ok: false, detection: rejected("ZIP_CENTRAL_BOUNDS") }
    if (nameLength === 0 || nameLength > OOXML_LIMITS.maxEntryNameBytes)
      return { ok: false, detection: rejected("ZIP_ENTRY_NAME_LENGTH", String(nameLength)) }

    const flags = view.getUint16(offset + 8, true)
    const rawFilename = bytes.slice(offset + 46, offset + 46 + nameLength)
    const filename = flags & FLAG_UTF8 ? decodeUtf8(rawFilename) : decodeCp437(rawFilename)
    if (filename === null) return { ok: false, detection: rejected("ZIP_ENTRY_NAME_ENCODING") }
    const rawComment = bytes.subarray(offset + 46 + nameLength + extraLength, end)
    if ((flags & FLAG_UTF8) !== 0 && decodeUtf8(rawComment) === null)
      return { ok: false, detection: rejected("ZIP_ENTRY_NAME_ENCODING", filename) }
    const unsafe = unsafeEntryCode(filename)
    if (unsafe) return { ok: false, detection: rejected(unsafe, filename) }
    const identity = filename.replace(/\/$/, "").toLowerCase()
    if (seen.has(identity)) return { ok: false, detection: rejected("ZIP_DUPLICATE_ENTRY", filename) }
    seen.add(identity)

    if ((flags & FLAG_ENCRYPTED) !== 0) return { ok: false, detection: rejected("ZIP_ENCRYPTED", filename) }
    if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) return { ok: false, detection: rejected("ZIP_DATA_DESCRIPTOR", filename) }
    if ((flags & ~SUPPORTED_FLAGS) !== 0) return { ok: false, detection: rejected("ZIP_UNSUPPORTED_FLAGS", filename) }
    const versionMadeBy = view.getUint16(offset + 4, true)
    const versionNeeded = view.getUint16(offset + 6, true)
    if ((versionNeeded & 0xff) > 20) return { ok: false, detection: rejected("ZIP_UNSUPPORTED_VERSION", filename) }
    const compressionMethod = view.getUint16(offset + 10, true)
    if (!SUPPORTED_COMPRESSION_METHODS.has(compressionMethod))
      return { ok: false, detection: rejected("ZIP_UNSUPPORTED_COMPRESSION", filename) }
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const diskNumberStart = view.getUint16(offset + 34, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff)
      return { ok: false, detection: rejected("ZIP64_ENTRY", filename) }
    if (diskNumberStart === 0xffff) return { ok: false, detection: rejected("ZIP64_ENTRY", filename) }
    if (diskNumberStart !== 0) return { ok: false, detection: rejected("ZIP_SPLIT_ENTRY", filename) }
    const extra = validateExtraField(bytes.slice(offset + 46 + nameLength, offset + 46 + nameLength + extraLength))
    if (!extra.ok) return { ok: false, detection: rejected(extra.code, filename) }
    const externalFileAttributes = view.getUint32(offset + 38, true)
    const platform = versionMadeBy >>> 8
    if (platform === 3 && ((externalFileAttributes >>> 16) & 0xf000) === 0xa000)
      return { ok: false, detection: rejected("ZIP_SYMLINK_ENTRY", filename) }
    const directory =
      filename.endsWith("/") ||
      (platform === 0 && (externalFileAttributes & 0x10) !== 0) ||
      (platform === 3 && ((externalFileAttributes >>> 16) & 0xf000) === 0x4000)
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0))
      return { ok: false, detection: rejected("ZIP_DIRECTORY_DATA", filename) }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize)
      return { ok: false, detection: rejected("ZIP_STORED_SIZE_MISMATCH", filename) }
    const declaredCode =
      filename === CONTENT_TYPES_NAME && uncompressedSize > OOXML_LIMITS.maxContentTypesBytes
        ? "CONTENT_TYPES_DECLARED_LIMIT" as const
        : filename === ROOT_RELS_NAME && uncompressedSize > OOXML_LIMITS.maxRelationshipsBytes
          ? "ROOT_RELS_DECLARED_LIMIT" as const
          : uncompressedSize > OOXML_LIMITS.maxEntryUncompressedBytes
            ? "ZIP_DECLARED_ENTRY_LIMIT" as const
            : exceedsRatio(uncompressedSize, compressedSize)
              ? "ZIP_DECLARED_RATIO_LIMIT" as const
              : null
    if (declaredCode) return { ok: false, detection: rejected(declaredCode, filename) }
    declaredTotal += uncompressedSize
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > OOXML_LIMITS.maxUncompressedBytes)
      return { ok: false, detection: rejected("ZIP_DECLARED_TOTAL_LIMIT") }

    entries.push({
      filename,
      rawFilename,
      rawExtraField: extra.raw,
      versionMadeBy,
      versionNeeded,
      flags,
      compressionMethod,
      modificationTime: view.getUint16(offset + 12, true),
      modificationDate: view.getUint16(offset + 14, true),
      crc32: view.getUint32(offset + 16, true),
      compressedSize,
      uncompressedSize,
      diskNumberStart,
      externalFileAttributes,
      localHeaderOffset,
      directory,
    })
    offset = end
  }
  if (offset !== centralEnd) return { ok: false, detection: rejected("ZIP_CENTRAL_NOT_CONSUMED") }
  if (entries.length !== entryCount) return { ok: false, detection: rejected("ZIP_CENTRAL_COUNT") }
  if (entries.length === 0) return { ok: false, detection: rejected("ZIP_EMPTY") }

  const ranges: Array<{ start: number; end: number }> = []
  for (const entry of entries) {
    const local = entry.localHeaderOffset
    if (local + 30 > centralOffset) return { ok: false, detection: rejected("ZIP_LOCAL_HEADER_BOUNDS", entry.filename) }
    if (view.getUint32(local, true) !== LOCAL_FILE_HEADER_SIGNATURE)
      return { ok: false, detection: rejected("ZIP_LOCAL_HEADER_SIGNATURE", entry.filename) }
    const localNameLength = view.getUint16(local + 26, true)
    const localExtraLength = view.getUint16(local + 28, true)
    const dataOffset = local + 30 + localNameLength + localExtraLength
    const dataEnd = dataOffset + entry.compressedSize
    if (dataOffset > centralOffset || dataEnd > centralOffset)
      return { ok: false, detection: rejected("ZIP_LOCAL_HEADER_BOUNDS", entry.filename) }
    const localName = bytes.slice(local + 30, local + 30 + localNameLength)
    const localExtra = bytes.slice(local + 30 + localNameLength, dataOffset)
    const parsedExtra = validateExtraField(localExtra)
    if (!parsedExtra.ok) return { ok: false, detection: rejected(parsedExtra.code, entry.filename) }
    const mismatch =
      view.getUint16(local + 4, true) !== entry.versionNeeded ||
      view.getUint16(local + 6, true) !== entry.flags ||
      view.getUint16(local + 8, true) !== entry.compressionMethod ||
      view.getUint16(local + 10, true) !== entry.modificationTime ||
      view.getUint16(local + 12, true) !== entry.modificationDate ||
      view.getUint32(local + 14, true) !== entry.crc32 ||
      view.getUint32(local + 18, true) !== entry.compressedSize ||
      view.getUint32(local + 22, true) !== entry.uncompressedSize ||
      !sameBytes(localName, entry.rawFilename) ||
      !sameBytes(localExtra, entry.rawExtraField)
    if (mismatch) return { ok: false, detection: rejected("ZIP_LOCAL_HEADER_MISMATCH", entry.filename) }
    ranges.push({ start: local, end: dataEnd })
  }
  ranges.sort((left, right) => left.start - right.start)
  if (ranges[0].start !== 0) return { ok: false, detection: rejected("ZIP_PREPENDED_DATA") }
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start < ranges[index - 1].end)
      return { ok: false, detection: rejected("ZIP_ENTRY_OVERLAP") }
    if (ranges[index].start !== ranges[index - 1].end)
      return { ok: false, detection: rejected("ZIP_ADDITIONAL_DATA") }
  }
  if (ranges[ranges.length - 1].end !== centralOffset)
    return { ok: false, detection: rejected("ZIP_ADDITIONAL_DATA") }
  return { ok: true, entries }
}

function validateExtraField(raw: Uint8Array):
  | { ok: true; raw: Uint8Array }
  | { ok: false; code: "ZIP64_ENTRY" | "ZIP_EXTRA_FIELD_MALFORMED" | "ZIP_UNICODE_PATH_EXTRA" } {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const seen = new Set<number>()
  let offset = 0
  while (offset < raw.byteLength) {
    if (offset + 4 > raw.byteLength) return { ok: false, code: "ZIP_EXTRA_FIELD_MALFORMED" }
    const type = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    if (offset + 4 + size > raw.byteLength || seen.has(type)) return { ok: false, code: "ZIP_EXTRA_FIELD_MALFORMED" }
    if (type === 0x0001) return { ok: false, code: "ZIP64_ENTRY" }
    if (type === 0x7075) return { ok: false, code: "ZIP_UNICODE_PATH_EXTRA" }
    seen.add(type)
    offset += 4 + size
  }
  return { ok: true, raw }
}

function unsafeEntryCode(filename: string): "ZIP_ENTRY_PATH" | null {
  if (/[\\\u0000-\u001f\u007f]/.test(filename) || filename.startsWith("/") || /^[A-Za-z]:/.test(filename))
    return "ZIP_ENTRY_PATH"
  const path = filename.endsWith("/") ? filename.slice(0, -1) : filename
  const segments = path.split("/")
  return segments.some((segment) => segment === "" || segment === "." || segment === "..") ? "ZIP_ENTRY_PATH" : null
}

function sameLibraryView(entries: readonly Entry[], canonical: readonly CanonicalEntry[]): boolean {
  if (entries.length !== canonical.length) return false
  return entries.every((entry, index) => {
    const expected = canonical[index]
    return (
      entry.filename === expected.filename &&
      sameBytes(entry.rawFilename, expected.rawFilename) &&
      sameBytes(entry.rawExtraField, expected.rawExtraField) &&
      entry.offset === expected.localHeaderOffset &&
      entry.diskNumberStart === 0 &&
      entry.compressionMethod === expected.compressionMethod &&
      entry.signature === expected.crc32 &&
      entry.compressedSize === expected.compressedSize &&
      entry.uncompressedSize === expected.uncompressedSize &&
      entry.externalFileAttributes === expected.externalFileAttributes &&
      entry.directory === expected.directory &&
      entry.encrypted === false &&
      entry.filenameUTF8 === ((expected.flags & FLAG_UTF8) !== 0)
    )
  })
}

function parseContentTypeOverrides(bytes: Uint8Array):
  | { ok: true; values: Array<{ partName: string; contentType: string }> }
  | { ok: false; detection: Exclude<OoxmlDetection, { status: "detected" }> } {
  const decoded = decodeUtf8(bytes)
  if (decoded === null) return { ok: false, detection: rejected("CONTENT_TYPES_INVALID_UTF8") }
  const root = parseXmlRoot(decoded, "Types")
  if (!root || root.attributes.get("xmlns") !== CONTENT_TYPES_NAMESPACE)
    return { ok: false, detection: rejected("CONTENT_TYPES_INVALID_XML") }
  const tag = /<\s*(Default|Override)\b([^<>]*)\/\s*>/g
  const values: Array<{ partName: string; contentType: string }> = []
  let offset = 0
  for (const match of root.body.matchAll(tag)) {
    if (root.body.slice(offset, match.index).trim().length > 0)
      return { ok: false, detection: rejected("CONTENT_TYPES_INVALID_XML") }
    offset = match.index + match[0].length
    const attributes = parseAttributes(match[2])
    if (!attributes) return { ok: false, detection: rejected("CONTENT_TYPES_INVALID_XML") }
    if (match[1] === "Default") continue
    if (attributes.size !== 2 || !attributes.has("PartName") || !attributes.has("ContentType"))
      return { ok: false, detection: rejected("CONTENT_TYPES_INVALID_XML") }
    const partName = attributes.get("PartName")!
    if (!safePartName(partName)) return { ok: false, detection: rejected("CONTENT_TYPES_UNSAFE_PART") }
    if (values.some((value) => value.partName.toLowerCase() === partName.toLowerCase()))
      return { ok: false, detection: rejected("CONTENT_TYPES_DUPLICATE_OVERRIDE") }
    values.push({ partName, contentType: attributes.get("ContentType")! })
  }
  if (root.body.slice(offset).trim().length > 0)
    return { ok: false, detection: rejected("CONTENT_TYPES_INVALID_XML") }
  return { ok: true, values }
}

function parseRootRelationship(bytes: Uint8Array):
  | { ok: true; target: string }
  | { ok: false; detection: Exclude<OoxmlDetection, { status: "detected" }> } {
  const decoded = decodeUtf8(bytes)
  if (decoded === null) return { ok: false, detection: rejected("ROOT_RELS_INVALID_UTF8") }
  const root = parseXmlRoot(decoded, "Relationships")
  if (!root || root.attributes.get("xmlns") !== RELATIONSHIPS_NAMESPACE)
    return { ok: false, detection: rejected("ROOT_RELS_INVALID_XML") }
  const relationships: Array<Map<string, string>> = []
  const tag = /<\s*Relationship\b([^<>]*)\/\s*>/g
  let offset = 0
  for (const match of root.body.matchAll(tag)) {
    if (root.body.slice(offset, match.index).trim().length > 0)
      return { ok: false, detection: rejected("ROOT_RELS_INVALID_XML") }
    offset = match.index + match[0].length
    const attributes = parseAttributes(match[1])
    if (!attributes || !attributes.has("Id") || !attributes.has("Type") || !attributes.has("Target"))
      return { ok: false, detection: rejected("ROOT_RELS_INVALID_XML") }
    if ([...attributes.keys()].some((key) => !["Id", "Type", "Target", "TargetMode"].includes(key)))
      return { ok: false, detection: rejected("ROOT_RELS_INVALID_XML") }
    relationships.push(attributes)
  }
  if (root.body.slice(offset).trim().length > 0)
    return { ok: false, detection: rejected("ROOT_RELS_INVALID_XML") }
  const office = relationships.filter((relationship) => relationship.get("Type") === OFFICE_DOCUMENT_RELATIONSHIP)
  if (office.length !== 1) return { ok: false, detection: rejected("ROOT_RELS_OFFICE_DOCUMENT_COUNT") }
  if (office[0].has("TargetMode") && office[0].get("TargetMode") !== "Internal")
    return { ok: false, detection: rejected("ROOT_RELS_EXTERNAL_TARGET") }
  const target = normalizeRelationshipTarget(office[0].get("Target")!)
  if (target === null) return { ok: false, detection: rejected("ROOT_RELS_UNSAFE_TARGET") }
  return { ok: true, target }
}

function parseXmlRoot(source: string, name: string): { attributes: Map<string, string>; body: string } | null {
  if (/<!\s*(?:DOCTYPE|ENTITY)|<!\[CDATA\[/i.test(source)) return null
  const commentsRemoved = source.replace(/<!--[\s\S]*?-->/g, "")
  if (commentsRemoved.includes("<!--") || commentsRemoved.includes("-->")) return null
  const xml = commentsRemoved.replace(/<\?[\s\S]*?\?>/g, "")
  const root = xml.match(new RegExp(`^\\s*<${name}\\b([^<>]*)>([\\s\\S]*)<\\/${name}\\s*>\\s*$`))
  if (!root) return null
  const attributes = parseAttributes(root[1])
  return attributes ? { attributes, body: root[2] } : null
}

function parseAttributes(source: string): Map<string, string> | null {
  const attributes = new Map<string, string>()
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g
  let offset = 0
  for (const match of source.matchAll(pattern)) {
    if (source.slice(offset, match.index).trim().length > 0 || attributes.has(match[1])) return null
    const value = match[2].slice(1, -1)
    if (value.includes("&")) return null
    attributes.set(match[1], value)
    offset = match.index + match[0].length
  }
  return source.slice(offset).trim().length > 0 ? null : attributes
}

function safePartName(partName: string): boolean {
  if (!partName.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(partName)) return false
  const segments = partName.slice(1).split("/")
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function normalizeRelationshipTarget(target: string): string | null {
  if (!target || /[\\\u0000-\u001f\u007f?#%]/.test(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//"))
    return null
  const output: string[] = []
  const segments = (target.startsWith("/") ? target.slice(1) : target).split("/")
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      if (segment === "") return null
      continue
    }
    if (segment === "..") {
      if (output.length === 0) return null
      output.pop()
      continue
    }
    output.push(segment)
  }
  return output.length > 0 ? output.join("/") : null
}

function exceedsRatio(uncompressed: number, compressed: number): boolean {
  if (uncompressed === 0) return false
  return compressed === 0 || uncompressed > compressed * OOXML_LIMITS.maxCompressionRatio
}

function concatenate(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size)
  let offset = 0
  chunks.forEach((chunk) => {
    output.set(chunk, offset)
    offset += chunk.byteLength
  })
  return output
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function decodeCp437(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80]).join("")
}

function extensionOf(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name
  const index = base.lastIndexOf(".")
  return index <= 0 || index === base.length - 1 ? null : base.slice(index + 1).toLowerCase()
}

function normalizeMime(mime: string | null | undefined): string | null {
  if (typeof mime !== "string") return null
  const normalized = mime.split(";")[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized) ? normalized : null
}

function rejected(code: OoxmlErrorCode, detail?: string): Exclude<OoxmlDetection, { status: "detected" | "not-ooxml" }> {
  return { status: "rejected", code, reason: detail ? `${code}:${detail}` : code }
}

function notOoxml(code: OoxmlErrorCode, detail?: string): Exclude<OoxmlDetection, { status: "detected" | "rejected" }> {
  return { status: "not-ooxml", code, reason: detail ? `${code}:${detail}` : code }
}

function now(): number {
  return performance.now()
}
