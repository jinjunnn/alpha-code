// Main-owned macOS Quick Look gate. The renderer supplies only managed artifact identity; main
// resolves and contains the manifest path, pins the source inode, independently proves OOXML PASS,
// and previews a private byte-for-byte copy so replacement cannot change what Quick Look consumes.

import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative } from "node:path"
import { isSafeRunId, safeResolveInAlpha } from "./alpha-workdir"
import { isSafeSavedPath, readArtifactManifest } from "./artifact-manifest"
import {
  OOXML_LIMITS,
  detectOoxmlContainer,
  isPrivilegedOoxmlOpen,
  shouldGateOoxml,
} from "../shared/ooxml"

export type RunArtifactIdentity = {
  directory: string
  runId: string
  artifactId: string
}

export type ArtifactQuickLookCode =
  | "INVALID_IDENTITY"
  | "MANIFEST_UNREADABLE"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_STATE_BLOCKED"
  | "ARTIFACT_PATH_REJECTED"
  | "ARTIFACT_READ_FAILED"
  | "STRUCTURE_PASS_REQUIRED"
  | "PREVIEW_UNAVAILABLE"

export type ArtifactQuickLookResult =
  | { ok: true }
  | { ok: false; code: ArtifactQuickLookCode; reason: string }

type QuickLookIpcEvent = { sender: unknown }

export function registerArtifactQuickLookIpcHandler(deps: {
  handle: (
    channel: "run-artifact-quick-look",
    handler: (event: QuickLookIpcEvent, identity: unknown) => ArtifactQuickLookResult | Promise<ArtifactQuickLookResult>,
  ) => void
  ownerForEvent: (event: QuickLookIpcEvent) => { previewFile: (path: string) => void } | null
}) {
  deps.handle("run-artifact-quick-look", (event, identity) => {
    if (!isRunArtifactIdentity(identity)) return refused("INVALID_IDENTITY")
    const owner = deps.ownerForEvent(event)
    if (!owner) return refused("PREVIEW_UNAVAILABLE")
    return previewRunArtifactQuickLook(identity, (path) => owner.previewFile(path))
  })
}

export function isRunArtifactIdentity(value: unknown): value is RunArtifactIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  return (
    Object.keys(identity).length === 3 &&
    typeof identity.directory === "string" &&
    identity.directory.length > 0 &&
    typeof identity.runId === "string" &&
    isSafeRunId(identity.runId) &&
    typeof identity.artifactId === "string" &&
    identity.artifactId.length > 0
  )
}

export async function previewRunArtifactQuickLook(
  identity: RunArtifactIdentity,
  previewFile: (path: string) => void,
): Promise<ArtifactQuickLookResult> {
  if (!isRunArtifactIdentity(identity)) return refused("INVALID_IDENTITY")
  const read = readArtifactManifest(identity.directory, identity.runId)
  if (!read.ok || !read.manifest) return refused("MANIFEST_UNREADABLE", read.ok ? undefined : read.reason)
  const entry = read.manifest.artifacts.find((candidate) => candidate.descriptor.id === identity.artifactId)
  if (!entry) return refused("ARTIFACT_NOT_FOUND")
  if (entry.local.state === "missing" || entry.local.state === "mismatch")
    return refused("ARTIFACT_STATE_BLOCKED", entry.local.state)
  if (!isSafeSavedPath(entry.local.savedPath)) return refused("ARTIFACT_PATH_REJECTED")

  const runDir = safeResolveInAlpha(identity.directory, "runs", identity.runId)
  const target = safeResolveInAlpha(
    identity.directory,
    "runs",
    identity.runId,
    ...entry.local.savedPath.split("/"),
  )
  if (!runDir || !target) return refused("ARTIFACT_PATH_REJECTED")

  let source = -1
  let copyDir: string | undefined
  let passedStructure = false
  try {
    source = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const sourceStat = fstatSync(source)
    const pathStat = statSync(target)
    const realRun = realpathSync(runDir)
    const realTarget = realpathSync(target)
    const rel = relative(realRun, realTarget)
    if (
      !sourceStat.isFile() ||
      sourceStat.dev !== pathStat.dev ||
      sourceStat.ino !== pathStat.ino ||
      rel === "" ||
      rel.startsWith("..") ||
      isAbsolute(rel)
    )
      return refused("ARTIFACT_PATH_REJECTED")

    const claim = {
      name: entry.local.savedPath,
      claimedMime: entry.descriptor.claimedMime,
      detectedMime: entry.local.detectedMime ?? entry.descriptor.detectedMime,
    }
    if (!shouldGateOoxml(claim) || sourceStat.size > OOXML_LIMITS.maxCompressedBytes)
      return refused("STRUCTURE_PASS_REQUIRED")
    const bytes = readPinnedFile(source, sourceStat.size)
    const detection = await detectOoxmlContainer(bytes)
    if (!isPrivilegedOoxmlOpen(claim, detection))
      return refused(
        "STRUCTURE_PASS_REQUIRED",
        detection.status === "detected" ? "OOXML_CLAIM_CONFLICT" : detection.code,
      )

    passedStructure = true
    copyDir = mkdtempSync(join(tmpdir(), "alpha-artifact-quick-look-"))
    const copy = join(copyDir, basename(entry.local.savedPath))
    writeFileSync(copy, bytes, { flag: "wx", mode: 0o600 })
    previewFile(copy)
    const timer = setTimeout(() => rmSync(copyDir!, { recursive: true, force: true }), 10 * 60 * 1_000)
    timer.unref()
    return { ok: true }
  } catch (error) {
    if (copyDir) rmSync(copyDir, { recursive: true, force: true })
    return refused(
      passedStructure ? "PREVIEW_UNAVAILABLE" : "ARTIFACT_READ_FAILED",
      error instanceof Error ? error.message : undefined,
    )
  } finally {
    if (source >= 0) closeSync(source)
  }
}

function readPinnedFile(source: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  let offset = 0
  while (offset < size) {
    const read = readSync(source, bytes, offset, size - offset, offset)
    if (read <= 0) throw new Error("artifact changed during read")
    offset += read
  }
  if (fstatSync(source).size !== size) throw new Error("artifact changed during read")
  return bytes
}

function refused(code: ArtifactQuickLookCode, detail?: string): ArtifactQuickLookResult {
  return { ok: false, code, reason: detail ? `${code}:${detail}` : code }
}
