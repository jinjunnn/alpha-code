// alpha-user-workspace — REQ-071 / ADR-025:`~/Alpha` 用户默认工作目录。
//
// main 单点供给(lazy):只在「目标就是默认工作目录」时 mkdir,绝不代建任意路径;同名被文件
// 占用时不覆盖不清理(返回 null,调用方 loud)。Outputs 可见副本是 `.alpha/runs` 真源之外的
// best-effort 镜像 —— 只在 run 的目标项目就是 ~/Alpha 时发生,失败不抛不阻断回流。
// electron-free、env 可覆盖根目录,整面可单测。

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isSafeRunId, sanitizeArtifactName } from "./alpha-workdir"

/** `~/Alpha`(`ALPHA_USER_WORKSPACE_DIR` 覆盖,测试用)。目录名固定英文 Alpha(ADR-025 拍板④)。 */
export function alphaUserWorkspaceDir(): string {
  return process.env.ALPHA_USER_WORKSPACE_DIR || path.join(os.homedir(), "Alpha")
}

export function isUserWorkspaceDir(dir: string | undefined | null): boolean {
  return !!dir && path.resolve(dir) === path.resolve(alphaUserWorkspaceDir())
}

/** lazy 供给:`dir` 省略或等于默认工作目录时创建(幂等)并返回路径;其他路径一律 no-op 返回
 *  null(本函数不是通用 mkdir——供给面只对 ~/Alpha 成立)。创建失败/被同名文件占用也返回 null。 */
export function ensureUserWorkspaceDir(dir?: string): string | null {
  if (dir !== undefined && !isUserWorkspaceDir(dir)) return null
  const ws = alphaUserWorkspaceDir()
  try {
    fs.mkdirSync(ws, { recursive: true })
    return fs.statSync(ws).isDirectory() ? ws : null
  } catch {
    return null
  }
}

export type VisibleOutputResult = { ok: true; dir: string; files: string[] } | { ok: false; reason: string }

const OUTPUTS_DIRNAME = "Outputs"

/** ADR-025 Outputs 契约:run 目标项目 = ~/Alpha 时,把用户可读交付物复制到
 *  `~/Alpha/Outputs/<YYYY-MM-DD>-<runId>/`。名字过 sanitizeArtifactName,目标断言在 Outputs
 *  根内;`.alpha/runs` 仍是真源,本函数失败只由调用方记 warning。 */
export function saveVisibleOutputs(
  projectDir: string,
  runId: string,
  files: Array<{ name: string; from: string }>,
  now: Date = new Date(),
): VisibleOutputResult {
  if (!isUserWorkspaceDir(projectDir)) return { ok: false, reason: "not the user workspace" }
  if (!isSafeRunId(runId)) return { ok: false, reason: "unsafe run id" }
  if (files.length === 0) return { ok: false, reason: "no files" }
  const root = path.join(alphaUserWorkspaceDir(), OUTPUTS_DIRNAME)
  const dir = path.resolve(root, `${now.toISOString().slice(0, 10)}-${runId}`)
  if (!dir.startsWith(root + path.sep)) return { ok: false, reason: "path escapes Outputs" }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const written: string[] = []
    for (const f of files) {
      const name = sanitizeArtifactName(f.name, "file.txt")
      const target = path.resolve(dir, name)
      if (!target.startsWith(dir + path.sep)) continue
      try {
        fs.copyFileSync(f.from, target)
        written.push(name)
      } catch {
        // 单文件失败不掀桌:真源在 .alpha/runs,这里是可见镜像
      }
    }
    return written.length > 0 ? { ok: true, dir, files: written } : { ok: false, reason: "no files written" }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 云 run 回流镜像:saveCloudRun 清单里的 artifacts/*(用户可读交付物)→ Outputs。
 *  contract/status 等机器件不镜像(留 `.alpha/runs` 真源)。 */
export function mirrorRunArtifacts(
  projectDir: string,
  runId: string,
  manifest: { dir: string; files: string[] },
): VisibleOutputResult {
  const prefix = `artifacts${path.sep}`
  const files = manifest.files
    .filter((f) => f.startsWith(prefix))
    .map((f) => ({ name: path.basename(f), from: path.join(manifest.dir, f) }))
  return saveVisibleOutputs(projectDir, runId, files)
}
