// REQ-237 `#1555` —— 远程目录刷新器的行为判据(AC2 触发点 / AC3 单飞与身份仲裁 / AC6 接口形状)。
//
// 子进程运行(catalog-refresher.test.ts spawn):刷新器经 alpha-auth / alpha-catalog-health / logging 拖入 electron,
// mock.module 在同一进程内会泄漏到别的测试文件。刷新器有模块级状态(在途轮次、身份基线、30 分钟定时器),
// 所以每条用例结束前都让在途那一轮落定,下一条从空闲开始。
//
// 被测入口只有生产导出 requestCatalogRefresh / onDownloadedCatalogChanged;网络层是本文件的 fetch 桩,
// 响应体取上游 producer fixture 的 `value`(不手写替身)。补试用的超时 = fetch 以 `TimeoutError` 拒绝 ——
// 与 AbortSignal.timeout 到期时 fetch 抛出的错误同名,生产代码按 `error.name` 分类(alpha-platform-models.ts)。

import { afterEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const userData = mkdtempSync(join(tmpdir(), "catalog-refresher-"))
let identity: string | undefined = "account-a"
let identityThrows = false

mock.module("electron", () => ({
  app: {
    getVersion: () => "9.9.9",
    getPath: () => userData,
    getName: () => "alpha-code",
    isPackaged: false,
    on: () => {},
    off: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    isDestroyed() {
      return false
    }
    static getAllWindows() {
      return []
    }
  },
  ipcMain: { handle: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: { openExternal: async () => {} },
  utilityProcess: { fork: () => { throw new Error("unexpected utilityProcess.fork") } },
}))
const logger = { log: () => {}, warn: () => {}, error: () => {} }
mock.module("./logging", () => ({
  getLogger: () => logger,
  initLogging: () => logger,
  initCrashReporter: () => {},
  startNetLog: async () => {},
  exportDebugLogs: async () => "",
  write: () => {},
  tail: () => "",
  serverLogRoots: () => [],
  rotateServerLogs: () => {},
}))
mock.module("./alpha-endpoints", () => ({ resolveEndpoints: () => ({ platform: "https://gateway.test" }) }))
mock.module("./alpha-auth", () => ({
  getAccessToken: () => (identity ? `token-${identity}` : undefined),
  getAuthIdentityTag: () => {
    if (identityThrows) throw new Error("identity read exploded")
    return identity
  },
}))

// 30 分钟触发点:记下刷新器装的定时器(照常装真的,只是多记一份),用例里直接触发它的回调。
const intervals: Array<{ callback: () => void; ms: number }> = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = ((callback: () => void, ms: number) => {
  intervals.push({ callback, ms })
  return realSetInterval(callback, ms)
}) as typeof setInterval

const { onDownloadedCatalogChanged, requestCatalogRefresh } = await import("./catalog-refresher")
const { liveAllowlistPath } = await import("./alpha-live-allowlist")
const { getCatalogFailure } = await import("./alpha-catalog-health")

const PRODUCER_FIXTURE = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v2/fixtures/producer/model-catalog.json",
)
const catalogV2 = (): any => structuredClone(JSON.parse(readFileSync(PRODUCER_FIXTURE, "utf8")).value)

/** 每次 GET 一条记录:带的 bearer + 一个由用例决定何时落定的应答。 */
type Pending = { bearer: string | null; settle: (response: Response | Error) => void }
const requests: Pending[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>
  const { promise, resolve } = Promise.withResolvers<Response | Error>()
  requests.push({ bearer: headers.authorization ?? null, settle: resolve })
  const outcome = await promise
  if (outcome instanceof Error) throw outcome
  return outcome
}) as unknown as typeof fetch
const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError")
const okCatalog = (mutate?: (catalog: any) => void) => {
  const catalog = catalogV2()
  mutate?.(catalog)
  return Response.json(catalog)
}

const waitFor = async (ready: () => boolean, timeoutMs = 5000) => {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started >= timeoutMs) throw new Error("observation timed out")
    await Bun.sleep(10)
  }
}
/** 让刷新器回到空闲:落定所有挂着的请求,并等收尾(补试窗口 1s + 身份补轮)走完。 */
const drain = async () => {
  for (let round = 0; round < 3; round++) {
    for (const request of requests) request.settle(new Response("{}", { status: 503 }))
    await Bun.sleep(1200)
  }
}
const lkgFetchedAt = () =>
  existsSync(liveAllowlistPath(userData)) ? JSON.parse(readFileSync(liveAllowlistPath(userData), "utf8")).fetchedAt : null

afterEach(async () => {
  await drain()
  requests.length = 0
  identity = "account-a"
  identityThrows = false
})

describe("`#1555` AC2:只在四个触发点发起", () => {
  test("boot 发起一次并装 30 分钟定时器;定时器到点发起;manual 发起", async () => {
    requestCatalogRefresh("boot")
    expect(requests).toHaveLength(1)
    expect(intervals).toEqual([{ callback: expect.any(Function), ms: 30 * 60_000 }])
    requests[0]!.settle(okCatalog())
    await waitFor(() => lkgFetchedAt() !== null)

    intervals[0]!.callback()
    expect(requests).toHaveLength(2)
    requests[1]!.settle(okCatalog())
    await Bun.sleep(50)

    requestCatalogRefresh("manual")
    expect(requests).toHaveLength(3)
    requests[2]!.settle(okCatalog())
    await Bun.sleep(50)

    // 再来一次 boot 不再多装定时器。
    requestCatalogRefresh("boot")
    expect(intervals).toHaveLength(1)
  })

  test("纯令牌续期(身份标签不变)不拉平台目录;身份真变化才拉,并带新身份的凭据", async () => {
    requestCatalogRefresh("identity-change")
    requestCatalogRefresh("identity-change")
    expect(requests).toHaveLength(0)

    identity = "account-b"
    requestCatalogRefresh("identity-change")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.bearer).toBe("Bearer token-account-b")
    requests[0]!.settle(okCatalog())
    await Bun.sleep(50)

    // 登出也是身份变化(标签 → undefined),按未登录拉。
    identity = undefined
    requestCatalogRefresh("identity-change")
    expect(requests).toHaveLength(2)
    expect(requests[1]!.bearer).toBeNull()
  })

  test("首试超时后约 1s 补试一次,补试再超时就停,等下一个触发点", async () => {
    requestCatalogRefresh("manual")
    expect(requests).toHaveLength(1)
    requests[0]!.settle(timeoutError())
    await Bun.sleep(300)
    expect(requests).toHaveLength(1) // 补试不是立刻发
    await waitFor(() => requests.length === 2, 2000)
    requests[1]!.settle(timeoutError())
    await Bun.sleep(2500)
    expect(requests).toHaveLength(2)
    expect(getCatalogFailure()?.code).toBe("timeout")
  })
})

describe("`#1555` AC3:单飞与身份仲裁", () => {
  test("在途时再来的 boot / manual / interval 都并入在途那一轮,同一时刻至多一个请求", async () => {
    requestCatalogRefresh("manual")
    requestCatalogRefresh("manual")
    requestCatalogRefresh("interval")
    requestCatalogRefresh("boot")
    intervals[0]!.callback()
    expect(requests).toHaveLength(1)

    // 补试窗口也属于这一轮:首试超时后、补试之前到来的触发同样不另起请求。
    requests[0]!.settle(timeoutError())
    await Bun.sleep(200)
    requestCatalogRefresh("manual")
    expect(requests).toHaveLength(1)
    await waitFor(() => requests.length === 2, 2000)
    requests[1]!.settle(okCatalog())
    await Bun.sleep(50)

    requestCatalogRefresh("manual")
    expect(requests).toHaveLength(3)
  })

  test("在途时身份变化:旧轮结果不写盘、不改刷新结局;旧轮落定后按新身份补一轮", async () => {
    requestCatalogRefresh("manual")
    requests[0]!.settle(okCatalog())
    await waitFor(() => getCatalogFailure() === null) // 上一条 drain 留下的失败被这一轮成功清掉 = 这一轮已落盘
    const seeded = readFileSync(liveAllowlistPath(userData))

    requestCatalogRefresh("manual")
    expect(requests[1]!.bearer).toBe("Bearer token-account-a")
    identity = "account-b"
    requestCatalogRefresh("identity-change")
    expect(requests).toHaveLength(2) // 不并发第二个请求

    // 旧身份那一轮带着「新」目录(改了一行倍数)回来:不得落盘;以 429 回来也不得改结局。
    requests[1]!.settle(okCatalog((catalog) => (catalog.data[0].pricing_multiplier = { input: 2, output: 3 })))
    await waitFor(() => requests.length === 3)
    expect(readFileSync(liveAllowlistPath(userData)).equals(seeded)).toBe(true)
    expect(getCatalogFailure()).toBeNull()
    expect(requests[2]!.bearer).toBe("Bearer token-account-b")

    requests[2]!.settle(okCatalog((catalog) => (catalog.data[0].pricing_multiplier = { input: 4, output: 5 })))
    await waitFor(() => !readFileSync(liveAllowlistPath(userData)).equals(seeded))
    expect(JSON.parse(readFileSync(liveAllowlistPath(userData), "utf8")).models[0].pricing).toEqual({ input: 4, output: 5 })
  })

  test("在途时身份变化,旧轮以失败回来:刷新结局不被旧轮改写", async () => {
    requestCatalogRefresh("manual")
    identity = "account-c"
    requestCatalogRefresh("identity-change")
    const before = getCatalogFailure()
    requests[0]!.settle(new Response('{"error":{"message":"rate limited","code":"rate_limited"}}', { status: 429 }))
    await waitFor(() => requests.length === 2)
    expect(getCatalogFailure()).toEqual(before)
  })
})

describe("`#1555` AC6:对外接口形状", () => {
  test("requestCatalogRefresh 同步返回 undefined,请求挂着也不等;内部抛错也不外抛", async () => {
    expect(requestCatalogRefresh("manual")).toBeUndefined()
    expect(requests).toHaveLength(1) // 已发出、仍未落定 —— 调用早已返回

    identityThrows = true
    expect(() => requestCatalogRefresh("identity-change")).not.toThrow()
    expect(() => requestCatalogRefresh("boot")).not.toThrow()
    expect(requestCatalogRefresh("identity-change")).toBeUndefined()
  })

  test("onDownloadedCatalogChanged:已下载目录真的变了才通知 { platformChanged, byokChanged },可退订", async () => {
    const seen: unknown[] = []
    const unsubscribe = onDownloadedCatalogChanged((change) => seen.push(change))

    requestCatalogRefresh("manual")
    requests[0]!.settle(new Response("upstream is down", { status: 503 }))
    await Bun.sleep(100)
    expect(seen).toEqual([]) // 失败 ⇒ LKG 没变 ⇒ 不通知

    requestCatalogRefresh("manual")
    requests[1]!.settle(okCatalog())
    await waitFor(() => seen.length === 1)
    expect(seen).toEqual([{ platformChanged: true, byokChanged: false }])

    unsubscribe()
    await Bun.sleep(5) // 让 fetchedAt 的 ISO 时间戳一定前进
    requestCatalogRefresh("manual")
    requests[2]!.settle(okCatalog())
    await Bun.sleep(100)
    expect(seen).toHaveLength(1)
  })
})

process.on("exit", () => {
  globalThis.fetch = realFetch
})
