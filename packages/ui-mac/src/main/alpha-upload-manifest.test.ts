import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  classifyUploadContent,
  createExplicitUploadSnapshot,
  UploadAdmissionError,
} from "./alpha-upload-manifest"

describe("main-owned UploadManifestV1", () => {
  let root = ""

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "alpha-upload-manifest-"))
    mkdirSync(join(root, "src"))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("binds tenant path size sha256 purpose retention consent and content summary", async () => {
    const code = "export const answer = 42\n"
    const contact = "Call me at 13800138000。\n"
    writeFileSync(join(root, "src", "index.ts"), code)
    writeFileSync(join(root, "contact.txt"), contact)

    const snapshot = await createExplicitUploadSnapshot(
      { projectDirectory: root, files: [join(root, "src", "index.ts"), join(root, "contact.txt")] },
      "tenant-a",
      { id: () => "manifest-1", now: () => new Date("2026-07-22T12:00:00.000Z") },
    )

    expect(snapshot.manifest).toMatchObject({
      schema_version: 1,
      manifest_id: "manifest-1",
      tenant_id: "tenant-a",
      created_at: "2026-07-22T12:00:00.000Z",
      retention_class: "standard",
      consent_required: true,
      egress: [{ egress_class: "explicit.file-upload", enforcement: "required" }],
      file_count: 2,
      total_bytes: Buffer.byteLength(code) + Buffer.byteLength(contact),
    })
    expect(snapshot.manifest.files.map((file) => file.path)).toEqual(["contact.txt", "src/index.ts"])
    expect(snapshot.manifest.files[0]?.sha256).toBe(createHash("sha256").update(contact).digest("hex"))
    expect(snapshot.preview).toMatchObject({
      pipeline: "code-review",
      purpose: "artifact.upload",
      retentionClass: "standard",
      fileCount: 2,
    })
    expect(snapshot.preview.findings).toContainEqual({ kind: "contact", fileCount: 1 })
    expect(snapshot.manifestSha256).toBe(createHash("sha256").update(snapshot.manifestJson).digest("hex"))
  })

  test("classifies broad client-side PII without blindly flagging pure code or numbers", () => {
    const sensitive = [
      "邮箱 hi@example.com。",
      "裸手机号 13800138000。",
      "国际电话 +14155552671!",
      "身份证 11010519491231002X。",
      "api_key=sk-abcdefghijklmnopqrstuvwxyz",
    ]
    sensitive.forEach((content) => expect(classifyUploadContent({ path: "notes.txt", content }).sensitive).toBe(true))
    expect(classifyUploadContent({ path: "src/math.ts", content: "const values = [1, 2, 3, 12345678901]\n" })).toEqual({
      sensitive: false,
      findings: [],
    })
    expect(classifyUploadContent({ path: ".env.production", content: "PUBLIC_FLAG=true\n" }).findings).toContain(
      "protected",
    )
  })

  test("classifier uncertainty or error fails closed as sensitive", async () => {
    writeFileSync(join(root, "notes.txt"), "plain text")
    const snapshot = await createExplicitUploadSnapshot(
      { projectDirectory: root, files: [join(root, "notes.txt")] },
      "tenant-a",
      { classify: () => { throw new Error("classifier unavailable") } },
    )
    expect(snapshot.manifest.consent_required).toBe(true)
    expect(snapshot.preview.findings).toEqual([{ kind: "unknown", fileCount: 1 }])
  })

  test("missing directory outside-root file and symlink never expand to implicit project scope", async () => {
    writeFileSync(join(root, "inside.txt"), "inside")
    const outside = join(tmpdir(), `outside-${crypto.randomUUID()}.txt`)
    writeFileSync(outside, "outside")
    symlinkSync(join(root, "inside.txt"), join(root, "linked.txt"))
    try {
      await expect(
        createExplicitUploadSnapshot({ projectDirectory: join(root, "missing"), files: [join(root, "inside.txt")] }, "tenant-a"),
      ).rejects.toBeInstanceOf(UploadAdmissionError)
      await expect(
        createExplicitUploadSnapshot({ projectDirectory: root, files: [outside] }, "tenant-a"),
      ).rejects.toMatchObject({ code: "upload-path-invalid" })
      await expect(
        createExplicitUploadSnapshot({ projectDirectory: root, files: [join(root, "linked.txt")] }, "tenant-a"),
      ).rejects.toMatchObject({ code: "upload-path-invalid" })
    } finally {
      rmSync(outside, { force: true })
    }
  })
})
