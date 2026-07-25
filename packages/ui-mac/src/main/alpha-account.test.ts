import { expect, test } from "bun:test"
import { createAuthedGet } from "./alpha-account-request"
import type { RenewalResult } from "./alpha-auth"

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

test("a non-401 failure keeps the lock (only a real success proves the endpoint recovered)", async () => {
  let status = 401
  const harness = lockingHarness({ status: () => status, epoch: () => 1 })

  await harness.read()
  expect(harness.counts().refreshes).toBe(1)

  status = 503
  expect(await harness.read()).toEqual({ error: "http-503" })

  status = 401
  await harness.read()
  expect(harness.counts().refreshes).toBe(1)
})
