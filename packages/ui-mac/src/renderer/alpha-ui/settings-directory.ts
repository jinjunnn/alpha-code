// REQ-131 / #1130 —— Settings「工具」节的「当前项目目录」:策略按 (账户, 项目) 分区,所以这一节要知道
// 用户此刻站在哪个项目里。唯一输入是路由 + 壳层已有的项目/会话清单,不另建第二份真相。
import type { Route } from "../../shared/route-manifest"
import type { AlphaProjectsStore } from "../sidebar/use-projects"

/**
 * 路由 → 目录。与 session-workspace-core.ts 同一条规则:`route.directory ?? 会话清单里该 id 的目录`。
 * 桌面所有生产导航走 canonical `/server/:serverKey/session/:id`,该路由**自己不带目录**
 * (`ResolvedRoute.directory` 恒 undefined),目录只能按会话 id 从壳层清单查;带目录的形状
 * (`directory` / legacy)都是 redirect 型,用户停不住,但同样认。
 * 首页 / 草稿页 / 恢复页、或清单里没有这个会话 ⇒ undefined ⇒ 该节显示「先打开一个项目」(fail-closed,不猜)。
 */
export function settingsDirectoryOf(
  route: Route,
  sessionDirectory: (sessionID: string) => string | undefined,
): string | undefined {
  if (route.kind === "directory") return route.directory
  if (route.kind !== "session") return undefined
  return route.directory ?? (route.id ? sessionDirectory(route.id) : undefined)
}

/** 壳层项目清单里按会话 id 查目录(`AlphaSession.directory`,与侧栏导航同一份数据)。 */
export function sessionDirectoryFromProjects(store: AlphaProjectsStore) {
  return (sessionID: string): string | undefined => {
    for (const project of store.projects) {
      const session = project.sessions.find((item) => item.id === sessionID)
      if (session) return session.directory
    }
    return undefined
  }
}
