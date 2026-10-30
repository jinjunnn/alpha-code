// reload-scheduler — REQ-234 `#1531`(基线 §2.6,不变量 I5):引擎重载的**唯一执行者**。
//
// 一个引擎进程一份(插件模块被 import 缓存;plugin.ts 在模块作用域建它)。三类来源都进同一个队列:
//   ① alpha_reload / alpha_register(进程内,无 generation,不向 main 报告);
//   ② main 经 parentPort 发来的 `alpha.reload.request`(定制中心按钮、安装体、信任门 / 外部导入,带 generation);
//   ③ 用户在定制中心点「现在重载」= ② 带 `force`。
//
// 决定规则(I5):
//   · 相关实例 = global ⇒ 全部已登记实例;{ directory } ⇒ 该目录的实例(没登记 = 那个目录此刻没有加载着的实例,
//     下一次加载自然读到盘上的新东西 ⇒ 直接算 reloaded,不去 dispose 一个不存在的实例)。
//   · 逐实例问 `session.status()`(引擎本实例的权威,不靠事件流的快照 / 重放)。**任一实例查不到(超时 / 错误 / 形状不对)
//     ⇒ 本轮零 dispose**,日志点名该目录,`force` 也不例外 —— 查不到不等于空闲。
//   · 有会话在忙且不是 force ⇒ 零 dispose,等下一次 `session.status` 事件再判。
//   · 全部明确空闲(或 force)⇒ **再查一次**(把「查到 dispose」的窗口压到一次进程内 HTTP 往返;这一次也不许查不到)
//     ⇒ 每个相关实例恰好一次 dispose ⇒ 向 main 逐个 generation 报 reloaded。
//   · dispose 失败 ⇒ 保留队列、报 failed、下一次事件再试;连败 3 次停止自动重试(仍报最后一条 failed)。绝不降级成「可用」。
//   · 一直忙(> 5 分钟):只记一行日志,继续等 —— 不打断(约束 4);用户要立刻生效走 force。
//
// 实例登记:每次 AlphaExt(input) 初始化登记 { directory, client };**只因插件自己的 dispose 钩子注销**(引擎销毁实例时逐插件
// 调用它)。查询失败不注销、不猜。登记接口缺口:引擎没有「暂停会话准入」,两次查空闲与 dispose 之间仍可能有新回合被准入
// (基线 §2.6 登记在案,本模块不假装覆盖)。
//
// 报给 main 的 `error` 文本会原样出现在定制中心(只进 title),所以只写给人看的短句,不放异常原文与内部细节;
// 细节进本进程日志。

import type { ReloadOutcome, ReloadScope } from "../../ui-mac/src/main/alpha-sidecar-messages"
import type { EngineFetch } from "../../ui-mac/src/main/in-process-engine"

/** 引擎递给插件的 v1 SDK client 里本模块用到的两样(与 `input.client` 同形)。 */
export type ReloadClient = {
  session: { status(): Promise<unknown> }
  instance: { dispose(): Promise<unknown> }
}

/** 进程内调用本实例的引擎路由(带目录头与 server 口令),返回 hey-api 同形信封。`#1553` 的附件读取指令也经它读 `/mcp`。 */
export function inProcessEngineRequest(engineFetch: EngineFetch, directory: string, env: NodeJS.ProcessEnv = process.env) {
  const password = env.OPENCODE_SERVER_PASSWORD
  const authorization = password ? `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64")}` : undefined
  return async (method: "GET" | "POST", path: string): Promise<{ data?: unknown; error?: { status: number } }> => {
    const url = new URL(path, "http://alpha-engine.invalid")
    url.searchParams.set("directory", directory)
    const response = await engineFetch(
      new Request(url, { method, headers: { "x-opencode-directory": encodeURIComponent(directory), ...(authorization ? { authorization } : {}) } }),
    )
    if (!response.ok) return { error: { status: response.status } }
    return { data: await response.json() }
  }
}

/**
 * 审计 R1 Major 1:**进程内**问引擎的 client(GET /session/status、POST /instance/dispose)。引擎一监听,插件拿到的 input.client
 * 就走 TCP 连自己的端口,而出货围栏只放行出网代理端口 ⇒ 那条连接被拒(process-fence-engine.test.ts 的 #1531 三臂实测)。
 * 这里经 sidecar 交来的 app.fetch 直接进引擎(与 sidecar 的 prewarm 同一调用方式),目录与凭据和 v1 SDK 同形
 * (`?directory=` + `x-opencode-directory`;Basic = OPENCODE_SERVER_USERNAME / PASSWORD,引擎自己的 ServerAuth 读的就是它们)。
 */
export function inProcessReloadClient(engineFetch: EngineFetch, directory: string, env: NodeJS.ProcessEnv = process.env): ReloadClient {
  const call = inProcessEngineRequest(engineFetch, directory, env)
  return { session: { status: () => call("GET", "/session/status") }, instance: { dispose: () => call("POST", "/instance/dispose") } }
}

export type ReloadRequestInput = {
  /** main 的代际;进程内请求没有。 */
  generation?: number
  scope: ReloadScope
  reason: string
  force?: boolean
}

export type ReloadReport = { generation: number; scope: ReloadScope; outcome: ReloadOutcome; directories: string[]; error?: string }

export type ReloadScheduler = {
  register(directory: string, client: ReloadClient): void
  /** 只有 client 与登记的是同一个才注销(同目录重建已覆盖旧项时,旧实例迟到的 dispose 不得注销新实例)。 */
  unregister(directory: string, client: ReloadClient): void
  request(input: ReloadRequestInput): void
  /** 会话状态变了(`session.status` / `session.idle`)或别的值得重判的时刻。 */
  poke(): void
  /** 当前一轮判定(含它触发的后续轮)全部结束。 */
  settled(): Promise<void>
}

type Queued = { generation?: number; scope: ReloadScope; reason: string; force: boolean; since: number }
type Census = { busy: number; unknown: string[] }

const STATUS_TIMEOUT_MS = 3_000
const MAX_FAILURES = 3
const LONG_WAIT_MS = 5 * 60 * 1000

export function createReloadScheduler(deps: {
  report: (report: ReloadReport) => void
  log: (line: string) => void
  error: (line: string) => void
  statusTimeoutMs?: number
  now?: () => number
}): ReloadScheduler {
  const statusTimeoutMs = deps.statusTimeoutMs ?? STATUS_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const instances = new Map<string, ReloadClient>()
  let queue: Queued[] = []
  let failures = 0
  let running: Promise<void> | undefined
  let again = false
  const lastWaiting = new Map<number, string>()
  const longWaitLogged = new Set<Queued>()

  const keyOf = (scope: ReloadScope) => (scope === "global" ? "global" : `dir:${scope.directory}`)

  async function busyIn(directory: string, client: ReloadClient): Promise<number | "unknown"> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        client.session.status(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${statusTimeoutMs}ms`)), statusTimeoutMs)
        }),
      ])
      const data = (response as { data?: unknown; error?: unknown } | undefined)?.data
      if (!response || typeof response !== "object" || (response as { error?: unknown }).error !== undefined || !data || typeof data !== "object" || Array.isArray(data))
        throw new Error("session status unreadable")
      return Object.values(data as Record<string, unknown>).filter(
        (status) => !(status && typeof status === "object" && (status as { type?: unknown }).type === "idle"),
      ).length
    } catch (error) {
      deps.error(`[@alpha-code/ext] reload: session status of ${directory} unknown — ${error instanceof Error ? error.message : String(error)}`)
      return "unknown"
    } finally {
      clearTimeout(timer)
    }
  }

  async function census(directories: string[]): Promise<Census> {
    const results = await Promise.all(directories.map(async (directory) => [directory, await busyIn(directory, instances.get(directory)!)] as const))
    return {
      busy: results.reduce((sum, [, value]) => sum + (value === "unknown" ? 0 : value), 0),
      unknown: results.filter(([, value]) => value === "unknown").map(([directory]) => directory),
    }
  }

  function reportAll(members: Queued[], outcome: ReloadOutcome, directories: string[], error?: string) {
    for (const member of members) {
      if (member.generation === undefined) continue
      if (outcome === "waiting") {
        // 同一条原因不重复报(每个会话事件都会重判一次)。
        if (lastWaiting.get(member.generation) === error) continue
        lastWaiting.set(member.generation, error ?? "")
      } else lastWaiting.delete(member.generation)
      deps.report({ generation: member.generation, scope: member.scope, outcome, directories, ...(error ? { error } : {}) })
    }
  }

  function settle(members: Queued[]) {
    const done = new Set(members)
    queue = queue.filter((item) => !done.has(item))
    for (const member of members) longWaitLogged.delete(member)
  }

  /** 一组 = 同一 scope 的全部排队项。结束(reloaded / 连败放弃)⇒ 出队;等待或可重试的失败 ⇒ 留在队里。 */
  async function runGroup(members: Queued[]): Promise<void> {
    const scope = members[0]!.scope
    const force = members.some((member) => member.force)
    const reasons = [...new Set(members.map((member) => member.reason))].join("; ")
    const directories = scope === "global" ? [...instances.keys()] : instances.has(scope.directory) ? [scope.directory] : []
    if (directories.length === 0) {
      deps.log(`[@alpha-code/ext] reload: nothing loaded for ${scope === "global" ? "any directory" : scope.directory} — the next load reads the new state (${reasons})`)
      reportAll(members, "reloaded", [])
      settle(members)
      return
    }
    for (const pass of [1, 2]) {
      const seen = await census(directories)
      if (seen.unknown.length > 0) {
        deps.error(`[@alpha-code/ext] reload: zero dispose — engine status unknown for ${seen.unknown.join(", ")}${force ? " (force does not override this)" : ""}`)
        reportAll(members, "waiting", directories, "engine status unavailable — restart the app if this persists")
        return
      }
      if (!force && seen.busy > 0) {
        const first = members[0]!
        if (now() - first.since > LONG_WAIT_MS && !longWaitLogged.has(first)) {
          longWaitLogged.add(first)
          deps.log(`[@alpha-code/ext] reload: still waiting after 5 minutes — ${seen.busy} session(s) busy (${reasons})`)
        }
        if (pass === 2) deps.log(`[@alpha-code/ext] reload: a session became busy between the two status checks — waiting again`)
        reportAll(members, "waiting", directories, `${seen.busy} session(s) busy`)
        return
      }
    }
    const targets = directories.map((directory) => [directory, instances.get(directory)!] as const)
    const failed: string[] = []
    for (const [directory, client] of targets) {
      try {
        const result = await client.instance.dispose()
        if (result && typeof result === "object" && (result as { error?: unknown }).error !== undefined)
          throw new Error(`dispose returned ${JSON.stringify((result as { error?: unknown }).error).slice(0, 200)}`)
      } catch (error) {
        failed.push(directory)
        deps.error(`[@alpha-code/ext] reload: dispose of ${directory} failed — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failed.length === 0) {
      failures = 0
      deps.log(`[@alpha-code/ext] reload executed for ${directories.length} instance(s)${force ? " (forced)" : ""} — ${reasons}`)
      reportAll(members, "reloaded", directories)
      settle(members)
      return
    }
    failures += 1
    if (failures >= MAX_FAILURES) {
      failures = 0
      deps.error(`[@alpha-code/ext] reload FAILED ${MAX_FAILURES}x — giving up; changes appear after an app restart (${reasons})`)
      reportAll(members, "failed", directories, `reload failed ${MAX_FAILURES} times — restart the app to apply`)
      settle(members)
      return
    }
    reportAll(members, "failed", directories, `reload failed (attempt ${failures}/${MAX_FAILURES}); retrying when the engine is idle`)
  }

  async function runOnce() {
    // global 先判:它成功时一次 dispose 覆盖全部已登记实例,同轮里已被它重载过的目录组随之结束。
    // global 没结束(某个实例在忙 / 查不到 / dispose 失败)**不挡**目录组(审计 R1 Major 4):每个目录组照常独立判定 ——
    // 否则一个一直忙的项目会让别的项目的重载(含用户点的「现在重载」)永远排不上。
    const groups = new Map<string, Queued[]>()
    for (const item of queue) groups.set(keyOf(item.scope), [...(groups.get(keyOf(item.scope)) ?? []), item])
    const global = groups.get("global")
    groups.delete("global")
    if (global) {
      const covered = [...instances.keys()]
      await runGroup(global)
      if (!queue.some((item) => global.includes(item))) {
        const swept = queue.filter((item) => item.scope !== "global" && (covered.includes(item.scope.directory) || !instances.has(item.scope.directory)))
        reportAll(swept, "reloaded", covered)
        settle(swept)
      }
    }
    for (const members of groups.values()) {
      const pending = members.filter((member) => queue.includes(member))
      if (pending.length > 0) await runGroup(pending)
    }
  }

  function tick() {
    if (running) {
      again = true
      return
    }
    running = (async () => {
      try {
        do {
          again = false
          if (queue.length > 0) await runOnce()
        } while (again)
      } catch (error) {
        deps.error(`[@alpha-code/ext] reload scheduler failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        running = undefined
      }
    })()
  }

  return {
    register(directory, client) {
      // 不在这里重判:登记发生在该实例自己的插件初始化里,此刻问它的 session.status 只会等它加载完或超时。
      instances.set(directory, client)
    },
    unregister(directory, client) {
      if (instances.get(directory) === client) instances.delete(directory)
    },
    request(input) {
      // main 在 sidecar ready 时会重发全部在途代际:同一 generation 只排一次(幂等)。
      if (input.generation !== undefined && queue.some((item) => item.generation === input.generation)) return tick()
      queue.push({
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
        scope: input.scope === "global" ? "global" : { directory: input.scope.directory },
        reason: input.reason,
        force: input.force === true,
        since: now(),
      })
      tick()
    },
    poke() {
      if (queue.length > 0) tick()
    },
    async settled() {
      while (running) await running
    },
  }
}
