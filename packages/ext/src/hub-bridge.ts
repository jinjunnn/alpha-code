// hub-bridge — REQ-234 `#1531`(基线 docs/design/2026-10-14-req234-hub-agent-install-baseline.md §2.2 / §2.6)。
//
// ext 这一侧的 parentPort 请求簿记:agent 的三个定制中心工具经它向 main 问「这个目录的三档视图」与「某次安装请求走到哪一步」,
// main 经它把重载请求交给 ext 调度器、ext 经它把重载结局报回去。合同只有一份 —— ui-mac 的 alpha-sidecar-messages.ts
// (相对路径 import,与 context-injection.ts 引 ui-mac 内容模块同一先例;该文件不依赖 electron / node:fs)。
//
// 形制同 main 侧的 workspace-write-probe:请求带自增 id、应答按 id 结算、超时答「无法判断」。三条纪律:
//   · 监听在**模块装载时**就挂上(createHubBridge 的同步部分)—— main 只在 sidecar ready 那一刻重发排队的重载代际,
//     监听晚挂一步,那一批就丢了;
//   · 只认 `alpha.*`,其余原样不理(sidecar.ts 的 start / stop / write-probe 照旧由它自己处理,两边互不改对方的分支);
//   · 应答形状不对 = 丢弃 + 记一行,请求按超时结算 —— 不带着半个视图去回答 agent。
// 取不到 parentPort(CLI / 测试宿主)⇒ `available: false`,三个工具如实说「本宿主不可用」,不猜。

import {
  buildHubRequestQuery,
  buildHubViewRequest,
  buildReloadReport,
  isAlphaSidecarMessage,
  parseHubRequestReply,
  parseHubViewReply,
  parseReloadRequest,
  type HubRequestRecord,
  type HubView,
  type ReloadOutcome,
  type ReloadRequestMessage,
  type ReloadScope,
} from "../../ui-mac/src/main/alpha-sidecar-messages"

/** Electron utilityProcess 的 `process.parentPort` 里本模块用到的那两样。 */
export type HubPort = {
  postMessage(message: unknown): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

export type BridgeFailure = { ok: false; reason: "unavailable" | "timeout" | "error"; detail: string }

export type HubBridge = {
  readonly available: boolean
  view(input: { directory: string; sessionID?: string; agent?: string; query?: string }): Promise<{ ok: true; view: HubView } | BridgeFailure>
  request(requestId: string): Promise<{ ok: true; record: HubRequestRecord | null } | BridgeFailure>
  report(input: { generation: number; scope: ReloadScope; outcome: ReloadOutcome; directories: string[]; error?: string }): void
  /** main → ext 的重载请求交给谁。只能挂一个(调度器);挂上之前到达的请求按序缓存,挂上时补交。 */
  onReloadRequest(handler: (message: ReloadRequestMessage) => void): void
}

const DEFAULT_TIMEOUT_MS = 20_000

export function createHubBridge(
  port: HubPort | undefined,
  options: { timeoutMs?: number; log?: (line: string) => void } = {},
): HubBridge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.log ?? ((line: string) => console.error(line))
  const pending = new Map<number, { settle: (message: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  const early: ReloadRequestMessage[] = []
  let reloadHandler: ((message: ReloadRequestMessage) => void) | undefined
  let seq = 0

  port?.on("message", (event) => {
    const message = event?.data
    if (!isAlphaSidecarMessage(message)) return
    const type = (message as { type: string }).type
    if (type === "alpha.reload.request") {
      const parsed = parseReloadRequest(message)
      if (!parsed) return log(`[@alpha-code/ext] hub bridge: dropped a malformed reload request`)
      if (reloadHandler) return reloadHandler(parsed)
      early.push(parsed)
      return
    }
    const id = (message as { id?: unknown }).id
    const entry = typeof id === "number" ? pending.get(id) : undefined
    if (!entry) return log(`[@alpha-code/ext] hub bridge: ${type.slice(0, 80)} for no pending request ignored`)
    pending.delete(id as number)
    clearTimeout(entry.timer)
    entry.settle(message)
  })

  const ask = <T>(build: (id: number) => unknown, parse: (message: unknown) => T | undefined): Promise<T | BridgeFailure> => {
    if (!port) return Promise.resolve({ ok: false, reason: "unavailable", detail: "no parent port in this engine host" })
    const id = ++seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ ok: false, reason: "timeout", detail: "the app did not answer in time" })
      }, timeoutMs)
      pending.set(id, {
        timer,
        settle: (message) => {
          const parsed = parse(message)
          if (parsed === undefined) {
            log(`[@alpha-code/ext] hub bridge: dropped a malformed reply to request ${id}`)
            return resolve({ ok: false, reason: "error", detail: "the app sent a malformed answer" })
          }
          resolve(parsed)
        },
      })
      try {
        port.postMessage(build(id))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        log(`[@alpha-code/ext] hub bridge: request ${id} could not be posted: ${error instanceof Error ? error.message : String(error)}`)
        resolve({ ok: false, reason: "unavailable", detail: "the app could not be reached" })
      }
    })
  }

  return {
    available: !!port,
    view: (input) =>
      ask(
        (id) => buildHubViewRequest({ id, ...input }),
        (message) => {
          const reply = parseHubViewReply(message)
          if (!reply) return
          return "view" in reply
            ? { ok: true as const, view: reply.view }
            : { ok: false as const, reason: "error" as const, detail: "the app could not compute the view" }
        },
      ),
    request: (requestId) =>
      ask(
        (id) => buildHubRequestQuery(id, requestId),
        (message) => {
          const reply = parseHubRequestReply(message)
          if (!reply) return
          return "record" in reply
            ? { ok: true as const, record: reply.record }
            : { ok: false as const, reason: "error" as const, detail: "the app could not read the request" }
        },
      ),
    report(input) {
      if (!port) return
      try {
        port.postMessage(buildReloadReport(input))
      } catch (error) {
        log(`[@alpha-code/ext] hub bridge: reload report for generation ${input.generation} could not be posted: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    onReloadRequest(handler) {
      reloadHandler = handler
      for (const message of early.splice(0)) handler(message)
    },
  }
}

/** 本引擎进程的 parentPort(Electron utilityProcess);CLI / 测试宿主里没有。 */
export function processParentPort(): HubPort | undefined {
  const port = (process as unknown as { parentPort?: HubPort }).parentPort
  return port && typeof port.postMessage === "function" && typeof port.on === "function" ? port : undefined
}
