// REQ-237 `#1555` —— 远程目录刷新器的行为判据(AC2 触发点 / AC3 单飞与身份仲裁 / AC6 接口形状)。
// `#1556` 起刷新器管两份文档:平台目录 V3(下文 `requests`)与 BYOK 预置目录 v1(下文 `byokRequests`);
// 文末两组是 `#1556` AC4(BYOK 拉取不带凭据、失败不减条目)与 AC6(alpha-catalog-health 按文档分别保存)。
//
// 子进程运行(catalog-refresher.test.ts spawn):刷新器经 alpha-auth / alpha-catalog-health / logging 拖入 electron,
// mock.module 在同一进程内会泄漏到别的测试文件。刷新器有模块级状态(在途轮次、身份基线、30 分钟定时器),
// 所以每条用例结束前都让在途那一轮落定,下一条从空闲开始。
//
// 被测入口只有生产导出 requestCatalogRefresh / onDownloadedCatalogChanged;网络层是本文件的 fetch 桩,
// 按 URL 路径分到两个数组,响应体取上游 producer fixture 的 `value`(不手写替身)。补试用的超时 = fetch 以 `TimeoutError` 拒绝 ——
// 与 AbortSignal.timeout 到期时 fetch 抛出的错误同名,生产代码按 `error.name` 分类(alpha-platform-models.ts)。

import { afterEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const userData = mkdtempSync(join(tmpdir(), "catalog-refresher-"))
let identity: string | undefined = "account-a"
let identityThrows = false
/** 存着的令牌是否已过期(冷启动 App 关了超过一个续期周期时为真);`tokenSuffix` 区分续期前后的令牌。 */
let tokenExpired = false
let tokenSuffix = ""

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
  getAccessToken: () => (identity ? `token-${identity}${tokenSuffix}` : undefined),
  isStoredTokenExpired: () => tokenExpired,
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
const { appliedCatalogPath, byokCatalogPath, liveAllowlistPath, pinAppliedCatalog, readAppliedByokCatalog } = await import(
  "./alpha-live-allowlist"
)
const { getCatalogFailure } = await import("./alpha-catalog-health")

const VENDOR = join(import.meta.dir, "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts")
const catalogV3 = (): any => structuredClone(JSON.parse(readFileSync(join(VENDOR, "v3/fixtures/producer/model-catalog.json"), "utf8")).value)
const byokV1 = (): any => structuredClone(JSON.parse(readFileSync(join(VENDOR, "v1/fixtures/producer/byok-catalog.json"), "utf8")).value)

/** 每次 GET 一条记录:带的 bearer(以及全部请求头)+ 一个由用例决定何时落定的应答。 */
type Pending = { bearer: string | null; headers: Record<string, string>; settle: (response: Response | Error) => void }
const requests: Pending[] = []
const byokRequests: Pending[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>
  const { promise, resolve } = Promise.withResolvers<Response | Error>()
  const bucket = new URL(String(url)).pathname === "/v1/byok-catalog" ? byokRequests : requests
  bucket.push({ bearer: headers.authorization ?? null, headers, settle: resolve })
  const outcome = await promise
  if (outcome instanceof Error) throw outcome
  return outcome
}) as unknown as typeof fetch
const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError")
const okCatalog = (mutate?: (catalog: any) => void) => {
  const catalog = catalogV3()
  mutate?.(catalog)
  return Response.json(catalog)
}
/** BYOK 文档应答;默认把版本抬到随包首启引导之上,让它真的被采纳。 */
const okByok = (mutate?: (doc: any) => void) => {
  const doc = byokV1()
  doc.catalog_version = 2
  mutate?.(doc)
  return Response.json(doc)
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
    for (const request of [...requests, ...byokRequests]) request.settle(new Response("{}", { status: 503 }))
    await Bun.sleep(1200)
  }
}
const lkgFetchedAt = () =>
  existsSync(liveAllowlistPath(userData)) ? JSON.parse(readFileSync(liveAllowlistPath(userData), "utf8")).fetchedAt : null

afterEach(async () => {
  await drain()
  requests.length = 0
  byokRequests.length = 0
  identity = "account-a"
  identityThrows = false
  tokenExpired = false
  tokenSuffix = ""
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
    expect(getCatalogFailure().platform?.code).toBe("timeout")
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
    await waitFor(() => getCatalogFailure().platform === null) // 上一条 drain 留下的失败被这一轮成功清掉 = 这一轮已落盘
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
    expect(getCatalogFailure().platform).toBeNull()
    expect(requests[2]!.bearer).toBe("Bearer token-account-b")

    requests[2]!.settle(okCatalog((catalog) => (catalog.data[0].pricing_multiplier = { input: 4, output: 5 })))
    await waitFor(() => !readFileSync(liveAllowlistPath(userData)).equals(seeded))
    expect(JSON.parse(readFileSync(liveAllowlistPath(userData), "utf8")).models[0].pricing).toEqual({ input: 4, output: 5 })
  })

  test("在途时身份变化,旧轮以失败回来:刷新结局不被旧轮改写", async () => {
    requestCatalogRefresh("manual")
    identity = "account-c"
    requestCatalogRefresh("identity-change")
    const before = getCatalogFailure().platform
    requests[0]!.settle(new Response('{"error":{"message":"rate limited","code":"rate_limited"}}', { status: 429 }))
    await waitFor(() => requests.length === 2)
    expect(getCatalogFailure().platform).toEqual(before)
  })
})

// 编排器裁决(#1555 续派):冷启动时令牌已过期,boot 那一轮若照发,网关对坏 bearer 回退默认 edition,
// 而纯续期不再重拉 ⇒ 错的清单钉到下一个触发点。boot 改为等开机续期落定后按新令牌发。
// 删掉修法(boot 照发),第一条转红:boot 当场发出一条带过期令牌的请求,续期之后也不再重拉。
describe("`#1555` 冷启动过期令牌:boot 那一轮等开机续期落定", () => {
  test("开机时令牌过期 → 续期成功 → 平台清单按新令牌重拉一次,下一次 fork 钉住的是新结果", async () => {
    tokenExpired = true
    requestCatalogRefresh("boot")
    expect(requests).toHaveLength(0) // 过期令牌拉回来的是默认 edition 的清单,不发

    // 开机续期成功:令牌换新、身份不变,续期链末尾照常走 onChanged。
    tokenExpired = false
    tokenSuffix = "-renewed"
    requestCatalogRefresh("identity-change")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.bearer).toBe("Bearer token-account-a-renewed")
    requests[0]!.settle(okCatalog((catalog) => (catalog.data[0].pricing_multiplier = { input: 6, output: 7 })))
    await waitFor(() => existsSync(liveAllowlistPath(userData)) && JSON.parse(readFileSync(liveAllowlistPath(userData), "utf8")).models[0].pricing.input === 6)

    pinAppliedCatalog(userData, 42) // 下一次 fork
    expect(JSON.parse(readFileSync(appliedCatalogPath(userData), "utf8")).platform.models[0].pricing).toEqual({ input: 6, output: 7 })

    // 只补这一轮:之后的纯续期照旧不拉。
    requestCatalogRefresh("identity-change")
    await Bun.sleep(50)
    expect(requests).toHaveLength(1)
  })

  test("开机续期失败(令牌仍过期)也照常补发这一轮,不让目录饿死", async () => {
    tokenExpired = true
    requestCatalogRefresh("boot")
    expect(requests).toHaveLength(0)
    requestCatalogRefresh("identity-change") // 续期以失败结束,同样走 onChanged
    expect(requests).toHaveLength(1)
    expect(requests[0]!.bearer).toBe("Bearer token-account-a")
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

// ── `#1556` AC4:BYOK 拉取不带任何凭据;拉取失败 / 校验失败 / 未登录都不减少已应用 BYOK 目录的条目 ──────────
// 每个触发点(纯身份变化除外)都拉 BYOK 文档,冷启动令牌过期也不等续期。判据看的是生产落盘的 LKG 与下一次 fork
// 钉住的已应用目录:失败的轮次之后再钉一次,条目一条都不能少。把 fetchByokCatalog 改成带 bearer,第一条转红;
// 把「失败也写 LKG」或「失败清掉 LKG」加回来,第二条转红。
describe("`#1556` AC4:BYOK 目录拉取不带凭据,失败不减条目", () => {
  const appliedModels = () =>
    readAppliedByokCatalog(userData).byok.providers.flatMap((provider: any) => provider.models.map((model: any) => `${provider.id}/${model.id}`))

  test("请求无 authorization 头(登录态与未登录都一样);冷启动令牌过期也照拉;纯身份变化不拉", async () => {
    tokenExpired = true
    requestCatalogRefresh("boot")
    expect(requests).toHaveLength(0) // 平台那份等续期
    expect(byokRequests).toHaveLength(1) // BYOK 那份不等
    tokenExpired = false
    identity = "account-b"
    requestCatalogRefresh("identity-change")
    expect(byokRequests).toHaveLength(1) // 身份变化只关平台那份
    identity = undefined
    requestCatalogRefresh("manual")
    for (const request of byokRequests) {
      expect(request.bearer).toBeNull()
      expect(Object.keys(request.headers).map((key) => key.toLowerCase())).not.toContain("authorization")
    }
    expect(requests.every((request) => request.bearer !== null || identity === undefined)).toBe(true)
  })

  test("采纳一次之后:网络失败 / 5xx / schema 不合 / 带 baseURL / 版本回退 / 未登录 —— 已应用条目一条不少", async () => {
    requestCatalogRefresh("manual")
    byokRequests[0]!.settle(okByok((doc) => doc.providers[4].models.push({ id: "kimi-k9", name: "Kimi K9", image_input: true })))
    await waitFor(() => existsSync(byokCatalogPath(userData)))
    pinAppliedCatalog(userData, 1)
    const adopted = appliedModels()
    expect(adopted).toContain("moonshot/kimi-k9")
    const lkg = readFileSync(byokCatalogPath(userData))

    const failures: Array<() => Response | Error> = [
      () => new TypeError("fetch failed"),
      () => new Response("upstream is down", { status: 503 }),
      () => Response.json({ schema_version: 1 }),
      () => okByok((doc) => (doc.providers[0].baseURL = "https://evil.example/v1")),
      () => okByok((doc) => (doc.catalog_version = 1)),
    ]
    identity = undefined // 未登录:BYOK 那份照拉,结果照样只看文档本身
    for (const failure of failures) {
      const before = byokRequests.length
      requestCatalogRefresh("manual")
      await waitFor(() => byokRequests.length === before + 1)
      byokRequests[before]!.settle(failure())
      await Bun.sleep(50)
      expect(readFileSync(byokCatalogPath(userData)).equals(lkg)).toBe(true)
      pinAppliedCatalog(userData, 2)
      expect(appliedModels()).toEqual(adopted)
    }
    expect(getCatalogFailure().byok?.code).toBeUndefined() // 最后那份是「版本不升」:成功拿到、只是没有新东西
  })
})

// ── `#1556` AC6:alpha-catalog-health 按文档分别保存 —— 一份成功只清它自己那一格 ──────────────────────
// 此前 health 只有一个 failure,`reportCatalogRefresh(null)` 整个清空:前两种顺序在旧码上红(另一份的失败被抹掉)。
describe("`#1556` AC6:alpha-catalog-health 两份目录各一格", () => {
  const settleBoth = async (platform: Response, byok: Response) => {
    const p = requests.length
    const b = byokRequests.length
    requestCatalogRefresh("manual")
    await waitFor(() => requests.length === p + 1 && byokRequests.length === b + 1)
    requests[p]!.settle(platform)
    byokRequests[b]!.settle(byok)
    await Bun.sleep(80)
  }
  const down = () => new Response("down", { status: 503 })

  test("平台先败、后 BYOK 成功:平台的失败仍在", async () => {
    await settleBoth(down(), down())
    expect(getCatalogFailure()).toEqual({ platform: expect.objectContaining({ code: "http-503" }), byok: expect.objectContaining({ code: "http-503" }) })
    const b = byokRequests.length
    requestCatalogRefresh("manual") // 平台那份还在途 ⇒ 只有 BYOK 这一份落定
    await waitFor(() => byokRequests.length === b + 1)
    byokRequests[b]!.settle(okByok())
    await waitFor(() => getCatalogFailure().byok === null)
    expect(getCatalogFailure().platform?.code).toBe("http-503")
  })

  test("BYOK 先败、后平台成功:BYOK 的失败仍在", async () => {
    await settleBoth(down(), down())
    const p = requests.length
    const b = byokRequests.length
    identity = "account-z" // 身份真变化 ⇒ 只拉平台那份
    requestCatalogRefresh("identity-change")
    await waitFor(() => requests.length === p + 1)
    requests[p]!.settle(okCatalog())
    await waitFor(() => getCatalogFailure().platform === null)
    expect(byokRequests).toHaveLength(b)
    expect(getCatalogFailure().byok?.code).toBe("http-503")
  })

  test("单边恢复:两份都败 → 各自成功各清各的,两份都成功后整体为空", async () => {
    await settleBoth(down(), down())
    await settleBoth(down(), okByok())
    expect(getCatalogFailure().platform?.code).toBe("http-503")
    expect(getCatalogFailure().byok).toBeNull()
    await settleBoth(okCatalog(), down())
    expect(getCatalogFailure().platform).toBeNull()
    expect(getCatalogFailure().byok?.code).toBe("http-503")
    await settleBoth(okCatalog(), okByok())
    expect(getCatalogFailure()).toEqual({ platform: null, byok: null })
  })
})

process.on("exit", () => {
  globalThis.fetch = realFetch
})
