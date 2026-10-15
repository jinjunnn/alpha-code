// REQ-234 `#1531`:plugin.ts 模块作用域的那段接线 —— parentPort 监听(模块装载时挂上)→ 重载请求进调度器 → 本实例登记 /
// 会话事件重判 / dispose 钩子注销 → 报告经同一个 port 回 main。宿主 plugin-reload-wiring.test.ts 在**子进程**里跑本文件:
// 插件模块按 URL 缓存、一个进程只装一次,而 parentPort 必须在它装载**之前**就在(与 sidecar 里一样),同进程的别的测试
// 早已把它装成「没有 port」的那一份。这里只替换 Electron 的 parentPort 与引擎 client 的两个方法。
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReloadRequest, parseAlphaSidecarInbound } from "../../ui-mac/src/main/alpha-sidecar-messages"

const sent: unknown[] = []
const listeners: Array<(event: { data: unknown }) => void> = []
;(process as unknown as { parentPort: unknown }).parentPort = {
  postMessage: (message: unknown) => void sent.push(message),
  on: (_event: string, listener: (event: { data: unknown }) => void) => void listeners.push(listener),
}
const deliver = (data: unknown) => listeners.forEach((listener) => listener({ data }))

const root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-plugin-reload-wiring-")))
const globalRoot = join(root, "alpha-code-state", "env", "dev")
mkdirSync(globalRoot, { recursive: true })
mkdirSync(join(root, "workspace"), { recursive: true })
process.env.ALPHA_GLOBAL_DIR = globalRoot
afterAll(() => rmSync(root, { recursive: true, force: true }))

const { AlphaExt } = await import("./plugin")

const reports = () => sent.map((message) => parseAlphaSidecarInbound(message)).filter((m) => m?.type === "alpha.reload.report")
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(sent)}`)
}

test("main 的重载请求 ⇒ 等本实例会话空闲 ⇒ 恰好一次 dispose ⇒ 报 reloaded;dispose 钩子之后不再 dispose 这个实例", async () => {
  // 监听在 AlphaExt 被调用之前就在了(模块装载时挂上)
  expect(listeners).toHaveLength(1)
  const engine = { busy: true, disposes: 0 }
  const client = {
    instance: { dispose: async () => (engine.disposes++, { data: true }) },
    session: { status: async () => ({ data: engine.busy ? { ses_1: { type: "busy" } } : {} }) },
    provider: { list: async () => ({ data: { all: [], default: {}, connected: [] } }) },
  }
  const hooks = (await AlphaExt({ directory: join(root, "workspace"), worktree: join(root, "workspace"), client } as never)) as unknown as {
    event: (input: { event: { type: string; properties: unknown } }) => Promise<void>
    dispose: () => Promise<void>
    tool: Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> }>
  }
  deliver(buildReloadRequest({ generation: 7, scope: "global", items: [{ id: "skill:writer", scope: "global" }], reason: "installed skill writer" }))
  await until(() => reports().length === 1, "the waiting report")
  expect(reports()[0]).toEqual({
    type: "alpha.reload.report",
    generation: 7,
    scope: "global",
    outcome: "waiting",
    directories: [join(root, "workspace")],
    error: "1 session(s) busy",
  })
  expect(engine.disposes).toBe(0)

  // alpha_reload 进同一个调度器:会话还忙 ⇒ 不立刻 dispose
  await hooks.tool.alpha_reload!.execute({ reason: "made a skill" }, { sessionID: "ses_1", directory: join(root, "workspace") })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(engine.disposes).toBe(0)

  engine.busy = false
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } })
  await until(() => reports().some((r) => r?.type === "alpha.reload.report" && r.outcome === "reloaded"), "the reloaded report")
  expect(engine.disposes).toBe(1)

  await hooks.dispose()
  deliver(buildReloadRequest({ generation: 8, scope: "global", items: [], reason: "again" }))
  await until(() => reports().length === 3, "the report for generation 8")
  expect(reports().at(-1)).toEqual({ type: "alpha.reload.report", generation: 8, scope: "global", outcome: "reloaded", directories: [] })
  expect(engine.disposes).toBe(1)
})
