// REQ-093(#281):OOXML container subtype detection.
//
// This module is deterministic and IO-free:the caller supplies the complete, already bounded
// artifact bytes. Detection reads the ZIP central directory, validates every entry name/size, and
// inflates only `[Content_Types].xml`. It never extracts the package or trusts the filename/MIME.

import type { Entry } from "@zip.js/zip.js"

export const OOXML_LIMITS = {
  maxCompressedBytes: 20 * 1024 * 1024,
  maxEntries: 512,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxContentTypesBytes: 256 * 1024,
  maxEntryNameBytes: 1024,
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

export type OoxmlDetection =
  | {
      status: "detected"
      subtype: OoxmlSubtype
      mime: (typeof OOXML_SUBTYPES)[OoxmlSubtype]["mime"]
      entryCount: number
      uncompressedBytes: number
    }
  | { status: "not-ooxml"; reason: string }
  | { status: "rejected"; reason: string }

const CONTENT_TYPES_NAME = "[Content_Types].xml"
const ROOT_RELS_NAME = "_rels/.rels"
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8])

/** Detect docx/xlsx/pptx from ZIP structure only. All malformed/ambiguous/over-limit input fails closed. */
export async function detectOoxmlContainer(bytes: Uint8Array): Promise<OoxmlDetection> {
  if (bytes.byteLength > OOXML_LIMITS.maxCompressedBytes)
    return { status: "rejected", reason: `compressed byte limit exceeded (${OOXML_LIMITS.maxCompressedBytes})` }
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04)
    return { status: "not-ooxml", reason: "not a ZIP local-file container" }

  const { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } = await import("@zip.js/zip.js")
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  try {
    const entries = await reader.getEntries()
    const central = validateCentralDirectory(entries)
    if (!central.ok) return { status: "rejected", reason: central.reason }
    const localHeaders = validateLocalHeaders(bytes, entries)
    if (localHeaders) return { status: "rejected", reason: localHeaders }

    const contentTypes = entries.filter((entry) => entry.filename === CONTENT_TYPES_NAME)
    if (contentTypes.length === 0) return { status: "not-ooxml", reason: `${CONTENT_TYPES_NAME} is absent` }
    if (contentTypes.length !== 1) return { status: "rejected", reason: `${CONTENT_TYPES_NAME} is duplicated` }
    if (contentTypes[0].directory) return { status: "rejected", reason: `${CONTENT_TYPES_NAME} is not a file` }
    if (contentTypes[0].uncompressedSize > OOXML_LIMITS.maxContentTypesBytes)
      return { status: "rejected", reason: `${CONTENT_TYPES_NAME} byte limit exceeded (${OOXML_LIMITS.maxContentTypesBytes})` }
    if (!contentTypes[0].getData) return { status: "rejected", reason: `${CONTENT_TYPES_NAME} is unreadable` }

    const data = await contentTypes[0].getData(new Uint8ArrayWriter(), {
      checkSignature: true,
      useWebWorkers: false,
    })
    if (!(data instanceof Uint8Array)) return { status: "rejected", reason: `${CONTENT_TYPES_NAME} did not decode to bytes` }
    if (data.byteLength > OOXML_LIMITS.maxContentTypesBytes)
      return { status: "rejected", reason: `${CONTENT_TYPES_NAME} inflated beyond its byte limit` }

    const overrides = parseContentTypeOverrides(data)
    if (!overrides.ok) return { status: "rejected", reason: overrides.reason }
    const names = new Set(entries.map((entry) => entry.filename))
    if (!names.has(ROOT_RELS_NAME)) return { status: "rejected", reason: `${ROOT_RELS_NAME} is absent` }

    const declared = Object.entries(OOXML_SUBTYPES).filter(([, facts]) =>
      overrides.values.some((override) => override.partName === `/${facts.mainPart}` && override.contentType === facts.mainContentType),
    ) as Array<[OoxmlSubtype, (typeof OOXML_SUBTYPES)[OoxmlSubtype]]>
    if (declared.length === 0) return { status: "not-ooxml", reason: "no supported OOXML main-part declaration" }
    if (declared.length !== 1) return { status: "rejected", reason: "ambiguous OOXML main-part declarations" }

    const subtype = declared[0][0]
    const facts = OOXML_SUBTYPES[subtype]
    if (!names.has(facts.mainPart)) return { status: "rejected", reason: `declared main part /${facts.mainPart} is absent` }
    if (Object.values(OOXML_SUBTYPES).some((candidate) => candidate.mainPart !== facts.mainPart && names.has(candidate.mainPart)))
      return { status: "rejected", reason: "container has conflicting OOXML main parts" }

    return {
      status: "detected",
      subtype,
      mime: facts.mime,
      entryCount: entries.length,
      uncompressedBytes: central.uncompressedBytes,
    }
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? `malformed ZIP:${error.message}` : "malformed ZIP" }
  } finally {
    await reader.close().catch(() => undefined)
  }
}

function validateCentralDirectory(entries: readonly Entry[]):
  | { ok: true; uncompressedBytes: number }
  | { ok: false; reason: string } {
  if (entries.length === 0) return { ok: false, reason: "ZIP central directory is empty" }
  if (entries.length > OOXML_LIMITS.maxEntries)
    return { ok: false, reason: `ZIP entry limit exceeded (${OOXML_LIMITS.maxEntries})` }

  const seen = new Set<string>()
  const unsafe = entries.find((entry) => unsafeEntryReason(entry) !== null)
  if (unsafe) return { ok: false, reason: unsafeEntryReason(unsafe)! }

  for (const entry of entries) {
    const identity = entry.filename.replace(/\/$/, "").toLowerCase()
    if (seen.has(identity)) return { ok: false, reason: `duplicate ZIP entry:${entry.filename}` }
    seen.add(identity)
  }

  const uncompressedBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0)
  if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > OOXML_LIMITS.maxUncompressedBytes)
    return { ok: false, reason: `ZIP uncompressed byte limit exceeded (${OOXML_LIMITS.maxUncompressedBytes})` }
  return { ok: true, uncompressedBytes }
}

function unsafeEntryReason(entry: Entry): string | null {
  if (entry.rawFilename.byteLength === 0 || entry.rawFilename.byteLength > OOXML_LIMITS.maxEntryNameBytes)
    return `unsafe ZIP entry name length:${entry.filename || "<empty>"}`
  if (/[\\\u0000-\u001f\u007f]/.test(entry.filename) || entry.filename.startsWith("/") || /^[A-Za-z]:/.test(entry.filename))
    return `unsafe ZIP entry path:${entry.filename}`
  const path = entry.directory && entry.filename.endsWith("/") ? entry.filename.slice(0, -1) : entry.filename
  const segments = path.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return `unsafe ZIP entry path:${entry.filename}`
  if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0)
    return `invalid ZIP entry size:${entry.filename}`
  if (entry.encrypted) return `encrypted ZIP entry:${entry.filename}`
  if (entry.zip64 || entry.diskNumberStart !== 0) return `unsupported split/ZIP64 entry:${entry.filename}`
  if (!SUPPORTED_COMPRESSION_METHODS.has(entry.compressionMethod)) return `unsupported ZIP compression:${entry.filename}`
  if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) return `symbolic-link ZIP entry:${entry.filename}`
  return null
}

/** Cross-check central-directory names/ranges against local file headers without inflating parts. */
function validateLocalHeaders(bytes: Uint8Array, entries: readonly Entry[]): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const invalid = entries.find((entry) => {
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || entry.offset + 30 > bytes.byteLength) return true
    if (view.getUint32(entry.offset, true) !== 0x04034b50) return true
    const nameLength = view.getUint16(entry.offset + 26, true)
    const extraLength = view.getUint16(entry.offset + 28, true)
    const dataOffset = entry.offset + 30 + nameLength + extraLength
    if (dataOffset + entry.compressedSize > bytes.byteLength) return true
    const localName = bytes.subarray(entry.offset + 30, entry.offset + 30 + nameLength)
    if (localName.byteLength !== entry.rawFilename.byteLength) return true
    return localName.some((byte, index) => byte !== entry.rawFilename[index])
  })
  return invalid ? `central/local ZIP header mismatch:${invalid.filename}` : null
}

function parseContentTypeOverrides(bytes: Uint8Array):
  | { ok: true; values: Array<{ partName: string; contentType: string }> }
  | { ok: false; reason: string } {
  const decoded = decodeUtf8(bytes)
  if (decoded === null) return { ok: false, reason: `${CONTENT_TYPES_NAME} is not valid UTF-8` }
  if (/<!\s*(?:DOCTYPE|ENTITY)|<!\[CDATA\[/i.test(decoded))
    return { ok: false, reason: `${CONTENT_TYPES_NAME} contains prohibited declarations` }

  const commentsRemoved = decoded.replace(/<!--[\s\S]*?-->/g, "")
  if (commentsRemoved.includes("<!--") || commentsRemoved.includes("-->"))
    return { ok: false, reason: `${CONTENT_TYPES_NAME} has malformed comments` }
  const xml = commentsRemoved.replace(/<\?[\s\S]*?\?>/g, "")
  const root = xml.match(/^\s*<([A-Za-z_][\w.-]*:)?Types\b([^<>]*)>([\s\S]*)<\/\1Types\s*>\s*$/)
  if (!root) return { ok: false, reason: `${CONTENT_TYPES_NAME} has an invalid Types root` }

  const rootAttributes = parseAttributes(root[2])
  if (!rootAttributes) return { ok: false, reason: `${CONTENT_TYPES_NAME} has invalid root attributes` }
  const prefix = root[1]?.slice(0, -1)
  if (rootAttributes.get(prefix ? `xmlns:${prefix}` : "xmlns") !== CONTENT_TYPES_NAMESPACE)
    return { ok: false, reason: `${CONTENT_TYPES_NAME} has the wrong namespace` }

  const childPrefix = prefix ? `${prefix}:` : ""
  const tag = new RegExp(`<${childPrefix}(Default|Override)\\b([^<>]*)\\/\\s*>`, "g")
  const values: Array<{ partName: string; contentType: string }> = []
  let offset = 0
  for (const match of root[3].matchAll(tag)) {
    if (root[3].slice(offset, match.index).trim().length > 0)
      return { ok: false, reason: `${CONTENT_TYPES_NAME} has unsupported content` }
    offset = match.index + match[0].length
    const attributes = parseAttributes(match[2])
    if (!attributes) return { ok: false, reason: `${CONTENT_TYPES_NAME} has invalid ${match[1]} attributes` }
    if (match[1] === "Default") continue
    if (attributes.size !== 2 || !attributes.has("PartName") || !attributes.has("ContentType"))
      return { ok: false, reason: `${CONTENT_TYPES_NAME} has an invalid Override` }
    const partName = attributes.get("PartName")!
    if (!safePartName(partName)) return { ok: false, reason: `${CONTENT_TYPES_NAME} has an unsafe PartName` }
    if (values.some((value) => value.partName.toLowerCase() === partName.toLowerCase()))
      return { ok: false, reason: `${CONTENT_TYPES_NAME} has a duplicate Override` }
    values.push({ partName, contentType: attributes.get("ContentType")! })
  }
  if (root[3].slice(offset).trim().length > 0)
    return { ok: false, reason: `${CONTENT_TYPES_NAME} has unsupported content` }
  return { ok: true, values }
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
  if (source.slice(offset).trim().length > 0) return null
  return attributes
}

function safePartName(partName: string): boolean {
  if (!partName.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(partName)) return false
  const segments = partName.slice(1).split("/")
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
