// Main-owned external-open gate for managed run artifacts. Renderer supplies identity only; main
// resolves the manifest path, pins the source inode, re-runs the OOXML gate, and opens a private
// byte-for-byte copy so path replacement cannot change what the operating system consumes.

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
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, normalize, relative } from "node:path"
import { isSafeRunId, safeResolveInAlpha } from "./alpha-workdir"
import { isSafeSavedPath, readArtifactManifest } from "./artifact-manifest"
import {
  OOXML_LIMITS,
  detectOoxmlContainer,
  isPrivilegedOoxmlOpen,
  shouldGateOoxml,
} from "../shared/ooxml"

export type ArtifactExternalOpenCode =
  | "INVALID_ARGUMENTS"
  | "MANIFEST_UNREADABLE"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_STATE_BLOCKED"
  | "ARTIFACT_PATH_REJECTED"
  | "ARTIFACT_READ_FAILED"
  | "OOXML_REJECTED"
  | "OPEN_FAILED"

export type ArtifactExternalOpenResult =
  | { ok: true }
  | { ok: false; code: ArtifactExternalOpenCode; reason: string }

export async function openRunArtifactExternal(
  projectDir: string,
  runId: string,
  artifactId: string,
  openPath: (path: string) => Promise<string | void>,
): Promise<ArtifactExternalOpenResult> {
  if (!projectDir || !isSafeRunId(runId) || !artifactId) return refused("INVALID_ARGUMENTS")
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok || !read.manifest) return refused("MANIFEST_UNREADABLE", read.ok ? undefined : read.reason)
  const entry = read.manifest.artifacts.find((candidate) => candidate.descriptor.id === artifactId)
  if (!entry) return refused("ARTIFACT_NOT_FOUND")
  if (entry.local.state === "missing" || entry.local.state === "mismatch")
    return refused("ARTIFACT_STATE_BLOCKED", entry.local.state)
  if (!isSafeSavedPath(entry.local.savedPath)) return refused("ARTIFACT_PATH_REJECTED")

  const runDir = safeResolveInAlpha(projectDir, "runs", runId)
  const target = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
  if (!runDir || !target) return refused("ARTIFACT_PATH_REJECTED")

  let source = -1
  let copyDir: string | undefined
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
    ) return refused("ARTIFACT_PATH_REJECTED")

    const header = Buffer.alloc(4)
    const headerBytes = readSync(source, header, 0, header.byteLength, 0)
    const claim = {
      name: entry.local.savedPath,
      claimedMime: entry.descriptor.claimedMime,
      detectedMime: entry.local.detectedMime ?? entry.descriptor.detectedMime,
    }
    const mustGate =
      shouldGateOoxml(claim) ||
      (headerBytes === 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04)
    const bytes = mustGate
      ? sourceStat.size <= OOXML_LIMITS.maxCompressedBytes
        ? readPinnedFile(source, sourceStat.size)
        : null
      : undefined
    if (mustGate && !bytes) return refused("OOXML_REJECTED", "ZIP_COMPRESSED_LIMIT")
    if (bytes) {
      const detection = await detectOoxmlContainer(bytes)
      if (!isPrivilegedOoxmlOpen(claim, detection))
        return refused("OOXML_REJECTED", detection.status === "detected" ? "OOXML_CLAIM_CONFLICT" : detection.code)
    }

    copyDir = mkdtempSync(join(tmpdir(), "alpha-artifact-open-"))
    const copy = join(copyDir, basename(entry.local.savedPath))
    if (bytes) writeFileSync(copy, bytes, { flag: "wx", mode: 0o600 })
    else copyFileDescriptor(source, copy, sourceStat.size)
    const error = await openPath(copy)
    if (typeof error === "string" && error.length > 0) {
      rmSync(copyDir, { recursive: true, force: true })
      copyDir = undefined
      return refused("OPEN_FAILED", error)
    }
    const timer = setTimeout(() => rmSync(copyDir!, { recursive: true, force: true }), 10 * 60 * 1_000)
    timer.unref()
    return { ok: true }
  } catch (error) {
    if (copyDir) rmSync(copyDir, { recursive: true, force: true })
    return refused("ARTIFACT_READ_FAILED", error instanceof Error ? error.message : undefined)
  } finally {
    if (source >= 0) closeSync(source)
  }
}

/** Generic open-path must not be a bypass for identity-addressed managed artifact opens. */
export function isManagedRunArtifactPath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  const paths = [normalize(value)]
  try {
    paths.push(realpathSync(value))
  } catch {
    // A missing path cannot be opened; the lexical check still blocks a managed artifact spelling.
  }
  return paths.some((candidate) => {
    const segments = candidate.split(/[\\/]+/).map((segment) => segment.toLowerCase())
    return segments.some((segment, index) =>
      segment === ".alpha" &&
      segments[index + 1] === "runs" &&
      Boolean(segments[index + 2]) &&
      segments[index + 3] === "artifacts" &&
      Boolean(segments[index + 4]))
  })
}

function copyFileDescriptor(source: number, target: string, size: number): void {
  const destination = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < size) {
      const read = readSync(source, buffer, 0, Math.min(buffer.byteLength, size - offset), offset)
      if (read <= 0) throw new Error("artifact changed during copy")
      let written = 0
      while (written < read) written += writeSync(destination, buffer, written, read - written)
      offset += read
    }
    if (fstatSync(source).size !== size) throw new Error("artifact changed during copy")
  } finally {
    closeSync(destination)
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

function refused(code: ArtifactExternalOpenCode, detail?: string): ArtifactExternalOpenResult {
  return { ok: false, code, reason: detail ? `${code}:${detail}` : code }
}
