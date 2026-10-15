// REQ-234 `#1531` I5 的单元一半(reload-scheduler.ts)。真实例那一半 —— 引擎自己的 `/session/status` 造一个 busy 会话、
// 「查询超时」只替换 HTTP 层 —— 在 packages/opencode/test/alpha-reload-scheduler-instance.test.ts。
// 这里的 client 只替换 v1 SDK 的那两个方法,用来钉调度规则本身:合并、幂等、force 的边界、连败停止、注销身份。
import { describe, expect, test } from "bun:test"
import { createReloadScheduler, type ReloadClient, type ReloadReport } from "./reload-scheduler"

type Status = Record<string, { type: string }> | "hang" | "throw"

function fakeClient(initial: Status = {}) {
  const state = { status: initial as Status, disposes: 0, disposeFails: 0 }
  const client: ReloadClient = {
    session: {
      status: async () => {
        if (state.status === "hang") return new Promise(() => {})
        if (state.status === "throw") throw new Error("ECONNRESET")
        return { data: state.status }
      },
    },
    instance: {
      dispose: async () => {
        state.disposes++
        if (state.disposeFails > 0) {
          state.disposeFails--
          throw new Error("dispose exploded")
        }
        return { data: true }
      },
    },
  }
  return { client, state }
}

function scheduler() {
  const reports: ReloadReport[] = []
  const errors: string[] = []
  const s = createReloadScheduler({ report: (r) => void reports.push(r), log: () => {}, error: (line) => void errors.push(line), statusTimeoutMs: 20 })
  return { s, reports, errors }
}

describe("reload-scheduler(I5 规则)", () => {
  test("有会话在忙 ⇒ 零 dispose、报 waiting(同一原因不重报);全部空闲 ⇒ 每个实例恰好一次 dispose,逐个 generation 报 reloaded", async () => {
    const { s, reports } = scheduler()
    const a = fakeClient({ ses_1: { type: "busy" } })
    const b = fakeClient()
    s.register("/a", a.client)
    s.register("/b", b.client)
    s.request({ generation: 1, scope: "global", reason: "installed skill writer" })
    s.request({ generation: 2, scope: "global", reason: "installed agent reviewer" })
    await s.settled()
    s.poke()
    await s.settled()
    expect(a.state.disposes + b.state.disposes).toBe(0)
    expect(reports).toEqual([
      { generation: 1, scope: "global", outcome: "waiting", directories: ["/a", "/b"], error: "1 session(s) busy" },
      { generation: 2, scope: "global", outcome: "waiting", directories: ["/a", "/b"], error: "1 session(s) busy" },
    ])
    a.state.status = { ses_1: { type: "idle" } }
    s.poke()
    await s.settled()
    expect([a.state.disposes, b.state.disposes]).toEqual([1, 1])
    expect(reports.slice(2)).toEqual([
      { generation: 1, scope: "global", outcome: "reloaded", directories: ["/a", "/b"] },
      { generation: 2, scope: "global", outcome: "reloaded", directories: ["/a", "/b"] },
    ])
    s.poke()
    await s.settled()
    expect([a.state.disposes, b.state.disposes]).toEqual([1, 1])
  })

  test("任一相关实例查不到(超时或报错)⇒ 零 dispose,force 也不例外;日志点名该目录;实例不被注销", async () => {
    const { s, reports, errors } = scheduler()
    const ok = fakeClient()
    const hung = fakeClient("hang")
    s.register("/ok", ok.client)
    s.register("/hung", hung.client)
    s.request({ generation: 7, scope: "global", reason: "user: reload now", force: true })
    await s.settled()
    expect(ok.state.disposes + hung.state.disposes).toBe(0)
    expect(reports).toEqual([
      { generation: 7, scope: "global", outcome: "waiting", directories: ["/ok", "/hung"], error: "engine status unavailable — restart the app if this persists" },
    ])
    expect(errors.some((line) => line.includes("/hung") && line.includes("zero dispose"))).toBe(true)
    hung.state.status = "throw"
    s.poke()
    await s.settled()
    expect(ok.state.disposes + hung.state.disposes).toBe(0)
    // 查询恢复 ⇒ 同一个登记项照常参与(没被当成「已消失」移除)
    hung.state.status = {}
    s.poke()
    await s.settled()
    expect([ok.state.disposes, hung.state.disposes]).toEqual([1, 1])
  })

  test("force 只跳过「等空闲」:有会话在忙也 dispose", async () => {
    const { s, reports } = scheduler()
    const a = fakeClient({ ses_1: { type: "busy" }, ses_2: { type: "retry" } })
    s.register("/a", a.client)
    s.request({ generation: 3, scope: { directory: "/a" }, reason: "user: reload now", force: true })
    await s.settled()
    expect(a.state.disposes).toBe(1)
    expect(reports).toEqual([{ generation: 3, scope: { directory: "/a" }, outcome: "reloaded", directories: ["/a"] }])
  })

  test("两次查空闲之间有会话变忙 ⇒ 第二次查到,零 dispose", async () => {
    const { s, reports } = scheduler()
    let calls = 0
    const client: ReloadClient = {
      session: { status: async () => ({ data: ++calls === 1 ? {} : { ses_9: { type: "busy" } } }) },
      instance: { dispose: async () => ({ data: true }) },
    }
    let disposed = 0
    const spy: ReloadClient = { ...client, instance: { dispose: async () => (disposed++, { data: true }) } }
    s.register("/a", spy)
    s.request({ generation: 4, scope: "global", reason: "x" })
    await s.settled()
    expect(calls).toBe(2)
    expect(disposed).toBe(0)
    expect(reports).toEqual([{ generation: 4, scope: "global", outcome: "waiting", directories: ["/a"], error: "1 session(s) busy" }])
  })

  test("dispose 失败保留重试;连败 3 次停止自动重试,仍报最后一条 failed;绝不报 reloaded", async () => {
    const { s, reports } = scheduler()
    const a = fakeClient()
    a.state.disposeFails = 5
    s.register("/a", a.client)
    s.request({ generation: 5, scope: "global", reason: "x" })
    await s.settled()
    s.poke()
    await s.settled()
    s.poke()
    await s.settled()
    s.poke()
    await s.settled()
    expect(a.state.disposes).toBe(3)
    expect(reports.map((r) => r.outcome)).toEqual(["failed", "failed", "failed"])
    expect(reports.at(-1)?.error).toBe("reload failed 3 times — restart the app to apply")
  })

  test("同一 generation 重发只排一次(sidecar ready 时 main 重发全部在途代际)", async () => {
    const { s, reports } = scheduler()
    const a = fakeClient({ ses_1: { type: "busy" } })
    s.register("/a", a.client)
    s.request({ generation: 6, scope: "global", reason: "x" })
    s.request({ generation: 6, scope: "global", reason: "x" })
    await s.settled()
    a.state.status = {}
    s.poke()
    await s.settled()
    expect(a.state.disposes).toBe(1)
    expect(reports.filter((r) => r.outcome === "reloaded")).toHaveLength(1)
  })

  test("目录作用域:目录没加载着 ⇒ 不 dispose 直接 reloaded;global 成功顺带结束它覆盖到的目录请求;进程内请求不报", async () => {
    const { s, reports } = scheduler()
    const a = fakeClient()
    s.register("/a", a.client)
    s.request({ generation: 8, scope: { directory: "/not-loaded" }, reason: "project mcp" })
    await s.settled()
    expect(a.state.disposes).toBe(0)
    expect(reports).toEqual([{ generation: 8, scope: { directory: "/not-loaded" }, outcome: "reloaded", directories: [] }])
    a.state.status = { ses_1: { type: "busy" } }
    s.request({ scope: { directory: "/a" }, reason: "alpha_reload" })
    s.request({ generation: 9, scope: "global", reason: "installed" })
    await s.settled()
    a.state.status = {}
    s.poke()
    await s.settled()
    expect(a.state.disposes).toBe(1)
    expect(reports.slice(1).filter((r) => r.outcome === "reloaded")).toEqual([{ generation: 9, scope: "global", outcome: "reloaded", directories: ["/a"] }])
    s.poke()
    await s.settled()
    expect(a.state.disposes).toBe(1)
  })

  test("只因同一个 client 注销:同目录重建覆盖后,旧实例迟到的 dispose 钩子不注销新实例", async () => {
    const { s } = scheduler()
    const old = fakeClient()
    const fresh = fakeClient()
    s.register("/a", old.client)
    s.register("/a", fresh.client)
    s.unregister("/a", old.client)
    s.request({ generation: 10, scope: "global", reason: "x" })
    await s.settled()
    expect([old.state.disposes, fresh.state.disposes]).toEqual([0, 1])
    s.unregister("/a", fresh.client)
    s.request({ generation: 11, scope: "global", reason: "y" })
    await s.settled()
    expect(fresh.state.disposes).toBe(1)
  })
})
