import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTROL_ENVELOPE_MAX_BYTES } from "@alpha-code/contracts-consumer"
import type { CloudDispatchResult } from "../preload/types"
import { assertSafeUploadResult, createMainUploadService } from "./alpha-upload"
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from "./alpha-upload-manifest"

const accepted: CloudDispatchResult = {
  schema_version: 1,
  job_id: "job_upload_1",
  status: "queued",
  autonomy: "pipeline",
  kind: "code-review",
  urls: { status: "/status", events: "/events", result: "/result" },
}

const jwt = (value: unknown) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`

describe("main upload admission and one-shot consent", () => {
  let root = ""

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "alpha-upload-service-"))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("non-sensitive explicit files dispatch silently and never request issuance", async () => {
    writeFileSync(join(root, "clean.ts"), "export const answer = 42\n")
    const calls = { issue: 0, dispatch: 0 }
    const service = createMainUploadService({
      identity: () => ({ accessToken: "access-secret", tenantId: "tenant-a" }),
      issue: async () => { calls.issue++; return "unused" },
      dispatch: async () => { calls.dispatch++; return accepted },
      log: () => {},
      id: () => "manifest-clean",
    })
    const result = await service.prepare(
      1,
      { kind: "code-review" },
      { projectDirectory: root, files: [join(root, "clean.ts")] },
    )
    expect(result).toMatchObject({ status: "sent", privacy: "clear", job: accepted, directory: realpathSync(root) })
    expect(calls).toEqual({ issue: 0, dispatch: 1 })
    expect(() => assertSafeUploadResult(result)).not.toThrow()
  })

  test("sensitive consent freezes exact scope and binds mocked alpha-web issuance response", async () => {
    const selected = join(root, "contact.txt")
    const original = "Call 13800138000。\n"
    writeFileSync(selected, original)
    const calls = { issue: 0, dispatch: 0 }
    const dispatched: Array<Parameters<Parameters<typeof createMainUploadService>[0]["dispatch"]>[0]> = []
    const now = new Date("2026-07-22T12:00:00.000Z")
    const service = createMainUploadService({
      identity: () => ({ accessToken: "access-secret", tenantId: "tenant-a" }),
      issue: async (input) => {
        calls.issue++
        const manifest = JSON.parse(input.manifestJson) as { manifest_id: string; egress: unknown }
        return jwt({
          schema_version: 1,
          iss: "alpha-web",
          aud: "alpha-platform-upload",
          sub: "tenant-a",
          token_use: "upload_consent",
          purpose: "artifact.upload",
          scope: ["artifact.upload"],
          iat: Math.floor(now.getTime() / 1000),
          exp: Math.floor(now.getTime() / 1000) + 300,
          jti: "consent-1",
          manifest_id: manifest.manifest_id,
          manifest_sha256: input.manifestSha256,
          egress: manifest.egress,
        })
      },
      dispatch: async (input) => { calls.dispatch++; dispatched.push(input); return accepted },
      log: () => {},
      now: () => now,
      id: () => "manifest-sensitive",
    })

    const prepared = await service.prepare(
      7,
      { kind: "code-review" },
      { projectDirectory: root, files: [selected] },
    )
    expect(prepared).toMatchObject({ status: "consent-required", preview: { fileCount: 1 } })
    expect(calls).toEqual({ issue: 0, dispatch: 0 })
    writeFileSync(selected, "expanded after preview: hi@example.com\n")
    if (prepared.status !== "consent-required") throw new Error("expected consent")
    expect(await service.confirm(8, prepared.requestId)).toEqual({ status: "failed", error: "upload-selection-invalid" })
    expect(calls).toEqual({ issue: 0, dispatch: 0 })
    const confirmed = await service.confirm(7, prepared.requestId)
    expect(confirmed).toMatchObject({ status: "sent", privacy: "confirmed", job: accepted })
    expect(calls).toEqual({ issue: 1, dispatch: 1 })
    expect(dispatched[0]?.body.upload.files).toEqual([{ path: "contact.txt", content: original }])
    expect(dispatched[0]?.uploadConsent).toContain(".")
    expect(() => assertSafeUploadResult(confirmed)).not.toThrow()
    expect(await service.confirm(7, prepared.requestId)).toEqual({ status: "failed", error: "upload-selection-invalid" })
  })

  test("cancelled consent and cancelled picker semantics never issue or upload", async () => {
    writeFileSync(join(root, "contact.txt"), "hi@example.com")
    const calls = { issue: 0, dispatch: 0 }
    const service = createMainUploadService({
      identity: () => ({ accessToken: "access-secret", tenantId: "tenant-a" }),
      issue: async () => { calls.issue++; return "unused" },
      dispatch: async () => { calls.dispatch++; return accepted },
      log: () => {},
    })
    const prepared = await service.prepare(
      2,
      { kind: "code-review" },
      { projectDirectory: root, files: [join(root, "contact.txt")] },
    )
    if (prepared.status !== "consent-required") throw new Error("expected consent")
    expect(service.cancel(2, prepared.requestId)).toEqual({ status: "cancelled" })
    expect(calls).toEqual({ issue: 0, dispatch: 0 })
  })

  test("manifest exceeding 256 files or 100 MiB total or 256 KiB control envelope fails closed before issuance", async () => {
    const small = join(root, "small.txt")
    const huge = join(root, "huge.txt")
    const control = join(root, "control.txt")
    writeFileSync(small, "plain")
    writeFileSync(huge, "")
    truncateSync(huge, MAX_UPLOAD_BYTES + 1)
    writeFileSync(control, "x".repeat(CONTROL_ENVELOPE_MAX_BYTES))
    const calls = { issue: 0, dispatch: 0 }
    const service = createMainUploadService({
      identity: () => ({ accessToken: "access-secret", tenantId: "tenant-a" }),
      issue: async () => { calls.issue++; return "unused" },
      dispatch: async () => { calls.dispatch++; return accepted },
      log: () => {},
    })
    expect(
      await service.prepare(
        1,
        { kind: "code-review" },
        { projectDirectory: root, files: Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => small) },
      ),
    ).toEqual({ status: "failed", error: "upload-file-limit" })
    expect(
      await service.prepare(1, { kind: "code-review" }, { projectDirectory: root, files: [huge] }),
    ).toEqual({ status: "failed", error: "upload-size-limit" })
    expect(
      await service.prepare(1, { kind: "code-review" }, { projectDirectory: root, files: [control] }),
    ).toEqual({ status: "failed", error: "upload-control-limit" })
    expect(calls).toEqual({ issue: 0, dispatch: 0 })
  })

  test("wrong manifest binding fails closed and error logging contains only a stable code", async () => {
    const selected = join(root, "contact.txt")
    writeFileSync(selected, "hi@example.com")
    const logs: string[] = []
    let dispatches = 0
    const service = createMainUploadService({
      identity: () => ({ accessToken: "secret-token", tenantId: "tenant-a" }),
      issue: async (input) => {
        const manifest = JSON.parse(input.manifestJson) as { manifest_id: string; egress: unknown }
        return jwt({
          schema_version: 1,
          iss: "alpha-web",
          aud: "alpha-platform-upload",
          sub: "tenant-a",
          token_use: "upload_consent",
          purpose: "artifact.upload",
          scope: ["artifact.upload"],
          iat: 1,
          exp: 9999999999,
          jti: "wrong-binding",
          manifest_id: manifest.manifest_id,
          manifest_sha256: "0".repeat(64),
          egress: manifest.egress,
        })
      },
      dispatch: async () => { dispatches++; return accepted },
      log: (message) => logs.push(message),
    })
    const prepared = await service.prepare(1, { kind: "code-review" }, { projectDirectory: root, files: [selected] })
    if (prepared.status !== "consent-required") throw new Error("expected consent")
    expect(await service.confirm(1, prepared.requestId)).toEqual({ status: "failed", error: "upload-consent-invalid" })
    expect(dispatches).toBe(0)
    expect(logs).toEqual(["[alpha-upload] failed code=upload-consent-invalid"])
    expect(logs.join(" ")).not.toContain("secret-token")
    expect(logs.join(" ")).not.toContain(root)
  })

  test("upload handler runtime assertion rejects credential or manifest fields", () => {
    expect(() => assertSafeUploadResult({ status: "failed", error: "upload-consent-invalid", token: "secret" })).toThrow()
    expect(() => assertSafeUploadResult({ status: "cancelled", nested: { manifest: {} } })).toThrow()
  })
})
