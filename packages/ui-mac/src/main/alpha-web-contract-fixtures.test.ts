import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { isContractIncompatibleError } from "@alpha-code/contracts-consumer"
import { decodeAccountSummary } from "./alpha-account-contract"
import { decodeEndpointDiscovery } from "./alpha-endpoints"

// alpha-work#9 AC3, alpha-code half (#631). alpha-web publishes a consumer fixture per web-owned
// surface this desktop reads; both are vendored byte-identically and pinned in
// packages/alpha-contracts-consumer/alpha-web-contract.lock.json (`check:vendor` re-hashes them).
//
// This file is deliberately NOT a second copy of the shape. It feeds the fixture `value` into the
// SHIPPED decoders — decodeEndpointDiscovery(), and the decode function fetchAccountSummary()
// hands to createAuthedGet — so the only way an upstream change turns this red is the real
// consumer path rejecting it. Bumping the pin to a release with an incompatible shape fails here.

const vendorRoot = resolve(import.meta.dir, "../../../alpha-contracts-consumer/vendor/alpha-web")

type ConsumerFixture = { kind: string; contract: string; expect: string; value: unknown }
const fixture = async (path: string) => (await Bun.file(resolve(vendorRoot, path)).json()) as ConsumerFixture

const endpointDiscoveryFixture = () =>
  fixture("contracts/web-identity/fixtures/consumers/alpha-code/endpoint-discovery.json")
const accountSummaryFixture = () => fixture("contracts/web-account/fixtures/consumers/alpha-code/account-summary.json")

describe("alpha-web endpoint-discovery consumer fixture", () => {
  test("the pinned fixture decodes through the shipped decodeEndpointDiscovery", async () => {
    const published = await endpointDiscoveryFixture()
    expect(published.contract).toBe("alpha.web-identity.endpoint-discovery.v1")
    expect(published.expect).toBe("valid")

    expect(decodeEndpointDiscovery(published.value)).toEqual({
      web: "https://alphacodeone.com",
      platform: "https://alpha-gateway.tidelabs.click",
      account: "https://account.alphacodeone.com",
      cloud: "https://alpha-cloud.tidelabs.click",
      mcp: "https://alpha-cloud.tidelabs.click/mcp",
    })
  })

  test("a breaking upstream rename of a published base is rejected by the same decoder", async () => {
    const { value } = await endpointDiscoveryFixture()
    const { platform, ...rest } = value as Record<string, unknown>
    expect(() => decodeEndpointDiscovery({ ...rest, gateway: platform })).toThrow()
    try {
      decodeEndpointDiscovery({ ...rest, gateway: platform })
    } catch (error) {
      expect(isContractIncompatibleError(error)).toBe(true)
    }
  })
})

describe("alpha-web account-summary consumer fixture", () => {
  test("the pinned fixture decodes through the shipped account-summary decoder", async () => {
    const published = await accountSummaryFixture()
    expect(published.contract).toBe("alpha.web-account.summary.v1")
    expect(published.expect).toBe("valid")

    // The production path receives a response body, so drive the decoder the way authedGet does.
    const summary = decodeAccountSummary(JSON.stringify(published.value))
    expect(summary).toEqual({
      balanceFen: 18650,
      walletUsedFen: 4200,
      plan: {
        id: "pro",
        name: "Pro",
        status: "active",
        window5h: { usedCredits: 1300, limitCredits: 2000, resetsInMin: 92 },
        window7d: { usedCredits: 10400, limitCredits: 16000, resetsInMin: 5520 },
        renewsAt: "2026-08-22",
        daysLeft: 31,
      },
      usage: { todayTokens: 1900000, weekTokens: 25400000, tasksThisMonth: 47 },
      usageSeries: [
        { date: "2026-07-21", tokens: 5300000 },
        { date: "2026-07-22", tokens: 1900000 },
      ],
    })
  })

  // The consumer fixture alpha-web publishes only covers an ACTIVE plan, so the inactive branch of
  // the decoder is not pinned by a vendored byte. alpha-platform#106 (emptyPlan(),
  // packages/gateway/src/account.ts) emits the wire below for every user without a plan, and the
  // published contract requires only { id, status } on a plan with `name` optional. Refusing it
  // would turn every plan-less account's summary into contract-incompatible.
  test("the inactive-plan wire alpha-platform#106 emits decodes", () => {
    const wire = {
      schema_version: 1,
      schema: "alpha.web-account.summary.v1",
      balanceFen: 0,
      walletUsedFen: 0,
      plan: { id: "none", name: "None", status: "none" },
      usage: { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 },
      usageSeries: [],
    }
    expect(decodeAccountSummary(JSON.stringify(wire))).toEqual({
      balanceFen: 0,
      walletUsedFen: 0,
      plan: { id: "none", name: "None", status: "none" },
      usage: { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 },
      usageSeries: [],
    })
  })

  test("a breaking upstream rename of a published field is rejected by the same decoder", async () => {
    const { value } = await accountSummaryFixture()
    const { balanceFen, ...rest } = value as Record<string, unknown>
    expect(() => decodeAccountSummary(JSON.stringify({ ...rest, balance_fen: balanceFen }))).toThrow()
    try {
      decodeAccountSummary(JSON.stringify({ ...rest, balance_fen: balanceFen }))
    } catch (error) {
      expect(isContractIncompatibleError(error)).toBe(true)
    }
  })
})
