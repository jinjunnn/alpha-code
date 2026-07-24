import { expect, test } from "bun:test"
import { createAuthedGet } from "./alpha-account-request"
import { createTokenRotationLatch } from "./auth-renewal"
import type { RenewalResult } from "./alpha-auth"

test("account 401 refreshes once and the successful renewal reaches token rotation", async () => {
  let forkedGeneration = 1
  let requests = 0
  let refreshes = 0
  const rotations: string[] = []
  const rotation = createTokenRotationLatch({
    forkedGeneration: () => forkedGeneration,
    canRespawn: () => true,
    respawn: async (reason) => {
      rotations.push(reason)
      forkedGeneration = 2
      return true
    },
  })
  const renewed: RenewalResult = { outcome: "refreshed", generation: 2, expiresAt: 10_000 }
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => {
      refreshes++
      await rotation.accept(renewed, "account-401")
      return renewed
    },
    fetch: async () => {
      requests++
      if (requests === 1) return new Response("", { status: 401 })
      return new Response('{"ok":true}', { status: 200 })
    },
    now: () => 1_000,
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })

  expect(await authedGet("/v1/account/summary", "account.read", (text) => JSON.parse(text))).toEqual({ ok: true })
  expect(refreshes).toBe(1)
  expect(requests).toBe(2)
  expect(rotations).toEqual(["token-only"])
})

test("account 401 does not retry or rotate after a transient renewal failure", async () => {
  let requests = 0
  const authedGet = createAuthedGet({
    accountBase: () => "https://account.invalid",
    getAccessToken: () => "test-only",
    refreshTokens: async () => ({ outcome: "transient-failure", generation: 1 }),
    fetch: async () => {
      requests++
      return new Response("", { status: 401 })
    },
    now: () => 1_000,
    warn: () => {},
    isContractIncompatibleError: () => false,
    reportContractFailure: () => {},
  })

  expect(await authedGet("/v1/account/summary", "account.read", (text) => text)).toEqual({
    error: "unauthorized",
  })
  expect(requests).toBe(1)
})
