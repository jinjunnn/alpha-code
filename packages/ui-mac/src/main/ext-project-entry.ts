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
