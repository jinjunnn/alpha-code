import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  CONTROL_ENVELOPE_MAX_BYTES,
  decodeContract,
  type CloudJobRequestV1,
  type UploadManifestV1,
} from "@alpha-code/contracts-consumer"
import type { CloudJobEnvelope, UploadFindingKind, UploadPreview } from "../preload/types"
import { guardCloudEnvelope } from "./cloud-envelope-guard"

export const MAX_UPLOAD_FILES = 256
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export type UploadErrorCode =
  | "not-authenticated"
  | "upload-selection-invalid"
  | "upload-file-limit"
  | "upload-size-limit"
  | "upload-control-limit"
  | "upload-path-invalid"
  | "upload-file-unreadable"
  | "upload-not-text"
  | "upload-consent-issuance-failed"
  | "upload-consent-invalid"
  // [#940] "upload-dispatch-failed" 已删:派发腿的错误不再坍缩,分类码原样上抛(alpha-upload.ts)。
  | "upload-main-gate-required"

export class UploadAdmissionError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code)
    this.name = "UploadAdmissionError"
  }
}

export type UploadSelection = { projectDirectory: string; files: string[] }
export type UploadSensitivity = { sensitive: boolean; findings: UploadFindingKind[] }
export type UploadClassifier = (input: { path: string; content: string }) => UploadSensitivity

export type ExplicitUploadSnapshot = {
  projectDirectory: string
  manifest: UploadManifestV1
  manifestJson: string
  manifestSha256: string
  files: Array<{ path: string; content: string }>
  preview: UploadPreview
}

export async function createExplicitUploadSnapshot(
  selection: UploadSelection,
  tenantId: string,
  deps: { now?: () => Date; id?: () => string; classify?: UploadClassifier } = {},
): Promise<ExplicitUploadSnapshot> {
  if (!selection.files.length || selection.files.length > MAX_UPLOAD_FILES) {
    throw new UploadAdmissionError(selection.files.length ? "upload-file-limit" : "upload-selection-invalid")
  }
  if (!tenantId || tenantId !== tenantId.trim()) throw new UploadAdmissionError("upload-selection-invalid")

  const root = await requireProjectRoot(selection.projectDirectory)
  const selected = await Promise.all(selection.files.map((file) => inspectSelectedFile(root, selection.projectDirectory, file)))
  if (new Set(selected.map((file) => file.path)).size !== selected.length) {
    throw new UploadAdmissionError("upload-path-invalid")
  }
  const statedTotal = selected.reduce((total, file) => total + file.size, 0)
  if (statedTotal > MAX_UPLOAD_BYTES) throw new UploadAdmissionError("upload-size-limit")

  const read = await Promise.all(
    selected
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(async (file) => {
        const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const bytes = await (async () => {
          try {
            const before = await handle.stat()
            if (!before.isFile() || before.dev !== file.dev || before.ino !== file.ino || before.size !== file.size) {
              throw new UploadAdmissionError("upload-file-unreadable")
            }
            const content = await handle.readFile()
            const after = await handle.stat()
            if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
              throw new UploadAdmissionError("upload-file-unreadable")
            }
            return content
          } finally {
            await handle.close()
          }
        })()
        if (bytes.byteLength !== file.size) throw new UploadAdmissionError("upload-file-unreadable")
        const content = bytes.toString("utf8")
        if (!Buffer.from(content, "utf8").equals(bytes)) throw new UploadAdmissionError("upload-not-text")
        const sensitivity = classifyFailClosed(deps.classify ?? classifyUploadContent, file.path, content)
        return {
          path: file.path,
          content,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sensitivity,
        }
      }),
  )
  const totalBytes = read.reduce((total, file) => total + file.size, 0)
  if (totalBytes > MAX_UPLOAD_BYTES) throw new UploadAdmissionError("upload-size-limit")

  const findings = [...new Set(read.flatMap((file) => file.sensitivity.findings))]
  const manifest = decodeContract(
    "UploadManifestV1",
    {
      schema_version: 1,
      manifest_id: (deps.id ?? randomUUID)(),
      tenant_id: tenantId,
      created_at: (deps.now ?? (() => new Date()))().toISOString(),
      retention_class: "standard",
      consent_required: read.some((file) => file.sensitivity.sensitive),
      egress: [{ egress_class: "explicit.file-upload", enforcement: "required" }],
      file_count: read.length,
      total_bytes: totalBytes,
      files: read.map((file) => ({ path: file.path, size_bytes: file.size, sha256: file.sha256 })),
    },
    "cloud-http",
  )
  if (manifest.file_count !== manifest.files.length || manifest.total_bytes !== totalBytes) {
    throw new UploadAdmissionError("upload-selection-invalid")
  }
  const manifestJson = JSON.stringify(manifest)
  if (Buffer.byteLength(manifestJson, "utf8") > CONTROL_ENVELOPE_MAX_BYTES) {
    throw new UploadAdmissionError("upload-control-limit")
  }

  return {
    projectDirectory: root,
    manifest,
    manifestJson,
    manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
    files: read.map((file) => ({ path: file.path, content: file.content })),
    preview: {
      pipeline: "code-review",
      fileCount: read.length,
      totalBytes,
      files: read.map((file) => ({
        path: file.path,
        sizeBytes: file.size,
        sensitive: file.sensitivity.sensitive,
      })),
      findings: findings.map((kind) => ({
        kind,
        fileCount: read.filter((file) => file.sensitivity.findings.includes(kind)).length,
      })),
      purpose: "artifact.upload",
      retentionClass: "standard",
    },
  }
}

export function createExplicitUploadRequest(snapshot: ExplicitUploadSnapshot, envelope: CloudJobEnvelope) {
  const guarded = guardCloudEnvelope(envelope)
  if (!guarded.ok) throw new UploadAdmissionError(toUploadCode(guarded.error))
  const body = {
    ...guarded.envelope,
    upload: { manifest: snapshot.manifestJson, files: snapshot.files },
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > CONTROL_ENVELOPE_MAX_BYTES) {
    throw new UploadAdmissionError("upload-control-limit")
  }
  return body satisfies CloudJobRequestV1 & {
    upload: { manifest: string; files: Array<{ path: string; content: string }> }
  }
}

export function classifyUploadContent(input: { path: string; content: string }): UploadSensitivity {
  const findings: UploadFindingKind[] = []
  const protectedPath = /(?:^|\/)(?:\.env(?:\.|$)|\.ssh(?:\/|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|[^/]*\.(?:pem|key|p12|pfx)$|credentials?(?:\.[^/]*)?$|secrets?(?:\.[^/]*)?$)/i
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
  const phone = /(?:^|[^\d])(?:1[3-9]\d{9}|\+[1-9]\d{7,14})(?!\d)/
  const identity = /(?:^|[^\d])(?:\d{17}[\dXx]|\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})(?![\dXx])/
  const credential =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})\b|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}/i

  if (protectedPath.test(input.path)) findings.push("protected")
  if (email.test(input.content) || phone.test(input.content)) findings.push("contact")
  if (identity.test(input.content)) findings.push("identity")
  if (credential.test(input.content)) findings.push("credential")
  return { sensitive: findings.length > 0, findings }
}

function classifyFailClosed(classify: UploadClassifier, path: string, content: string) {
  try {
    const result = classify({ path, content })
    if (typeof result.sensitive !== "boolean" || !Array.isArray(result.findings)) {
      return { sensitive: true, findings: ["unknown" as const] }
    }
    return result
  } catch {
    return { sensitive: true, findings: ["unknown" as const] }
  }
}

async function requireProjectRoot(directory: string) {
  if (!isAbsolute(directory)) throw new UploadAdmissionError("upload-selection-invalid")
  try {
    const root = await realpath(directory)
    if (!(await lstat(root)).isDirectory()) throw new UploadAdmissionError("upload-selection-invalid")
    return root
  } catch (error) {
    if (error instanceof UploadAdmissionError) throw error
    throw new UploadAdmissionError("upload-selection-invalid")
  }
}

async function inspectSelectedFile(root: string, selectedRoot: string, selectedPath: string) {
  if (!isAbsolute(selectedPath)) throw new UploadAdmissionError("upload-path-invalid")
  try {
    const pathFromSelection = relative(resolve(selectedRoot), resolve(selectedPath))
    if (!pathFromSelection || pathFromSelection.startsWith(`..${sep}`) || pathFromSelection === "..") {
      throw new UploadAdmissionError("upload-path-invalid")
    }
    const absolutePath = await realpath(selectedPath)
    if (absolutePath !== resolve(root, pathFromSelection)) throw new UploadAdmissionError("upload-path-invalid")
    const path = pathFromSelection.split(sep).join("/")
    if (!path || path.startsWith("../") || path === ".." || isAbsolute(path)) {
      throw new UploadAdmissionError("upload-path-invalid")
    }
    const stat = await lstat(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new UploadAdmissionError("upload-path-invalid")
    return { absolutePath, path, size: stat.size, dev: stat.dev, ino: stat.ino }
  } catch (error) {
    if (error instanceof UploadAdmissionError) throw error
    throw new UploadAdmissionError("upload-file-unreadable")
  }
}

function toUploadCode(error: string): UploadErrorCode {
  if (error === "upload-main-gate-required") return error
  if (error.startsWith("envelope-too-large")) return "upload-control-limit"
  return "upload-selection-invalid"
}
