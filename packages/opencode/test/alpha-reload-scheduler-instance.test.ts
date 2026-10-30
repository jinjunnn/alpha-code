// REQ-234 `#1531` I5 —— ext 重载调度器对**真实例**的判定(alpha 自有测试;north-star:alpha-owned)。
//
// 被测是 @alpha-code/ext 的生产调度器(packages/ext/src/reload-scheduler.ts),喂给它的是引擎递给插件的同一种 client:
// v1 SDK 经引擎**真 HTTP 应用**(Server.Default().app.fetch,与引擎自己的 v1 SDK 冒烟测试同形)按目录打到真实例。
//   · busy 会话 = 引擎自己的 SessionStatus 服务在该实例里置 busy —— 调度器经 `GET /session/status` 读到它(先证明这条读得到);
//   · 「查询超时」的实例替身**只替换 HTTP 层**:该 client 的 fetch 对 `/session/status` 永不返回,其余照常进引擎;
//   · dispose 计数在 HTTP 层观察(`POST /instance/dispose` 真的发出去几次),不桩调度器的任何部分。
// 「两次查空闲到 dispose 之间的准入」是登记在案的接口缺口(基线 §2.6),本判据不假装覆盖。
//   · 「查询超时」的时钟由测试掌控,不交给墙钟(见 installStatusClock)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Effect } from "effect"
import { createReloadScheduler, type ReloadReport } from "../../ext/src/reload-scheduler"
import { AppRuntime } from "../src/effect/app-runtime"
import { InstanceRef } from "../src/effect/instance-ref"
import { InstanceRuntime } from "../src/project/instance-runtime"
import { SessionID } from "../src/session/schema"
import { SessionStatus } from "../src/session/status"
import { Server } from "../src/server/server"
import { resetDatabase } from "./fixture/db"
import { disposeAllInstances, tmpdir } from "./fixture/fixture"

/**
 * 调度器给每次 `session.status` 查询配一只 `setTimeout(…, statusTimeoutMs)`。这里只截下延时恰为
 * STATUS_TIMEOUT_MS 的计时器,由测试在「该超时」的那一刻手动触发;其余计时器(引擎内部)照常走真 setTimeout。
 * 修前用真 300ms:冷实例的首查(实例引导)在负载下超过 300ms ⇒ 恢复后那一轮被判 unknown ⇒ 零 dispose,
 * 用例 2 在本机负载下 6 跑 4 红。现在真查询无论多慢都不会被墙钟判成超时,而悬着的那一个仍由真的超时路径判掉。
 * 截取失效(调度器没走到这里)时,这个延时长到让用例 2 卡到 60s 超时 —— 响亮地红,不会静默变绿。
 */
const STATUS_TIMEOUT_MS = 9_999_017
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const statusTimers = new Map<object, () => void>()
const statusHandles = new WeakSet<object>()
let clearedStatusTimers = 0

beforeEach(() => {
  statusTimers.clear()
  clearedStatusTimers = 0
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== STATUS_TIMEOUT_MS) return realSetTimeout(fn, ms, ...args)
    const handle = {}
    statusHandles.add(handle)
    statusTimers.set(handle, () => fn(...args))
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle?: unknown) => {
    if (handle && typeof handle === "object" && statusHandles.has(handle)) {
      if (statusTimers.delete(handle)) clearedStatusTimers += 1
      return
    }
    realClearTimeout(handle as Parameters<typeof clearTimeout>[0])
  }) as typeof clearTimeout
})

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  await disposeAllInstances()
  await resetDatabase()
})

/** 等到 `answered` 次查询已经答完(它们的计时器被调度器清掉),再让仍悬着的查询全部超时。等的是事件,不是时长。 */
async function expireHangingStatusAfter(answered: number) {
  while (clearedStatusTimers < answered || statusTimers.size === 0) await new Promise((resolve) => realSetTimeout(resolve, 5))
  const pending = [...statusTimers.values()]
  statusTimers.clear()
  for (const fire of pending) fire()
}

/** 引擎递给插件的同款 v1 client;fetch 先过一层记录(可选地对 /session/status 永不返回)。 */
function engineClient(directory: string, opts: { hangStatus?: () => boolean } = {}) {
  const disposes: string[] = []
  const client = createOpencodeClient({
    baseUrl: "http://test",
    directory,
    fetch: (async (req: Request) => {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/instance/dispose") disposes.push(directory)
      if (url.pathname === "/session/status" && opts.hangStatus?.()) return new Promise<Response>(() => {})
      return Server.Default().app.fetch(req)
    }) as unknown as typeof fetch,
  })
  return { client, disposes }
}

async function setStatus(directory: string, sessionID: string, type: "busy" | "idle") {
  const ctx = await InstanceRuntime.load({ directory })
  await AppRuntime.runPromise(
    SessionStatus.Service.use((status) => status.set(SessionID.make(sessionID), { type })).pipe(Effect.provideService(InstanceRef, ctx)),
  )
}

function scheduler() {
  const reports: ReloadReport[] = []
  const errors: string[] = []
  const s = createReloadScheduler({
    report: (report) => void reports.push(report),
    log: () => {},
    error: (line) => void errors.push(line),
    statusTimeoutMs: STATUS_TIMEOUT_MS,
  })
  return { s, reports, errors }
}

describe("I5:ext 调度器 × 真实例的 session.status", () => {
  test("真实例里有 busy 会话 ⇒ 零 dispose、报 waiting;它转 idle ⇒ 恰好一次 POST /instance/dispose、报 reloaded", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const a = engineClient(tmp.path)
    await setStatus(tmp.path, "ses_1531_busy", "busy")
    // 先证明手段:引擎的 /session/status 真的报出这个 busy 会话
    const seen = (await a.client.session.status()) as { data?: Record<string, { type: string }> }
    expect(seen.data?.ses_1531_busy?.type).toBe("busy")

    const { s, reports } = scheduler()
    s.register(tmp.path, a.client)
    s.request({ generation: 1, scope: "global", reason: "installed skill writer" })
    await s.settled()
    expect(a.disposes).toHaveLength(0)
    expect(reports).toEqual([{ generation: 1, scope: "global", outcome: "waiting", directories: [tmp.path], error: "1 session(s) busy" }])

    await setStatus(tmp.path, "ses_1531_busy", "idle")
    s.poke()
    await s.settled()
    expect(a.disposes).toEqual([tmp.path])
    expect(reports.at(-1)).toEqual({ generation: 1, scope: "global", outcome: "reloaded", directories: [tmp.path] })
  }, 60_000)

  test("一个实例的状态查询超时(只换 HTTP 层)⇒ 零 dispose,force 也不例外;日志点名该目录;它没被注销,查询恢复后照常参与", async () => {
    await using idle = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using stuck = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    let hang = true
    const a = engineClient(idle.path)
    const b = engineClient(stuck.path, { hangStatus: () => hang })
    const { s, reports, errors } = scheduler()
    s.register(idle.path, a.client)
    s.register(stuck.path, b.client)
    s.request({ generation: 2, scope: "global", reason: "user: reload now", force: true })
    // idle 那一查答完之后,只剩 stuck 那只悬着 ⇒ 让它超时(走调度器真的超时路径)
    await expireHangingStatusAfter(1)
    await s.settled()
    expect([...a.disposes, ...b.disposes]).toHaveLength(0)
    expect(reports).toEqual([
      { generation: 2, scope: "global", outcome: "waiting", directories: [idle.path, stuck.path], error: "engine status unavailable — restart the app if this persists" },
    ])
    expect(errors.some((line) => line.includes(stuck.path))).toBe(true)

    hang = false
    s.poke()
    await s.settled()
    expect(a.disposes).toEqual([idle.path])
    expect(b.disposes).toEqual([stuck.path])
    expect(reports.at(-1)).toMatchObject({ generation: 2, outcome: "reloaded" })
  }, 60_000)

  // 「装完下一条消息可用」在引擎这一端的那一半:实例建好之后才落盘的技能,实例在重载之前看不见(引擎侧无文件监听);
  // 调度器等会话空闲、恰好一次 dispose 之后,下一次读(= 下一条消息)就看得见。前一半(安装体落盘 + 请 ext 重载)是
  // ui-mac test-component/ext-install-catalog-result.cases.ts 的项目作用域与金丝雀两条;中间那一跳(parentPort → 调度器)是
  // packages/ext/src/plugin-reload-wiring.cases.ts。
  test("实例建好后才落盘的技能:重载前看不见;会话忙 ⇒ 仍看不见(零 dispose);空闲 ⇒ dispose 之后下一次读就看见了", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const a = engineClient(tmp.path)
    // GET /skill(v1 SDK 没生成这条;经同一个引擎 HTTP 应用、按目录读)
    const skillNames = async () => {
      const response = await Server.Default().app.fetch(new Request(`http://test/skill?directory=${encodeURIComponent(tmp.path)}`))
      expect(response.status).toBe(200)
      return ((await response.json()) as Array<{ name: string }>).map((skill) => skill.name)
    }
    expect(await skillNames()).not.toContain("alpha-1531-writer")
    const dir = path.join(tmp.path, ".agents", "skills", "alpha-1531-writer")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: alpha-1531-writer\ndescription: writes things for the #1531 closure test\n---\n\nWrite.\n")
    expect(await skillNames()).not.toContain("alpha-1531-writer")

    await setStatus(tmp.path, "ses_1531_reply", "busy")
    const { s, reports } = scheduler()
    s.register(tmp.path, a.client)
    s.request({ generation: 3, scope: "global", reason: "installed skill alpha-1531-writer" })
    await s.settled()
    expect(a.disposes).toHaveLength(0)
    expect(await skillNames()).not.toContain("alpha-1531-writer")

    await setStatus(tmp.path, "ses_1531_reply", "idle")
    s.poke()
    await s.settled()
    expect(a.disposes).toEqual([tmp.path])
    expect(reports.at(-1)).toEqual({ generation: 3, scope: "global", outcome: "reloaded", directories: [tmp.path] })
    expect(await skillNames()).toContain("alpha-1531-writer")
  }, 60_000)
})
