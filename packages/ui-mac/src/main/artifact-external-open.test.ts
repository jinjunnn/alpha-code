import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { artifactIdFor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import { NON_OOXML_OPEN_GATE_REGRESSION_FORMATS } from "../shared/ooxml-gate.test-support"
import { OFFICE_OPEN_GATE_FORMATS, OOXML_SUBTYPES } from "../shared/ooxml"
import { registerDownloadedArtifact } from "./artifact-service"
import { isManagedRunArtifactPath, openRunArtifactExternal } from "./artifact-external-open"

const RUN = "job_open_1"
let projectDir: string
let artifactPath: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "artifact-external-open-"))
  mkdirSync(join(projectDir, ".code-puppy", "runs", RUN, "artifacts"), { recursive: true })
})

afterEach(() => rmSync(projectDir, { recursive: true, force: true }))

describe("main-owned artifact external-open gate", () => {
  test("real OOXML bytes pass detector and claim checks before a private copy is opened", async () => {
    const bytes = await makeXlsxFixture()
    const descriptor = register("book.xlsx", bytes, OOXML_SUBTYPES.xlsx.mime)
    let opened = ""
    const result = await openRunArtifactExternal(projectDir, RUN, descriptor.id, async (path) => {
      opened = path
      writeFileSync(artifactPath, "replaced after validation")
    })

    expect(result).toEqual({ ok: true })
    expect(opened).not.toBe(artifactPath)
    expect(readFileSync(opened)).toEqual(Buffer.from(bytes))
    rmSync(dirname(opened), { recursive: true, force: true })
  })

  test("macro-enabled claim remains non-privileged even when bytes are a valid non-macro xlsx", async () => {
    const descriptor = register(
      "payroll.xlsm",
      await makeXlsxFixture(),
      "application/vnd.ms-excel.sheet.macroEnabled.12",
    )
    let opened = false
    const result = await openRunArtifactExternal(projectDir, RUN, descriptor.id, async () => {
      opened = true
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("OOXML_REJECTED")
    expect(opened).toBe(false)
  })

  test("each authoritative Office extension is main-gated for extension × missing/neutral/claimed MIME", async () => {
    let opened = false
    for (const format of OFFICE_OPEN_GATE_FORMATS) {
      for (const variant of [
        { label: "missing" },
        { label: "neutral", claimedMime: "application/octet-stream" },
        ...format.mimes.map((claimedMime, index) => ({ label: `claimed-${index}`, claimedMime })),
      ]) {
        const descriptor = register(
          `${format.extension}-${variant.label}.${format.extension}`,
          new TextEncoder().encode("not a ZIP container"),
          variant.claimedMime,
          null,
        )
        const result = await openRunArtifactExternal(projectDir, RUN, descriptor.id, async () => {
          opened = true
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("OOXML_REJECTED")
      }
      for (const [index, claimedMime] of format.mimes.entries()) {
        const descriptor = register(
          `mime-only-${format.extension}-${index}`,
          new TextEncoder().encode("not a ZIP container"),
          claimedMime,
          null,
        )
        const result = await openRunArtifactExternal(projectDir, RUN, descriptor.id, async () => {
          opened = true
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("OOXML_REJECTED")
      }
    }
    expect(opened).toBe(false)
  })

  test("all 63 removed extensions and MIME claims keep pre-gate external open", async () => {
    expect(NON_OOXML_OPEN_GATE_REGRESSION_FORMATS).toHaveLength(63)
    for (const format of NON_OOXML_OPEN_GATE_REGRESSION_FORMATS) {
      for (const [name, claimedMime] of [
        [`out-of-scope.${format.extension}`, undefined],
        ...format.mimes.map((mime, index) => [`mime-only-${format.extension}-${index}`, mime] as const),
      ] as const) {
        const descriptor = register(name, new TextEncoder().encode("not an Office container"), claimedMime, null)
        const result = await openRunArtifactExternal(projectDir, RUN, descriptor.id, async (path) => {
          rmSync(dirname(path), { recursive: true, force: true })
        })
        expect(result).toEqual({ ok: true })
      }
    }
  })

  test("generic ZIP extension, MIME, and actual ZIP bytes remain outside the OOXML-family gate", async () => {
    const bytes = await makeGenericZipFixture()
    for (const [name, claimedMime] of [
      ["archive.zip", undefined],
      ["mime-only-zip", "application/zip"],
      ["mime-only-x-zip", "application/x-zip-compressed"],
      ["mime-only-multipart-zip", "multipart/x-zip"],
    ] as const) {
      const descriptor = register(name, bytes, claimedMime)
      const result = await openRunArtifactExternal(projectDir, RUN, descriptor.id, async (path) => {
        rmSync(dirname(path), { recursive: true, force: true })
      })
      expect(result).toEqual({ ok: true })
    }
  })

  test("malformed OOXML is rejected by main even if renderer-side state was previously favorable", async () => {
    const bytes = await makeXlsxFixture("word/document.xml")
    const descriptor = register("book.xlsx", bytes, OOXML_SUBTYPES.xlsx.mime)
    const result = await openRunArtifactExternal(projectDir, RUN, descriptor.id, async () => undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("OOXML_REJECTED")
  })
})

describe("generic open-path bypass classification", () => {
  test("managed artifact paths and realpath aliases are blocked, but the run directory is not", () => {
    artifactPath = join(projectDir, ".code-puppy", "runs", RUN, "artifacts", "book.xlsx")
    writeFileSync(artifactPath, "x")
    const alias = join(projectDir, "artifact-alias")
    symlinkSync(artifactPath, alias)
    expect(isManagedRunArtifactPath(artifactPath)).toBe(true)
    expect(isManagedRunArtifactPath(alias)).toBe(true)
    expect(isManagedRunArtifactPath(join(projectDir, ".code-puppy", "runs", RUN))).toBe(false)
    expect(isManagedRunArtifactPath(join(projectDir, ".code-puppy", "runs", RUN, "artifacts-other", "x"))).toBe(false)
  })
})

function register(
  name: string,
  bytes: Uint8Array,
  claimedMime?: string,
  detectedMime: string | null = "application/zip",
): ArtifactDescriptor {
  artifactPath = join(projectDir, ".code-puppy", "runs", RUN, "artifacts", name)
  writeFileSync(artifactPath, bytes)
  const digest = createHash("sha256").update(bytes).digest("hex")
  const id = artifactIdFor(RUN, 0, { name, size: bytes.byteLength, sha256: digest })
  const descriptor: ArtifactDescriptor = {
    schemaVersion: 1,
    id,
    source: "cloud",
    name,
    size: bytes.byteLength,
    sha256: digest,
    ...(claimedMime ? { claimedMime } : {}),
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: `/v1/cloud/artifacts/${id}/content`, auth: "bearer" },
    verification: { status: "verified" },
    provenance: { producer: "pipeline", jobId: RUN },
  }
  const result = registerDownloadedArtifact(projectDir, RUN, {
    descriptor,
    savedPath: `artifacts/${name}`,
    verifiedSha256: digest,
    ...(detectedMime ? { detectedMime } : {}),
  })
  if (!result.ok) throw new Error(result.reason)
  return descriptor
}

async function makeXlsxFixture(target = "xl/workbook.xml") {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output, { useWebWorkers: false })
  const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="${OOXML_SUBTYPES.xlsx.mainContentType}"/></Types>`
  const relationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`
  for (const [name, content] of [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", relationships],
    ["xl/workbook.xml", "<workbook/>"],
  ] as const)
    await writer.add(name, new TextReader(content), { dataDescriptor: false, extendedTimestamp: false })
  await writer.close()
  return output.getData()
}

async function makeGenericZipFixture() {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output, { useWebWorkers: false })
  await writer.add("readme.txt", new TextReader("ordinary archive"), { dataDescriptor: false, extendedTimestamp: false })
  await writer.close()
  return output.getData()
}
