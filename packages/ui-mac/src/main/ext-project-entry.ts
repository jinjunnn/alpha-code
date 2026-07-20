import { homedir } from "node:os"
import { resolveProjectAlphaRoot } from "./alpha-workdir"

export type ProjectIpcEntry = { ok: true; projectDir: string; root: string } | { ok: false; reason: string }

/** 所有 main 项目 IPC 的统一三态入口；project 分支只暴露已验证的 canonical 路径与 root。 */
export function resolveProjectIpcEntry(projectDir: unknown, homeDir: string = homedir()): ProjectIpcEntry {
  if (typeof projectDir !== "string") return { ok: false, reason: "projectDir: required absolute path" }
  const resolved = resolveProjectAlphaRoot(projectDir, homeDir)
  if (resolved.status !== "project") return { ok: false, reason: `fail closed: ${resolved.reason}` }
  return { ok: true, projectDir: resolved.projectDir, root: resolved.root }
}

/** 异步边界后的 I/O 夹逼：仍是准入时同一 canonical project/root 才执行 operation。 */
export function withProjectIpcEntryIdentity<T>(
  expected: Extract<ProjectIpcEntry, { ok: true }>,
  homeDir: string,
  operation: (project: Extract<ProjectIpcEntry, { ok: true }>) => T,
): { ok: true; value: T } | { ok: false; reason: string } {
  const current = resolveProjectIpcEntry(expected.projectDir, homeDir)
  if (!current.ok || current.projectDir !== expected.projectDir || current.root !== expected.root)
    return { ok: false, reason: "fail closed: project alpha root identity drifted" }
  // 分类重验到紧随的一次路径 I/O 仍有微秒级窗口；沿用 #358 r3 threat model，不引入 openat。
  return { ok: true, value: operation(current) }
}

/** handler 级前置门：身份拒绝时 admitted body（adoption/probe/read/write）零调用。 */
export function projectIpcHandler<E, Refused, Admitted>(
  homeDir: string,
  refused: (reason: string) => Refused,
  admitted: (event: E, project: Extract<ProjectIpcEntry, { ok: true }>) => Promise<Admitted>,
): (event: E, projectDir: unknown) => Promise<Refused | Admitted> {
  return async (event, projectDir) => {
    const project = resolveProjectIpcEntry(projectDir, homeDir)
    if (!project.ok) return refused(project.reason)
    return admitted(event, project)
  }
}
