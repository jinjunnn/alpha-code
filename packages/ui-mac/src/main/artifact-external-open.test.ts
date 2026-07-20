import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { artifactIdFor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import { OFFICE_OPEN_GATE_FORMATS, OOXML_SUBTYPES } from "../shared/ooxml"
import { registerDownloadedArtifact } from "./artifact-service"
import { isManagedRunArtifactPath, openRunArtifactExternal } from "./artifact-external-open"

const RUN = "job_open_1"
let projectDir: string
let artifactPath: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "artifact-external-open-"))
  mkdirSync(join(projectDir, ".alpha", "runs", RUN, "artifacts"), { recursive: true })
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

  test("each authoritative Office extension is main-gated without ZIP magic for missing,neutral,and corresponding MIME claims", async () => {
    let opened = false
    for (const format of OFFICE_OPEN_GATE_FORMATS) {
      for (const variant of [
        { label: "missing" },
        { label: "neutral", claimedMime: "application/octet-stream" },
        { label: "claimed", claimedMime: format.mime },
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
    }
    expect(opened).toBe(false)
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
    artifactPath = join(projectDir, ".alpha", "runs", RUN, "artifacts", "book.xlsx")
    writeFileSync(artifactPath, "x")
    const alias = join(projectDir, "artifact-alias")
    symlinkSync(artifactPath, alias)
    expect(isManagedRunArtifactPath(artifactPath)).toBe(true)
    expect(isManagedRunArtifactPath(alias)).toBe(true)
    expect(isManagedRunArtifactPath(join(projectDir, ".alpha", "runs", RUN))).toBe(false)
    expect(isManagedRunArtifactPath(join(projectDir, ".alpha", "runs", RUN, "artifacts-other", "x"))).toBe(false)
  })
})

function register(
  name: string,
  bytes: Uint8Array,
  claimedMime?: string,
  detectedMime: string | null = "application/zip",
): ArtifactDescriptor {
  artifactPath = join(projectDir, ".alpha", "runs", RUN, "artifacts", name)
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
