// REQ-131 / #1130 —— 「工具」节的当前项目目录必须从**生产导航真正走的路由**解得出来。
// 桌面所有生产导航走 canonical `/server/:serverKey/session/:id`(`hrefFor.session`),该路由的
// `ResolvedRoute.directory` 恒 `undefined`(shared/route-manifest.ts);目录只能从壳层会话清单按 id 查。
// 只认 `route.directory` 的实现在真实会话页上永远给出「先打开一个项目」—— 这条测试就是为了让那个实现红。
import { describe, expect, test } from "bun:test"
import { hrefFor, parseRoute } from "../../shared/route-manifest"
import type { AlphaProjectsStore } from "../sidebar/use-projects"
import { sessionDirectoryFromProjects, settingsDirectoryOf } from "./settings-directory"

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
