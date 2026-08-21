// alpha project workdir (`.alpha/`) writer — ADR-019. Main-process only, but electron-free and
// root-parameterized so the whole surface is unit-testable against a temp dir.
//
// Layout (ADR-019 §2 修订): <projectDir>/.alpha/runs/<runId>/{contract.json,status.json,artifacts/*}
// Guards mirror ext-fs-installer.safeResolve (realpath anti-escape, ADR-014 §8) with root = .alpha;
// artifact names come from the platform (B) and are treated as hostile until sanitized.
// The dir self-ignores via a seeded `.alpha/.gitignore` (`*`) — ADR-019 §5: runtime artifacts,
// no user .gitignore edit required.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CloudArtifactMeta, CloudArtifactList, CloudJobEnvelope, CloudJobStatus, CloudResult } from "../preload/types"
import type { ArtifactDownloadOutcome } from "./alpha-artifact-download"
import { validateArtifactDescriptor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
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

// #901: macOS default volumes (APFS) are case-insensitive but case-preserving — "Report.pdf" and
// "report.pdf" are the SAME directory entry on disk even though they compare unequal as strings.
// Any code deciding a final artifact file name must compare against this folded key, not the raw
// string, or two artifacts that only differ by case silently clobber each other on final rename.
export function foldedArtifactNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase()
}

/**
 * Reserve a collision-free artifact file name under `artifactsDir`, using a case-folded /
 * NFC-normalized comparison so names that only differ by case are treated as taken. Reads the
 * directory fresh on every call (not an in-memory cache) so the reservation holds across
 * separate, sequential download invocations — not just within one batch. `taken` optionally
 * seeds folded keys already claimed earlier in the *same* batch, before those files exist on
 * disk (e.g. a single `saveCloudRun` pass over several just-listed artifacts).
 *
 * An EXACT on-disk name match is deliberately not treated as a collision (only a case-folded
 * match with a *different* exact string is): re-fetching/refreshing the same artifact under the
 * same name is a legitimate, pre-existing overwrite-in-place path (registerDownloadedArtifact's
 * own idempotent-register contract), and that must keep working. `taken` is checked first and
 * always blocks regardless — it represents names already spoken for earlier in *this* batch, so
 * two distinct, not-yet-downloaded artifacts in one pass never end up racing for the same exact
 * name either (pre-existing dedup-with-id-prefix behavior).
 */
export function reserveArtifactSavedName(
  artifactsDir: string,
  desiredName: string,
  disambiguator: string,
  taken?: Set<string>,
): string {
  const exactNames = new Set<string>()
  const foldedNames = new Set<string>()
  try {
    for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.endsWith(".part")) continue
      exactNames.add(entry.name)
      foldedNames.add(foldedArtifactNameKey(entry.name))
    }
  } catch {
    // artifacts dir not created yet — nothing on disk to collide with.
  }
  const isFree = (candidate: string) => {
    if (taken?.has(foldedArtifactNameKey(candidate))) return false
    if (exactNames.has(candidate)) return true
    return !foldedNames.has(foldedArtifactNameKey(candidate))
  }
  let candidate = desiredName
  if (!isFree(candidate)) {
    candidate = `${disambiguator}-${desiredName}`
    let suffix = 2
    while (!isFree(candidate)) candidate = `${disambiguator}-${suffix++}-${desiredName}`
  }
  taken?.add(foldedArtifactNameKey(candidate))
  return candidate
}

export type ProjectAlphaRootResolution =
  | { status: "project"; projectDir: string; root: string }
  | { status: "retired-home"; reason: string }
  | { status: "unknown"; reason: string }

/** main 项目入口的统一三态身份：返回 canonical project + 已验证 `.alpha` endpoint。 */
export function resolveProjectAlphaRoot(projectDir: string, homeDir: string = os.homedir()): ProjectAlphaRootResolution {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir) || projectDir === path.parse(projectDir).root)
    return { status: "unknown", reason: "project directory must be an absolute non-root path" }
  let project: string
  let home: string
  try {
    project = path.normalize(fs.realpathSync(projectDir))
    home = path.normalize(fs.realpathSync(homeDir))
    if (!fs.statSync(project).isDirectory()) return { status: "unknown", reason: "project path is not a directory" }
  } catch {
    return { status: "unknown", reason: "project directory identity cannot be confirmed" }
  }
  if (project === home) return { status: "retired-home", reason: "real home and its aliases are not projects" }

  const retiredLexical = path.join(home, ".alpha")
  const retired = (() => {
    try {
      return { ok: true as const, path: path.normalize(fs.realpathSync(retiredLexical)) }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        return { ok: false as const }
      return { ok: true as const, path: retiredLexical }
    }
  })()
  if (!retired.ok) return { status: "unknown", reason: "retired global root identity cannot be confirmed" }
  const root = path.join(project, ".alpha")
  if (sameOrInside(project, retired.path) || related(root, retiredLexical) || related(root, retired.path))
    return { status: "retired-home", reason: "project alpha root is related to the retired global root" }

  try {
    const stat = fs.lstatSync(root)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      return { status: "unknown", reason: "project alpha endpoint is not a real directory" }
    if (path.normalize(fs.realpathSync(root)) !== root)
      return { status: "unknown", reason: "project alpha endpoint is a canonical alias" }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      return { status: "unknown", reason: "project alpha root identity cannot be confirmed" }
  }
  return { status: "project", projectDir: project, root }
}

/** `<projectDir>/.alpha`, or null unless the unified three-state resolver admits it. */
export function alphaRoot(projectDir: string): string | null {
  const resolved = resolveProjectAlphaRoot(projectDir)
  return resolved.status === "project" ? resolved.root : null
}

/** Recovery gate 的 project-root 复验：root 必须仍是同一 canonical 项目的已验证 `.alpha` endpoint。 */
export function assertProjectAlphaRootIdentity(root: string): void {
  if (!path.isAbsolute(root) || path.basename(root) !== ".alpha") throw new Error("invalid project alpha root")
  const resolved = resolveProjectAlphaRoot(path.dirname(root))
  if (resolved.status !== "project" || resolved.root !== path.normalize(root))
    throw new Error("project alpha root identity cannot be confirmed")
}

function related(left: string, right: string): boolean {
  return sameOrInside(left, right) || sameOrInside(right, left)
}

function sameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
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
  /** REQ-092:artifact 字节唯一入口 —— main 流式写盘(.part + 单遍 sha256 + 原子 rename)。
   *  限额(100 MiB)与校验都在写入端前置/内联,本模块不再解码、不再全量缓冲。 */
  download: (artifact: CloudArtifactMeta, targetPath: string, jobId: string) => Promise<ArtifactDownloadOutcome>
  /** REQ-093:下载成功后的 manifest 登记(由调用方注入 artifact-service;依赖注入是为了
   *  避开 artifact-service → alpha-workdir 的既有引用成环)。缺省 = 不登记,盘上文件仍经
   *  legacyFiles 只读发现。 */
  register?: (input: {
    descriptor: ArtifactDescriptor
    savedPath: string
    verifiedSha256?: string
  }) => { ok: boolean; reason?: string }
}

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

  // REQ-092:字节不再进本模块 —— 名字净化 + .alpha 逃逸守卫后,把目标路径交给流式下载器
  // (.part + 限额前置 + 单遍 sha256 + 原子 rename;失败分类回警告,绝不产出看似成功的最终文件)。
  const used = new Set<string>()
  for (const meta of metas) {
    const desired = sanitizeArtifactName(meta.name, `artifact-${meta.id}`)
    // #901: 折叠比较(NFC + toLowerCase),跨大小写不敏感文件系统持续成立;读盘而非只查内存 set,
    // 才能挡住"先后分开下载"的场次(不是同一批内的问题)。
    const name = reserveArtifactSavedName(artifactsDir, desired, meta.id, used)
    const target = safeResolveInAlpha(projectDir, "runs", runId, "artifacts", name)
    if (!target) {
      warnings.push(`artifact ${meta.id}: refused unsafe name`)
      continue
    }
    const got = await deps.download(meta, target, runId)
    if (!got.ok) {
      warnings.push(`artifact ${meta.id}: ${got.error}${got.detail ? ` (${got.detail})` : ""}`)
      continue
    }
    files.push(path.join("artifacts", name))
    // REQ-093 集成缝:完整 descriptor 才入 manifest;legacy meta 不合成假 descriptor,
    // 由 artifact-service 的 legacyFiles 只读发现兜底。
    if (deps.register) {
      const check = validateArtifactDescriptor(meta)
      if (check.ok) {
        const reg = deps.register({
          descriptor: meta as unknown as ArtifactDescriptor,
          savedPath: `artifacts/${name}`,
          verifiedSha256: got.sha256,
        })
        if (!reg.ok) warnings.push(`artifact ${meta.id}: manifest 登记失败 — ${reg.reason ?? "unknown"}`)
      } else {
        warnings.push(`artifact ${meta.id}: legacy meta 未入 manifest(legacyFiles 只读呈现)`)
      }
    }
  }

  return { ok: true, dir: runDir, files, warnings }
}
