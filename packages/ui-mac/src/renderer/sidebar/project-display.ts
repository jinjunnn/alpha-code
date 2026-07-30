import type { AlphaProject, AlphaSession } from "./use-projects"
import { projectLabel } from "./route"

// opencode represents all non-Git directories as one internal "/" project. The data layer keeps
// that project only as a live-update sentinel; the sidebar projects the sessions back to their real
// directories. A residual "/" session is deliberately omitted: "/" is never a user-facing project.
export function projectSidebarGroups(projects: AlphaProject[]): AlphaProject[] {
  const result: AlphaProject[] = []
  for (const project of projects) {
    if (project.worktree !== "/") {
      result.push(project)
      continue
    }
    const groups = new Map<string, AlphaSession[]>()
    for (const session of project.sessions) {
      if (!session.directory || session.directory === "/") continue
      const list = groups.get(session.directory)
      if (list) list.push(session)
      else groups.set(session.directory, [session])
    }
    const entries = [...groups.entries()].sort((a, b) => (b[1][0]?.updated ?? 0) - (a[1][0]?.updated ?? 0))
    for (const [directory, sessions] of entries) {
      result.push({
        id: `global:${directory}`,
        worktree: directory,
        name: projectLabel(directory),
        color: undefined,
        directories: [directory],
        sessions,
        loaded: project.loaded,
      })
    }
  }
  return result
}
