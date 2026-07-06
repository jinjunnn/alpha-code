// alpha project workdir (`.alpha/`) writer — ADR-019. Main-process only, but electron-free and
// root-parameterized so the whole surface is unit-testable against a temp dir.
//
// Layout (ADR-019 §2 修订): <projectDir>/.alpha/runs/<runId>/{contract.json,status.json,artifacts/*}
// Guards mirror ext-fs-installer.safeResolve (realpath anti-escape, ADR-014 §8) with root = .alpha;
// artifact names come from the platform (B) and are treated as hostile until sanitized.
// The dir self-ignores via a seeded `.alpha/.gitignore` (`*`) — ADR-019 §5: runtime artifacts,
// no user .gitignore edit required.

import * as fs from "node:fs"
import * as path from "node:path"
import type { CloudArtifactContent, CloudArtifactList, CloudJobEnvelope, CloudJobStatus, CloudResult } from "../preload/types"
import { parsePrefs, type ProjectPrefs } from "./alpha-cloud-consent"

export type CloudRunManifest =
  | { ok: true; dir: string; files: string[]; warnings: string[] }
  | { ok: false; reason: string }

// job ids are platform-issued; keep the accepted alphabet tight (no separators, no leading dot).
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
export function isSafeRunId(id: string): boolean {
  return SAFE_RUN_ID.test(id) && id !== "." && id !== ".."
}

// Server-provided artifact names: strip any path structure/control chars, cap length, never dotfiles.
export function sanitizeArtifactName(name: string | undefined, fallback: string): string {
  const base = (name ?? "")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
  if (!base || base === "." || base === ".." || base.startsWith(".")) return fallback
  return base.length > 128 ? base.slice(0, 128) : base
}

/** `<projectDir>/.alpha`, or null if projectDir is not an absolute path to an existing real directory. */
export function alphaRoot(projectDir: string): string | null {
  if (!path.isAbsolute(projectDir)) return null
  if (projectDir === path.parse(projectDir).root) return null // refuse "/" — junk-project guard (B4)
  try {
    if (!fs.statSync(projectDir).isDirectory()) return null
  } catch {
    return null
  }
  const root = path.join(projectDir, ".alpha")
  // realpath would legitimize a symlinked root — refuse `.alpha` that is itself a symlink.
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return null
  } catch {
    // not existing yet is fine
  }
  return root
}

// Resolve a target inside <projectDir>/.alpha and assert (via realpath of the nearest existing
// ancestor) that it cannot escape through symlinks or `..` — same walk as ext-fs-installer.ts.
export function safeResolveInAlpha(projectDir: string, ...segments: string[]): string | null {
  const root = alphaRoot(projectDir)
  if (!root) return null
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  try {
    const real = fs.realpathSync(probe)
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root
    // before .alpha exists the nearest ancestor is the project dir itself — that is still in-bounds.
    const realProject = fs.realpathSync(projectDir)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep) && real !== realProject) return null
  } catch {
    return null
  }
  return target
}

function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/**
 * 项目偏好 `.alpha/prefs.json`(ADR-019 落点)读写。B16 云同意等 per-project 偏好的落点;缺失/损坏
 * 读为 {}(不误判);写走 ensureAlphaScaffold + 守卫 + 原子写。
 */
export function readProjectPrefs(projectDir: string): ProjectPrefs {
  const target = safeResolveInAlpha(projectDir, "prefs.json")
  if (!target) return {}
  try {
    return parsePrefs(fs.readFileSync(target, "utf8"))
  } catch {
    return {}
  }
}

export function writeProjectPrefs(projectDir: string, prefs: ProjectPrefs): { ok: true } | { ok: false; reason: string } {
  if (!ensureAlphaScaffold(projectDir)) return { ok: false, reason: "invalid project dir" }
  const target = safeResolveInAlpha(projectDir, "prefs.json")
  if (!target) return { ok: false, reason: "path escapes .alpha" }
  try {
    writeFileAtomic(target, JSON.stringify(prefs, null, 2) + "\n")
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Create `.alpha/` and seed its self-ignoring .gitignore (idempotent). */
export function ensureAlphaScaffold(projectDir: string): string | null {
  const root = alphaRoot(projectDir)
  if (!root) return null
  fs.mkdirSync(root, { recursive: true })
  const gitignore = path.join(root, ".gitignore")
  if (!fs.existsSync(gitignore)) writeFileAtomic(gitignore, "*\n")
  return root
}

/**
 * 通用 run 目录写入(REQ-021 自动化用;复用 .alpha 守卫 + 原子写)。files = 文件名 → 文本内容;
 * 文件名过 sanitizeArtifactName(拒路径分隔/dotfile)。失败返回 reason,不抛。
 */
export function writeRunFiles(
  projectDir: string,
  runId: string,
  files: Record<string, string>,
): { ok: true; dir: string } | { ok: false; reason: string } {
  if (!isSafeRunId(runId)) return { ok: false, reason: "unsafe run id" }
  if (!ensureAlphaScaffold(projectDir)) return { ok: false, reason: "invalid project dir" }
  const dir = safeResolveInAlpha(projectDir, "runs", runId)
  if (!dir) return { ok: false, reason: "path escapes .alpha" }
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      writeFileAtomic(path.join(dir, sanitizeArtifactName(name, "file.txt")), content)
    }
    return { ok: true, dir }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export type SaveRunDeps = {
  status: (jobId: string) => Promise<CloudResult<CloudJobStatus>>
  artifacts: (jobId: string) => Promise<CloudResult<CloudArtifactList>>
  fetchArtifact: (artifactId: string) => Promise<CloudResult<CloudArtifactContent>>
  /** decoded-bytes cap per artifact (disk-bomb guard); oversize is skipped with a warning. */
  maxArtifactBytes?: number
}

const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

/**
 * Persist one cloud run under `<projectDir>/.alpha/runs/<runId>/` — status.json (always),
 * contract.json (when the caller knows the dispatch envelope) and artifacts/* (fetched in main,
 * bearer never leaves the main process). Partial artifact failures degrade to warnings; the run
 * dir + status.json are the success criterion.
 */
export async function saveCloudRun(
  projectDir: string,
  runId: string,
  deps: SaveRunDeps,
  contract?: CloudJobEnvelope,
): Promise<CloudRunManifest> {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  if (!ensureAlphaScaffold(projectDir)) return { ok: false, reason: "invalid project directory" }
  const runDir = safeResolveInAlpha(projectDir, "runs", runId)
  if (!runDir) return { ok: false, reason: "refused: path escapes .alpha" }

  // transport-error envelope = bare {error}; a real CloudJobStatus always carries job_id (its own
  // `error` field is null on success and a message on failed jobs — both still savable states).
  const status = await deps.status(runId)
  if (!status || typeof status !== "object" || !("job_id" in status)) {
    const reason = status && typeof status === "object" && "error" in status ? String(status.error) : "no status"
    return { ok: false, reason: `status: ${reason}` }
  }

  const files: string[] = []
  const warnings: string[] = []
  const artifactsDir = path.join(runDir, "artifacts")
  try {
    fs.mkdirSync(artifactsDir, { recursive: true })
    if (contract !== undefined) {
      writeFileAtomic(path.join(runDir, "contract.json"), JSON.stringify(contract, null, 2) + "\n")
      files.push("contract.json")
    }
    writeFileAtomic(path.join(runDir, "status.json"), JSON.stringify(status, null, 2) + "\n")
    files.push("status.json")
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write run" }
  }

  const list = await deps.artifacts(runId)
  const metas = list && typeof list === "object" && !("error" in list) ? list.artifacts : []
  if (list && typeof list === "object" && "error" in list) warnings.push(`artifacts: ${list.error}`)

  const maxBytes = deps.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  const used = new Set<string>()
  for (const meta of metas) {
    const content = await deps.fetchArtifact(meta.id)
    if (!content || typeof content !== "object" || "error" in content) {
      warnings.push(`artifact ${meta.id}: ${content && "error" in content ? content.error : "no content"}`)
      continue
    }
    const bytes = Buffer.from(content.base64, "base64")
    if (bytes.byteLength > maxBytes) {
      warnings.push(`artifact ${meta.id}: skipped (${bytes.byteLength} bytes > cap ${maxBytes})`)
      continue
    }
    let name = sanitizeArtifactName(meta.name ?? content.name, `artifact-${meta.id}`)
    if (used.has(name)) name = `${meta.id}-${name}`
    used.add(name)
    const target = safeResolveInAlpha(projectDir, "runs", runId, "artifacts", name)
    if (!target) {
      warnings.push(`artifact ${meta.id}: refused unsafe name`)
      continue
    }
    try {
      writeFileAtomic(target, bytes)
      files.push(path.join("artifacts", name))
    } catch (error) {
      warnings.push(`artifact ${meta.id}: ${error instanceof Error ? error.message : "write failed"}`)
    }
  }

  return { ok: true, dir: runDir, files, warnings }
}
