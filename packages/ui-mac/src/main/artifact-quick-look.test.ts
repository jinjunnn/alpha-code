import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { artifactIdFor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import { OOXML_SUBTYPES } from "../shared/ooxml"
import { registerDownloadedArtifact } from "./artifact-service"
import {
  previewRunArtifactQuickLook,
  registerArtifactQuickLookIpcHandler,
  type ArtifactQuickLookResult,
  type RunArtifactIdentity,
} from "./artifact-quick-look"

const RUN = "job_quick_look_1"
let projectDir: string
let artifactPath: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "artifact-quick-look-"))
  mkdirSync(join(projectDir, ".alpha", "runs", RUN, "artifacts"), { recursive: true })
})

afterEach(() => rmSync(projectDir, { recursive: true, force: true }))

describe("production Quick Look IPC entry", () => {
  test("a PASS identity reaches the main handler and previews only the independently gated copy", async () => {
    const bytes = await makeXlsxFixture()
    const identity = register("book.xlsx", bytes, OOXML_SUBTYPES.xlsx.mime)
    const handlers = new Map<
      string,
      (event: { sender: unknown }, identity: unknown) => ArtifactQuickLookResult | Promise<ArtifactQuickLookResult>
    >()
    let previewed = ""
    registerArtifactQuickLookIpcHandler({
      handle: (channel, handler) => handlers.set(channel, handler),
      ownerForEvent: () => ({
        previewFile: (path) => {
          previewed = path
        },
      }),
    })

    expect(Object.keys(identity).sort()).toEqual(["artifactId", "directory", "runId"])
    const result = await handlers.get("run-artifact-quick-look")!({ sender: {} }, identity)

    expect(result).toEqual({ ok: true })
    expect(previewed).not.toBe(artifactPath)
    expect(readFileSync(previewed)).toEqual(Buffer.from(bytes))
    rmSync(dirname(previewed), { recursive: true, force: true })
  })

  test("invalid identity and an absent owner window fail before preview", async () => {
    const handlers = new Map<
      string,
      (event: { sender: unknown }, identity: unknown) => ArtifactQuickLookResult | Promise<ArtifactQuickLookResult>
    >()
    registerArtifactQuickLookIpcHandler({
      handle: (channel, handler) => handlers.set(channel, handler),
      ownerForEvent: () => null,
    })
    const entry = handlers.get("run-artifact-quick-look")!

    expect(await entry({ sender: {} }, { savedPath: "/tmp/report.docx" })).toEqual({
      ok: false,
      code: "INVALID_IDENTITY",
      reason: "INVALID_IDENTITY",
    })
    expect(
      await entry(
        { sender: {} },
        {
          directory: projectDir,
          runId: RUN,
          artifactId: "art_missing",
          savedPath: "/tmp/report.docx",
        },
      ),
    ).toEqual({
      ok: false,
      code: "INVALID_IDENTITY",
      reason: "INVALID_IDENTITY",
    })
    expect(
      await entry(
        { sender: {} },
        { directory: projectDir, runId: RUN, artifactId: "art_missing" },
      ),
    ).toEqual({
      ok: false,
      code: "PREVIEW_UNAVAILABLE",
      reason: "PREVIEW_UNAVAILABLE",
    })
  })

  // 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
  test("ANCHOR (not a gate): the production artifact IPC and preload entries install and invoke the identity-only channel", () => {
    expect(readFileSync(join(import.meta.dir, "artifact-ipc.ts"), "utf8")).toContain(
      "registerArtifactQuickLookIpcHandler({",
    )
    expect(readFileSync(join(import.meta.dir, "..", "preload", "index.ts"), "utf8")).toContain(
      'quickLook: (identity) => ipcRenderer.invoke("run-artifact-quick-look", identity)',
    )
  })
})

describe("main-owned Quick Look gate", () => {
  test("malformed Office bytes are refused even when the renderer invokes the handler", async () => {
    const identity = register(
      "unsafe.xlsx",
      new TextEncoder().encode("not a ZIP container"),
      OOXML_SUBTYPES.xlsx.mime,
      "application/zip",
    )
    let previewed = false
    const result = await previewRunArtifactQuickLook(identity, () => {
      previewed = true
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("STRUCTURE_PASS_REQUIRED")
    expect(previewed).toBe(false)
  })

  test("realpath escape is refused before structure checking or previewFile", async () => {
    const bytes = await makeXlsxFixture()
    const identity = register("linked/escaped.xlsx", bytes, OOXML_SUBTYPES.xlsx.mime)
    const outsideDir = join(projectDir, "outside")
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, "escaped.xlsx"), bytes)
    const linkedDir = dirname(artifactPath)
    rmSync(linkedDir, { recursive: true })
    symlinkSync(outsideDir, linkedDir, "dir")
    let previewed = false
    const result = await previewRunArtifactQuickLook(identity, () => {
      previewed = true
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("ARTIFACT_PATH_REJECTED")
    expect(previewed).toBe(false)
  })

  test("non-Office artifacts never gain Quick Look through the main entry", async () => {
    const identity = register("notes.txt", new TextEncoder().encode("hello"), "text/plain", "text/plain")
    let previewed = false
    const result = await previewRunArtifactQuickLook(identity, () => {
      previewed = true
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("STRUCTURE_PASS_REQUIRED")
    expect(previewed).toBe(false)
  })
})

function register(
  name: string,
  bytes: Uint8Array,
  claimedMime?: string,
  detectedMime: string | null = "application/zip",
): RunArtifactIdentity {
  artifactPath = join(projectDir, ".alpha", "runs", RUN, "artifacts", name)
  mkdirSync(dirname(artifactPath), { recursive: true })
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
  return { directory: projectDir, runId: RUN, artifactId: descriptor.id }
}

async function makeXlsxFixture() {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output, { useWebWorkers: false })
  const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="${OOXML_SUBTYPES.xlsx.mainContentType}"/></Types>`
  const relationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  await Promise.all(
    [
      ["[Content_Types].xml", contentTypes],
      ["_rels/.rels", relationships],
      ["xl/workbook.xml", "<workbook/>"],
    ].map(([name, content]) =>
      writer.add(name!, new TextReader(content!), { dataDescriptor: false, extendedTimestamp: false }),
    ),
  )
  await writer.close()
  return output.getData()
}
