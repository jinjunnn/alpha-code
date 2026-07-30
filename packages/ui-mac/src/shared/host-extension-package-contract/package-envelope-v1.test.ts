import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  decodePackageEnvelopeHeaderV1,
  decodePackageProfilePayloadV1,
  type AlphaPackageEnvelopeV1,
} from "./decoder"
import { HOST_EXTENSION_PACKAGE_CORPUS } from "./generate-artifact"
import { HOST_EXTENSION_PACKAGE_LIMITS_V1 } from "./registry"
import { runSyntheticPackageDecoderV1 } from "./synthetic-decoder"

type CorpusCase = {
  name: string
  expect: "accepted" | "blocked" | "skipped"
  envelope: Record<string, unknown>
  payload: Record<string, unknown> | null
}

type Calls = { fetch: number; decoder: number; secret: number; oauth: number; planner: number }

const encoder = new TextEncoder()
const corpus = (await Bun.file(resolve(import.meta.dir, HOST_EXTENSION_PACKAGE_CORPUS)).json()) as {
  schema: string
  cases: CorpusCase[]
}

const jsonBytes = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`)

const runCase = async (item: CorpusCase, calls: Calls) =>
  runSyntheticPackageDecoderV1(jsonBytes(item.envelope), {
    fetchPayload: async () => {
      calls.fetch++
      return item.payload ? jsonBytes(item.payload) : new Uint8Array()
    },
    decodePayload: (profileId, bytes, capabilities) => {
      calls.decoder++
      return decodePackageProfilePayloadV1(profileId, bytes, capabilities)
    },
    resolveSecrets: async () => {
      calls.secret++
    },
    beginOAuth: async () => {
      calls.oauth++
    },
    plan: async () => {
      calls.planner++
      return "planned"
    },
  })

const noCalls = (): Calls => ({ fetch: 0, decoder: 0, secret: 0, oauth: 0, planner: 0 })

describe("AlphaPackageEnvelopeV1 synthetic decoder corpus", () => {
  test("all five Phase 1 profile payloads pass their static strict decoder", async () => {
    expect(corpus.schema).toBe("alpha.host-extension-package.decoder-corpus.v1")
    const cases = corpus.cases.filter((item) => item.expect === "accepted")
    expect(cases.map((item) => item.name)).toEqual([
      "skill-v1",
      "agent-v1",
      "mcp-local-v1",
      "mcp-remote-v1",
      "cloud-v1",
    ])
    for (const item of cases) {
      const calls = noCalls()
      const result = await runCase(item, calls)
      expect(result.ok, item.name).toBe(true)
      expect(calls.fetch, item.name).toBe(1)
      expect(calls.decoder, item.name).toBe(1)
      expect(calls.planner, item.name).toBe(1)
    }
  })

  test("unknown/missing profile or capability stops before every downstream call", async () => {
    const cases = corpus.cases.filter((item) => item.expect !== "accepted")
    expect(cases.map((item) => item.name)).toEqual([
      "unknown-profile-required",
      "unknown-profile-optional",
      "unknown-capability-required",
      "missing-profile-required",
    ])
    for (const item of cases) {
      const calls = noCalls()
      const result = await runCase(item, calls)
      expect(result.ok, item.name).toBe(false)
      expect(result.status, item.name).toBe(item.expect)
      expect(calls, item.name).toEqual(noCalls())
    }

    const missingCapability = structuredClone(corpus.cases[0]!)
    delete (missingCapability.envelope.components as Array<Record<string, unknown>>)[0]!.capabilities
    delete missingCapability.envelope.capabilities
    const calls = noCalls()
    expect((await runCase(missingCapability, calls)).ok).toBe(false)
    expect(calls).toEqual(noCalls())
  })

  test("optional unsupported component is exactly skipped; required is blocked", async () => {
    const required = corpus.cases.find((item) => item.name === "unknown-profile-required")!
    const optional = corpus.cases.find((item) => item.name === "unknown-profile-optional")!
    expect(await runCase(required, noCalls())).toMatchObject({
      ok: false,
      status: "blocked",
      stage: "support",
    })
    expect(await runCase(optional, noCalls())).toMatchObject({
      ok: false,
      status: "skipped",
      stage: "support",
    })
  })

  test("known payload with an unknown behavior key is strictly rejected before prerequisites/planner", async () => {
    const item = structuredClone(corpus.cases.find((entry) => entry.name === "mcp-remote-v1")!)
    ;(item.payload!.behavior as Record<string, unknown>).executeScript = true
    bindPayload(item)
    const calls = noCalls()
    const result = await runCase(item, calls)
    expect(result).toMatchObject({ ok: false, status: "blocked", stage: "payload" })
    expect(result.ok ? [] : result.errors.join("\n")).toContain(
      'payload.behavior: unknown key "executeScript"',
    )
    expect(calls).toEqual({ fetch: 1, decoder: 1, secret: 0, oauth: 0, planner: 0 })
  })

  test("header rejects depth, count, bytes, control characters, and prototype-pollution keys", () => {
    const valid = structuredClone(corpus.cases[0]!.envelope)

    const deep = structuredClone(valid)
    deep.extra = { a: { b: { c: { d: { e: { f: true } } } } } }
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(deep)))).toContain("depth")

    const crowded = structuredClone(valid)
    crowded.extra = Array.from({ length: 140 }, (_, index) => index)
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(crowded)))).toContain("node limit")

    expect(
      errorsOf(
        decodePackageEnvelopeHeaderV1(
          new Uint8Array(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxEnvelopeBytes + 1),
        ),
      ),
    ).toContain("bytes exceeds")

    const control = structuredClone(valid)
    ;(control.presentation as Record<string, unknown>).description = "bad\u0000value"
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(control)))).toContain(
      "control characters",
    )

    const text = JSON.stringify(valid).replace("{", '{"__proto__":{"polluted":true},')
    expect(errorsOf(decodePackageEnvelopeHeaderV1(encoder.encode(text)))).toContain(
      "prototype-pollution",
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("unknown envelope/profile version, inline payload, and bad package union fail closed", () => {
    const unknownEnvelope = structuredClone(corpus.cases[0]!.envelope)
    unknownEnvelope.schema = "alpha.host-extension-package.v2"
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(unknownEnvelope)))).toContain(
      "unsupported version",
    )

    const unknownProfileVersion = structuredClone(corpus.cases[0]!.envelope)
    ;(unknownProfileVersion.components as Array<Record<string, unknown>>)[0]!.profileVersion = 2
    const profileResult = decodePackageEnvelopeHeaderV1(jsonBytes(unknownProfileVersion))
    expect(profileResult).toMatchObject({ ok: false, stage: "support", status: "blocked" })

    const inline = structuredClone(corpus.cases[0]!.envelope)
    ;(inline.components as Array<Record<string, unknown>>)[0]!.payloadRef = {
      inline: { behavior: {} },
    }
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(inline)))).toContain(
      'unknown key "inline"',
    )

    const union = structuredClone(corpus.cases[0]!.envelope)
    union.capabilities = ["alpha.mcp-oauth.v1"]
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(union)))).toContain(
      "sorted union",
    )
  })
})

function bindPayload(item: CorpusCase): void {
  const bytes = jsonBytes(item.payload)
  const payloadRef = (
    (item.envelope.components as Array<Record<string, unknown>>)[0]!.payloadRef as Record<
      string,
      unknown
    >
  )
  payloadRef.bytes = bytes.byteLength
  payloadRef.sha256 = createHash("sha256").update(bytes).digest("hex")
}

function errorsOf(result: ReturnType<typeof decodePackageEnvelopeHeaderV1>): string {
  return result.ok ? "" : result.errors.join("\n")
}
