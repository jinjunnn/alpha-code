// REQ-131 / #1130 —— 「工具」节的当前项目目录必须从**生产导航真正走的路由**解得出来。
// 桌面所有生产导航走 canonical `/server/:serverKey/session/:id`(`hrefFor.session`),该路由的
// `ResolvedRoute.directory` 恒 `undefined`(shared/route-manifest.ts);目录只能从壳层会话清单按 id 查。
// 只认 `route.directory` 的实现在真实会话页上永远给出「先打开一个项目」—— 这条测试就是为了让那个实现红。
import { describe, expect, test } from "bun:test"
import { hrefFor, parseRoute } from "../../shared/route-manifest"
import type { AlphaProjectsStore } from "../sidebar/use-projects"
import { shouldSkipWorktree } from "../sidebar/worktree-filter"
import type { AlphaSessionIdentity } from "./session-workspace/session-workspace-core"
import { sessionDirectoryFromProjects, sessionDirectoryFromShell, settingsDirectoryOf } from "./settings-directory"

const DIRECTORY = "/Users/kai/app/kama-bot-local"
const OTHER = "/Users/kai/app/other"

function store(): AlphaProjectsStore {
  return {
    ready: true,
    error: false,
    projects: [
      {
        id: "prj_other",
        worktree: OTHER,
        name: "other",
        directories: [OTHER],
        loaded: true,
        sessions: [{ id: "ses_other", title: "other", directory: OTHER, projectID: "prj_other", updated: 1 }],
      },
      {
        id: "prj_kama",
        worktree: DIRECTORY,
        name: "kama-bot-local",
        directories: [DIRECTORY],
        loaded: true,
        sessions: [{ id: "ses_123", title: "hello", directory: DIRECTORY, projectID: "prj_kama", updated: 2 }],
      },
    ],
  }
}

describe("settings directory — from the routes production navigation really uses", () => {
  test("canonical /server/:serverKey/session/:id resolves through the shell's session list", () => {
    const href = hrefFor.session("sidecar", "ses_123")
    expect(href).toBe("/server/c2lkZWNhcg/session/ses_123")
    const route = parseRoute(href)
    // 前提自证:这条路由自己不带目录 —— 只认 route.directory 的实现就是在这里失守的。
    expect(route.kind).toBe("session")
    expect((route as { directory?: string }).directory).toBeUndefined()
    expect(settingsDirectoryOf(route, sessionDirectoryFromProjects(store()))).toBe(DIRECTORY)
  })

  test("a session the shell has not listed yields no directory (fail-closed, not a guess)", () => {
    const route = parseRoute(hrefFor.session("sidecar", "ses_unknown"))
    expect(settingsDirectoryOf(route, sessionDirectoryFromProjects(store()))).toBeUndefined()
  })

  test("home and the draft page are not inside a project", () => {
    expect(settingsDirectoryOf(parseRoute("/"), sessionDirectoryFromProjects(store()))).toBeUndefined()
    const draft = parseRoute(hrefFor.newSession("draft_1"))
    expect(draft.kind).toBe("newSession")
    expect(settingsDirectoryOf(draft, () => DIRECTORY)).toBeUndefined()
  })

  test("a route that carries its own directory wins over the session lookup", () => {
    const directory = parseRoute(hrefFor.directory(DIRECTORY))
    expect(directory.kind).toBe("directory")
    expect(settingsDirectoryOf(directory, () => OTHER)).toBe(DIRECTORY)
  })
})

// `#1361` —— 侧栏按设计过滤掉一部分会话(`sidebar/worktree-filter.ts`:归档项目 / 以家目录为根 /
// 全局 `/` 桶),而会话页认的是服务端给的会话信息(`serverSync().session.data.info[id]`)。撞上这些
// 会话时,同一个会话在会话页用得好好的,设置页「工具」节却解不出目录、整节退化成「先打开一个项目」。
// 设置面结构上拿不到 ServerSync(它在 ServerSyncProvider 之外),所以闭合方式是**回落到会话页
// 此刻登记的那个身份** —— 回落的值就是会话页自己在用的那个目录,两个面因此同源。
describe("settings directory — 侧栏过滤掉的会话(#1361)", () => {
  const HOME_ROOT = "/Users/kai" // macOS 家目录为根:worktree-filter 恒剔除
  const liveIn = (sessionID: string, directory: string): AlphaSessionIdentity => ({
    serverKey: "sidecar",
    directory,
    sessionID,
  })

  test("前提自证:这个会话确实进不了侧栏清单(只查清单 ⇒ undefined)", () => {
    expect(shouldSkipWorktree(HOME_ROOT, new Set())).toBe(true)
    expect(sessionDirectoryFromProjects(store())("ses_home")).toBeUndefined()
  })

  test("会话页正站在它上面 ⇒ 设置页解出同一个目录", () => {
    const route = parseRoute(hrefFor.session("sidecar", "ses_home"))
    const lookup = sessionDirectoryFromShell(store(), () => liveIn("ses_home", HOME_ROOT))
    expect(settingsDirectoryOf(route, lookup)).toBe(HOME_ROOT)
  })

  test("侧栏清单仍然优先:回落只补缺,不顶替清单里已有的那一格", () => {
    const route = parseRoute(hrefFor.session("sidecar", "ses_123"))
    const lookup = sessionDirectoryFromShell(store(), () => liveIn("ses_123", OTHER))
    expect(settingsDirectoryOf(route, lookup)).toBe(DIRECTORY)
  })

  test("fail-closed 一步不放宽:没登记 / 登记的是别的会话 / 不在会话里 ⇒ 仍然拒绝", () => {
    const route = parseRoute(hrefFor.session("sidecar", "ses_home"))
    expect(settingsDirectoryOf(route, sessionDirectoryFromShell(store(), () => undefined))).toBeUndefined()
    // 登记的是另一个会话 —— 绝不能把它的目录借给当前路由(那正是「猜一个默认项目」)。
    const wrongSession = sessionDirectoryFromShell(store(), () => liveIn("ses_elsewhere", HOME_ROOT))
    expect(settingsDirectoryOf(route, wrongSession)).toBeUndefined()
    // 首页:即使有活会话登记着,也不算「站在一个项目里」。
    const atHome = sessionDirectoryFromShell(store(), () => liveIn("ses_home", HOME_ROOT))
    expect(settingsDirectoryOf(parseRoute("/"), atHome)).toBeUndefined()
  })
})
