// REQ-131 / #1130 —— Settings「工具」节的「当前项目目录」:策略按 (账户, 项目) 分区,所以这一节要知道
// 用户此刻站在哪个项目里。输入只有两样、都是壳层已有的,不另建第二份真相:路由,以及会话 id → 目录
// 的查表。查表 = 侧栏项目清单 → 会话页登记的活会话身份(`#1361`,见 sessionDirectoryFromShell)。
import type { Route } from "../../shared/route-manifest"
import type { AlphaProjectsStore } from "../sidebar/use-projects"
import type { AlphaSessionIdentity } from "./session-workspace/session-workspace-core"

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

/**
 * 壳层的会话目录查表(`#1361`):**先**侧栏项目清单,清单缺这一格再回落到**会话页此刻登记的身份**
 * (`active-session-directory.ts`)。
 *
 * 两者不是两份真相:回落那一支就是会话页自己在用的那个目录
 * (`serverSync().session.data.info[id].directory` → `sessionLiveSnapshotOf` → `identity.directory`),
 * 所以「会话页能用的会话,设置页就能解出它的项目」。侧栏按设计过滤掉一部分会话
 * (`sidebar/worktree-filter.ts`:归档 / 以家目录为根 / 全局 `/` 桶),被过滤掉的那些此前在这里
 * 解成 `undefined`,「工具」节整节退化成「先打开一个项目」—— 那正是本函数闭合的那一格。
 *
 * fail-closed 一步不放宽:清单没有、且没有登记 / 登记的是**别的**会话 ⇒ 仍然 `undefined`;
 * 拒绝,不猜,更不落到默认项目。
 */
export function sessionDirectoryFromShell(
  store: AlphaProjectsStore,
  activeSession: () => AlphaSessionIdentity | undefined,
) {
  const listed = sessionDirectoryFromProjects(store)
  return (sessionID: string): string | undefined => {
    const fromProjects = listed(sessionID)
    if (fromProjects) return fromProjects
    const live = activeSession()
    return live?.sessionID === sessionID ? live.directory : undefined
  }
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
