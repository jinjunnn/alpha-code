import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { isContractIncompatibleError } from "@alpha-code/contracts-consumer"
import {
  PLAN_KEYS,
  SERIES_KEYS,
  SUMMARY_KEYS,
  USAGE_KEYS,
  WINDOW_KEYS,
  decodeAccountSummary,
} from "./alpha-account-contract"
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

type JsonSchema = { properties?: Record<string, unknown>; items?: JsonSchema }
const accountSummarySchema = () =>
  Bun.file(resolve(vendorRoot, "contracts/web-account/account-summary.v1.schema.json")).json() as Promise<JsonSchema>

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

  // The class fix, not the instance: the schema permits EVERY plan property alongside
  // `status: "none"`, so a conforming payload carrying all of them must decode. What the inactive
  // AccountPlan variant cannot represent is discarded, never rejected.
  test("an inactive plan carrying every optional property the schema permits decodes, discarding what it cannot represent", () => {
    const decoded = decodeAccountSummary(
      JSON.stringify({
        schema_version: 1,
        schema: "alpha.web-account.summary.v1",
        balanceFen: 0,
        walletUsedFen: 0,
        plan: {
          id: "legacy-trial",
          name: "Legacy trial",
          status: "none",
          window5h: { usedCredits: 0, limitCredits: 0, resetsInMin: 0 },
          window7d: { usedCredits: 0, limitCredits: 0, resetsInMin: 0 },
          renewsAt: "2026-09-01",
          daysLeft: 0,
        },
        usage: { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 },
        usageSeries: [],
      }),
    )
    expect(decoded.plan).toEqual({ id: "legacy-trial", name: "Legacy trial", status: "none" })
    // Discarded, not merely unread: they must not appear on the value handed to the renderer.
    for (const dropped of ["window5h", "window7d", "renewsAt", "daysLeft"])
      expect(Object.keys(decoded.plan)).not.toContain(dropped)
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

// The mechanism, not another one-off judgement. The decoder screens each object against a key set;
// if upstream adds an optional property and that key set is not updated, the decoder silently
// becomes over-strict and starts rejecting conforming payloads — the exact defect that shipped
// twice on the inactive-plan branch. Binding each key set to the vendored schema's declared
// property set makes that drift a red gate at the moment the pin is bumped, rather than a
// production incident discovered by plan-less users.
describe("account decoder key sets are bound to the vendored schema", () => {
  const cases: Array<{ path: string[]; keys: string[] }> = [
    { path: [], keys: SUMMARY_KEYS },
    { path: ["plan"], keys: PLAN_KEYS },
    { path: ["plan", "window5h"], keys: WINDOW_KEYS },
    { path: ["plan", "window7d"], keys: WINDOW_KEYS },
    { path: ["usage"], keys: USAGE_KEYS },
    { path: ["usageSeries", "[]"], keys: SERIES_KEYS },
  ]

  test("every accepted key set equals the schema's declared property set", async () => {
    const schema = await accountSummarySchema()
    for (const { path, keys } of cases) {
      let node: JsonSchema | undefined = schema
      for (const step of path) node = step === "[]" ? node?.items : (node?.properties?.[step] as JsonSchema | undefined)
      const declared = Object.keys(node?.properties ?? {})
      const label = path.length === 0 ? "<root>" : path.join(".")
      expect(declared.length, `${label}: schema declares no properties — path is wrong`).toBeGreaterThan(0)
      expect([...declared].sort(), label).toEqual([...keys].sort())
    }
  })
})
