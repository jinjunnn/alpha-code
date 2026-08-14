import { expect, test } from "bun:test"
import { createAuthedGet } from "./alpha-account-request"
import type { RenewalResult } from "./alpha-auth"
// [#965] 判据必须跨层跑到真正的消费者。model-recovery.ts 只 import 一个 type-only 的 preload
// 类型与零 import 的 model-picker-logic.ts,牵不出 solid-js(否则整文件会挂在
// getNextContextId cannot be used under non-hydrating context)。
import { accountResultState } from "../renderer/alpha-ui/model-recovery"

// createAuthedGet 只拿 refreshTokens 当依赖:续期与换血的真实接线(refreshTokens 必须等
// latch 应用完该 generation 才返回)属于 alpha-auth 的 composition,断言在 alpha-auth.cases.ts。
// 本文件此前在 mock 的 refreshTokens 内手工 `await rotation.accept()`,而生产代码把该 Promise
// `void` 掉了 —— 测试自己重写了理想接线,生产删掉照样绿(#600 M1 假闸门)。
const renewed = (outcome: RenewalResult["outcome"], generation = 2): RenewalResult => ({
  outcome,
  generation,
})

test("account 401 refreshes once and retries the read with the renewed token", async () => {
  let requests = 0
  let refreshes = 0
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => {
      refreshes++
      return renewed("refreshed")
    },
    authIdentityEpoch: () => 1,
    fetch: async () => {
      requests++
      if (requests === 1) return new Response("", { status: 401 })
      return new Response('{"ok":true}', { status: 200 })
    },
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })

  expect(await authedGet("/v1/account/summary", "account.read", (text) => JSON.parse(text))).toEqual({ ok: true })
  expect(refreshes).toBe(1)
  expect(requests).toBe(2)
})

test("account 401 does not retry or rotate after a transient renewal failure", async () => {
  let requests = 0
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => renewed("transient-failure", 1),
    authIdentityEpoch: () => 1,
    fetch: async () => {
      requests++
      return new Response("", { status: 401 })
    },
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })

  expect(await authedGet("/v1/account/summary", "account.read", (text) => text)).toEqual({
    error: "unauthorized",
  })
  expect(requests).toBe(1)
})

// #601:持续 401 曾形成每 30 秒一次的 respawn 自激循环 —— 续期后仍 401 只设有限 cooldown,
// 窗口一过又允许 account 驱动刷新,refresh 成功又换血,永久重复中断 sidecar/会话。
// 正确行为:续期后的第二个 401 锁住该 purpose 的 account 驱动刷新,直到该 endpoint
// 出现非 401 成功,或外部 auth 身份变化(登入/登出)。有限 cooldown 不是终局。
function lockingHarness(options: { status: () => number; epoch: () => number }) {
  let requests = 0
  let refreshes = 0
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => {
      refreshes++
      return renewed("refreshed", refreshes + 1)
    },
    authIdentityEpoch: options.epoch,
    fetch: async () => {
      requests++
      const status = options.status()
      return new Response(status === 200 ? '{"ok":true}' : "", { status })
    },
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })
  return {
    read: () => authedGet("/v1/account/summary", "account.read", (text) => (text ? JSON.parse(text) : {})),
    counts: () => ({ requests, refreshes }),
  }
}

test("the second 401 after a renewal locks account-driven refresh for that purpose", async () => {
  const harness = lockingHarness({ status: () => 401, epoch: () => 1 })

  expect(await harness.read()).toEqual({ error: "unauthorized" })
  // 一次 401 → 一次续期 → 带新 token 重试 → 仍 401 ⇒ 锁住。
  expect(harness.counts()).toEqual({ requests: 2, refreshes: 1 })

  expect(await harness.read()).toEqual({ error: "unauthorized" })
  expect(harness.counts()).toEqual({ requests: 3, refreshes: 1 })
})

test("a persistently 401 endpoint drives exactly one refresh no matter how long it keeps failing", async () => {
  const harness = lockingHarness({ status: () => 401, epoch: () => 1 })

  // 消费方(#594)对 unauthorized 用无上限封顶退避持续重读 —— 过去多久都不得解锁。
  for (let attempt = 0; attempt < 20; attempt++) expect(await harness.read()).toEqual({ error: "unauthorized" })

  expect(harness.counts().refreshes).toBe(1)
})

test("a non-401 success on that endpoint releases the lock", async () => {
  let status = 401
  const harness = lockingHarness({ status: () => status, epoch: () => 1 })

  await harness.read()
  expect(harness.counts().refreshes).toBe(1)

  status = 200
  expect(await harness.read()).toEqual({ ok: true })

  status = 401
  await harness.read()
  expect(harness.counts().refreshes).toBe(2)
})

test("an explicit auth identity change (login/logout) releases the lock", async () => {
  let epoch = 1
  const harness = lockingHarness({ status: () => 401, epoch: () => epoch })

  await harness.read()
  await harness.read()
  expect(harness.counts().refreshes).toBe(1)

  epoch = 2
  await harness.read()
  expect(harness.counts().refreshes).toBe(2)
})

// R1 Major1:锁必须绑定「请求发出时」的身份代。读落地时的当前代,会让账号 A 的迟到 401
// 把刚登录的账号 B 锁住 —— #601 的「auth 变化解锁」被迟到响应反向抵消。
test("a 401 that lands after a new login locks the old identity, never the new one", async () => {
  let epoch = 1
  let refreshes = 0
  let releaseFirst!: () => void
  const firstInFlight = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let requests = 0
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => {
      refreshes++
      return renewed("refreshed", refreshes + 1)
    },
    authIdentityEpoch: () => epoch,
    fetch: async () => {
      requests++
      if (requests <= 2) await firstInFlight // 账号 A 的首轮与重试都迟到
      return new Response("", { status: 401 })
    },
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })

  const stale = authedGet("/v1/account/summary", "account.read", (text) => text)
  epoch = 2 // 账号 B 登录
  releaseFirst()
  expect(await stale).toEqual({ error: "unauthorized" })
  expect(refreshes).toBe(1)

  // 新身份必须仍能驱动一次续期(锁记在旧身份代上)。
  expect(await authedGet("/v1/account/summary", "account.read", (text) => text)).toEqual({
    error: "unauthorized",
  })
  expect(refreshes).toBe(2)
})

// R1 Major2:「非 401 成功」必须包含 decode 成功。否则服务在 malformed 200 与 401 之间抖动时,
// 每个 malformed 200 都解一次锁,下一个 401 又能驱动 refresh + 换血 —— 周期性中断回来了。
test("a malformed 200 does not count as recovery and keeps the lock", async () => {
  let status = 401
  let refreshes = 0
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => {
      refreshes++
      return renewed("refreshed", refreshes + 1)
    },
    authIdentityEpoch: () => 1,
    fetch: async () => new Response(status === 200 ? "not-json" : "", { status }),
    warn: () => {},
    isContractIncompatibleError: (error) => error instanceof SyntaxError,
    reportContractFailure: () => {},
  })
  const read = () =>
    authedGet("/v1/account/summary", "account.read", (text): unknown => JSON.parse(text))

  await read()
  expect(refreshes).toBe(1)

  status = 200
  expect(await read()).toEqual({ error: "contract-incompatible" })

  status = 401
  await read()
  expect(refreshes).toBe(1)
})

// #600 B3 的账户侧收口:续期本身「成功但结果不可用」时,消费方的封顶退避会把它变成高频重刷。
test("an unusable renewal locks account-driven refresh just like a post-renewal 401", async () => {
  let refreshes = 0
  let requests = 0
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => {
      refreshes++
      return renewed("unusable-response", 1)
    },
    authIdentityEpoch: () => 1,
    fetch: async () => {
      requests++
      return new Response("", { status: 401 })
    },
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })

  for (let attempt = 0; attempt < 10; attempt++)
    expect(await authedGet("/v1/account/summary", "account.read", (text) => text)).toEqual({
      error: "unauthorized",
    })

  expect(refreshes).toBe(1)
  expect(requests).toBe(10)
})

test("a non-401 failure keeps the lock (only a real success proves the endpoint recovered)", async () => {
  let status = 401
  const harness = lockingHarness({ status: () => status, epoch: () => 1 })

  await harness.read()
  expect(harness.counts().refreshes).toBe(1)

  status = 503
  expect(await harness.read()).toEqual({ error: "http-503", status: 503 })

  status = 401
  await harness.read()
  expect(harness.counts().refreshes).toBe(1)
})

// [#940] 非 401 拒绝经 platform-error-code 咽喉:服务给稳定分类码就呈现 code;
// account 今天的错误体只有 `{error: 散文}` 无 code ⇒ 上面那条 http-503 即对照臂(行为零变化)。
test("a non-401 rejection carrying a stable classification code surfaces the code, not http-503", async () => {
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => renewed("refreshed"),
    authIdentityEpoch: () => 1,
    fetch: async () => new Response(JSON.stringify({ error: "billing not ready", code: "billing_unready" }), { status: 503 }),
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })

  expect(await authedGet("/v1/account/summary", "account.read", (text) => JSON.parse(text))).toEqual({
    error: "billing_unready",
    status: 503,
  })
})

// [#965] transient 判定的**生产接线**判据:从假 fetch 驱动真 createAuthedGet,一路跑到 renderer
// 的 accountResultState。为什么必须跨层跑,而不是只喂 accountResultState 字面量:它收 `unknown`,
// 而 packages/ui-mac/tsconfig.json 把 *.test.ts 排除在 typecheck 外 ⇒ 产出点漏写 `status:` 时,
// 编译器与纯函数单测**都不会红**。只断纯函数 = 落在分流层的绕过照样绿。
const accountRead = (over: Partial<Parameters<typeof createAuthedGet>[0]> = {}) =>
  createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => renewed("refreshed"),
    authIdentityEpoch: () => 1,
    fetch: async () => new Response("{}", { status: 200 }),
    warn: () => {},
    isContractIncompatibleError: (e) => e instanceof SyntaxError,
    reportContractFailure: () => {},
    ...over,
  })("/v1/account/summary", "account.read", (text): unknown => JSON.parse(text))
const rejectWith = (status: number, body: unknown) =>
  accountRead({ fetch: async () => new Response(JSON.stringify(body), { status }) })

test("[#965] 平台给 5xx 补分类码,UI 仍显示「正在恢复」(本票存在的理由)", async () => {
  const r = await rejectWith(503, { error: "billing not ready", code: "billing_unready" })
  expect(r).toEqual({ error: "billing_unready", status: 503 }) // 呈现槽仍是咽喉给的码(#940 不变)
  expect(accountResultState(r)).toBe("recovering")
})

test("[#965] 4xx 带分类码仍是「失败」(反向夹具也带码,不用 403 无码这种退化形状)", async () => {
  const r = await rejectWith(403, { error: "forbidden", code: "plan_forbidden" })
  expect(r).toEqual({ error: "plan_forbidden", status: 403 })
  expect(accountResultState(r)).toBe("failed")
})

test("[#965] 状态类两侧的边界(独立字面量,不 import 生产常量)", async () => {
  // 只测 503 会让 `status === 503` 这个错误实现全绿;两侧各多枚举一档。
  // **先收表、再一次断整表**:循环内逐条 expect 会在首个失败处抛出中止,后面的档位根本不被
  // 求值 ⇒「N 档同时变红」结构上观测不到(实测形态:5 档全错也只报 1 fail / 1 expect() call)。
  // 整表 diff 一次给出全部错行,「12 行都被求值」才是结构性事实而不是一句期望。
  const classify = async (statuses: number[]) => {
    const rows: [number, string][] = []
    for (const status of statuses) rows.push([status, accountResultState(await rejectWith(status, { code: "some_platform_code" }))])
    return rows
  }
  expect(await classify([408, 425, 429, 500, 599])).toEqual([
    [408, "recovering"],
    [425, "recovering"],
    [429, "recovering"],
    [500, "recovering"],
    [599, "recovering"],
  ])
  expect(await classify([400, 403, 404, 407, 426, 430, 499])).toEqual([
    [400, "failed"],
    [403, "failed"],
    [404, "failed"],
    [407, "failed"],
    [426, "failed"],
    [430, "failed"],
    [499, "failed"],
  ])
})

test("[#965] 结构槽优先于具名白名单:403 而分类码恰好叫 network ⇒ 仍是「失败」", async () => {
  // 钉的是**判定顺序**(平台真发这个码未必可达)。`network` 命中 CLASSIFICATION_CODE
  // (/^[a-z][a-z0-9_]{2,63}$/),顺序反了、或正则实现留着,这条当场红。
  const r = await rejectWith(403, { code: "network" })
  expect(r).toEqual({ error: "network", status: 403 })
  expect(accountResultState(r)).toBe("failed")
})

test("[#965] 四条非 HTTP 结局不带 status,分类不变", async () => {
  const notAuthed = await accountRead({ getAccessToken: () => undefined })
  const network = await accountRead({
    fetch: async () => {
      throw new Error("offline")
    },
  })
  const unauthorized = await accountRead({ fetch: async () => new Response("", { status: 401 }) })
  const incompatible = await accountRead({ fetch: async () => new Response("not-json", { status: 200 }) })

  // 给「顺手给所有分支都加 status」的实现留的绊线:401 一带 status,产物形状、hasOwn、
  // 分类三样一起错 —— 分类会从 recovering 翻成 failed(401 不在状态类白名单里),那是
  // **用户可观察的**那一格。用 Object.hasOwn 而不是 not.toHaveProperty:后者对「键存在但
  // 值为 undefined」跨 runner 语义不一。
  // **先收表、再一次断整表**(同 C3):逐条 expect 会在首个失败处抛出中止,后面的断言根本
  // 不被求值 —— 那样「分类翻了没有」这条最重要的判据在演练里观测不到(实测:M3 下先炸在
  // 第三条 toEqual,分类断言一次都没跑)。整表 diff 才能同时给出形状与分类两侧的错行。
  const outcomes = [notAuthed, network, unauthorized, incompatible].map((r) => ({
    result: r,
    carriesStatus: Object.hasOwn(r as object, "status"),
    state: accountResultState(r),
  }))
  expect(outcomes).toEqual([
    { result: { error: "not-authenticated" }, carriesStatus: false, state: "recovering" },
    { result: { error: "network" }, carriesStatus: false, state: "recovering" },
    { result: { error: "unauthorized" }, carriesStatus: false, state: "recovering" },
    { result: { error: "contract-incompatible" }, carriesStatus: false, state: "failed" },
  ])
})
