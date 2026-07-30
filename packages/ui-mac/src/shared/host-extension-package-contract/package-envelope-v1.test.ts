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

type Calls = { fetch: number; decoder: number; secret: number; planner: number }

const encoder = new TextEncoder()
const corpus = (await Bun.file(resolve(import.meta.dir, HOST_EXTENSION_PACKAGE_CORPUS)).json()) as {
  schema: string
  cases: CorpusCase[]
}

const jsonBytes = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`)

const runCase = async (
  item: CorpusCase,
  calls: Calls,
  payloadBytes = item.payload ? jsonBytes(item.payload) : new Uint8Array(),
) =>
  runSyntheticPackageDecoderV1(jsonBytes(item.envelope), {
    fetchPayload: async () => {
      calls.fetch++
      return payloadBytes
    },
    decodePayload: (profileId, bytes, capabilities) => {
      calls.decoder++
      return decodePackageProfilePayloadV1(profileId, bytes, capabilities)
    },
    resolveSecrets: async () => {
      calls.secret++
    },
    plan: async () => {
      calls.planner++
      return "planned"
    },
  })

const noCalls = (): Calls => ({ fetch: 0, decoder: 0, secret: 0, planner: 0 })

type NegativeCase = {
  name: string
  source: "skill-v1" | "mcp-local-v1" | "mcp-remote-v1"
  mode: "header" | "payload" | "package"
  error: string
  mutateEnvelope?: (envelope: Record<string, unknown>) => void
  mutatePayload?: (payload: Record<string, unknown>) => void
  payloadBytes?: (payload: Record<string, unknown>) => Uint8Array
}

const negativeCases: NegativeCase[] = [
  {
    name: "payload depth limit",
    source: "skill-v1",
    mode: "payload",
    error: "depth 9 exceeds 8",
    mutatePayload: (payload) => {
      ;(behaviorOf(payload).asset as Record<string, unknown>).extra = {
        a: { b: { c: { d: { e: true } } } },
      }
    },
  },
  {
    name: "payload node limit",
    source: "skill-v1",
    mode: "payload",
    error: "node limit 512 exceeded",
    mutatePayload: (payload) => {
      ;(behaviorOf(payload).asset as Record<string, unknown>).extra = Array.from(
        { length: 520 },
        (_, index) => index,
      )
    },
  },
  {
    name: "payload control character",
    source: "skill-v1",
    mode: "payload",
    error: "control characters not allowed",
    mutatePayload: (payload) => {
      behaviorOf(payload).targetDir = "alpha-skills\u0000"
    },
  },
  {
    name: "payload prototype-pollution key",
    source: "skill-v1",
    mode: "payload",
    error: 'prototype-pollution key "__proto__" refused',
    payloadBytes: (payload) =>
      encoder.encode(JSON.stringify(payload).replace("{", '{"__proto__":{"polluted":true},')),
  },
  {
    name: "payload byte limit",
    source: "skill-v1",
    mode: "payload",
    error: "bytes exceeds",
    payloadBytes: () => new Uint8Array(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes + 1),
  },
  {
    name: "payload maxStringBytes",
    source: "skill-v1",
    mode: "payload",
    error: "string exceeds 4096 UTF-8 bytes",
    mutatePayload: (payload) => {
      behaviorOf(payload).targetDir = "é".repeat(2049)
    },
  },
  {
    name: "payload property-name control character",
    source: "skill-v1",
    mode: "payload",
    error: "control characters in property names not allowed",
    mutatePayload: (payload) => {
      behaviorOf(payload)["bad\u0000key"] = true
    },
  },
  {
    name: "capability count limit",
    source: "skill-v1",
    mode: "header",
    error: "exceeds 16 items",
    mutateEnvelope: (envelope) => {
      const capabilities = Array.from(
        { length: 17 },
        (_, index) => `alpha.capability-${String(index).padStart(2, "0")}.v1`,
      )
      componentOf(envelope).capabilities = capabilities
      envelope.capabilities = capabilities
    },
  },
  {
    name: "capabilities sorted and unique",
    source: "mcp-local-v1",
    mode: "header",
    error: "must be unique and byte-order sorted",
    mutateEnvelope: (envelope) => {
      const capabilities = [
        "alpha.secret-prerequisite.v1",
        "alpha.secret-prerequisite.v1",
      ]
      componentOf(envelope).capabilities = capabilities
      envelope.capabilities = capabilities
    },
  },
  {
    name: "payloadRef URL is HTTPS-only",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "http://example.invalid/package.json"
    },
  },
  {
    name: "payloadRef URL has no credentials",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "https://user:pass@example.invalid/package.json"
    },
  },
  {
    name: "payloadRef URL has canonical hostname",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "https://EXAMPLE.invalid/package.json"
    },
  },
  {
    name: "payloadRef bare origin has canonical slash",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "https://example.invalid"
    },
  },
  {
    name: "payload remote URL is HTTPS-only",
    source: "mcp-remote-v1",
    mode: "package",
    error: "required canonical HTTPS URL without credentials",
    mutatePayload: (payload) => {
      behaviorOf(payload).url = "http://mcp.example.invalid/service"
    },
  },
  {
    name: "payload remote URL has no credentials",
    source: "mcp-remote-v1",
    mode: "package",
    error: "required canonical HTTPS URL without credentials",
    mutatePayload: (payload) => {
      behaviorOf(payload).url = "https://user:pass@mcp.example.invalid/service"
    },
  },
  {
    name: "payload remote URL is canonical",
    source: "mcp-remote-v1",
    mode: "package",
    error: "required canonical HTTPS URL without credentials",
    mutatePayload: (payload) => {
      behaviorOf(payload).url = "https://MCP.example.invalid/service"
    },
  },
  {
    name: "compiler-derived capabilities are rechecked before prerequisites and planner",
    source: "mcp-local-v1",
    mode: "package",
    error: "compiler-derived capabilities",
    mutateEnvelope: (envelope) => {
      componentOf(envelope).capabilities = []
      envelope.capabilities = []
    },
  },
  {
    name: "dependencies must be empty",
    source: "skill-v1",
    mode: "header",
    error: "Phase 1 requires an empty array",
    mutateEnvelope: (envelope) => {
      componentOf(envelope).dependencies = ["skill:other"]
    },
  },
  {
    name: "exactly one component",
    source: "skill-v1",
    mode: "header",
    error: "Phase 1 requires exactly one component",
    mutateEnvelope: (envelope) => {
      envelope.components = [
        ...(envelope.components as Array<Record<string, unknown>>),
        structuredClone(componentOf(envelope)),
      ]
    },
  },
  {
    name: "payloadRef mediaType is profile-bound",
    source: "skill-v1",
    mode: "header",
    error: "expected \"application/vnd.alpha.host-extension-package.skill.v1+json\"",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).mediaType =
        "application/vnd.alpha.host-extension-package.mcp-local.v1+json"
    },
  },
  {
    name: "payload schema matches profile",
    source: "skill-v1",
    mode: "package",
    error: 'payload.schema: expected "alpha.host-extension-package.payload.skill.v1"',
    mutatePayload: (payload) => {
      payload.schema = "alpha.host-extension-package.payload.agent.v1"
    },
  },
  {
    name: "packageId regex",
    source: "skill-v1",
    mode: "header",
    error: "envelope.prelude.packageId: invalid format",
    mutateEnvelope: (envelope) => {
      ;(envelope.prelude as Record<string, unknown>).packageId = "Skill:demo"
    },
  },
  {
    name: "version regex",
    source: "skill-v1",
    mode: "header",
    error: "envelope.prelude.version: invalid format",
    mutateEnvelope: (envelope) => {
      ;(envelope.prelude as Record<string, unknown>).version = "-1"
    },
  },
  {
    name: "environment-name regex",
    source: "mcp-local-v1",
    mode: "package",
    error: 'payload.behavior.environment: invalid key "bad-name"',
    mutatePayload: (payload) => {
      behaviorOf(payload).environment = { "bad-name": "value" }
    },
  },
  {
    name: "sha256 lowercase-hex regex",
    source: "skill-v1",
    mode: "header",
    error: "payloadRef.sha256: invalid format",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).sha256 = "G".repeat(64)
    },
  },
  {
    name: "payloadRef bytes lower bound",
    source: "skill-v1",
    mode: "header",
    error: "required integer in 1..1048576",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).bytes = 0
    },
  },
  {
    name: "payloadRef bytes upper bound",
    source: "skill-v1",
    mode: "header",
    error: "required integer in 1..1048576",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).bytes = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes + 1
    },
  },
  {
    name: "payload UTF-8 fatal decode",
    source: "skill-v1",
    mode: "payload",
    error: "not valid UTF-8",
    payloadBytes: () => new Uint8Array([0xc3, 0x28]),
  },
  {
    name: "profileVersion must be an integer",
    source: "skill-v1",
    mode: "header",
    error: "required positive 32-bit integer",
    mutateEnvelope: (envelope) => {
      componentOf(envelope).profileVersion = 1.5
    },
  },
  {
    name: "profileVersion lower bound",
    source: "skill-v1",
    mode: "header",
    error: "required positive 32-bit integer",
    mutateEnvelope: (envelope) => {
      componentOf(envelope).profileVersion = 0
    },
  },
  {
    name: "profileVersion upper bound",
    source: "skill-v1",
    mode: "header",
    error: "required positive 32-bit integer",
    mutateEnvelope: (envelope) => {
      componentOf(envelope).profileVersion = 2147483648
    },
  },
  {
    name: "remote auth enum",
    source: "mcp-remote-v1",
    mode: "package",
    error: 'payload.behavior.auth: expected "none"',
    mutatePayload: (payload) => {
      behaviorOf(payload).auth = "oauth"
    },
  },
  {
    name: "targetDir enum",
    source: "skill-v1",
    mode: "package",
    error: "payload.behavior.targetDir: expected one of [alpha-skills, global]",
    mutatePayload: (payload) => {
      behaviorOf(payload).targetDir = "skills"
    },
  },
  {
    name: "requiredSecrets sorted and unique",
    source: "mcp-local-v1",
    mode: "package",
    error: "payload.behavior.requiredSecrets: must be unique and byte-order sorted",
    mutatePayload: (payload) => {
      behaviorOf(payload).requiredSecrets = ["B_KEY", "A_KEY"]
    },
  },
]

describe("AlphaPackageEnvelopeV1 synthetic decoder corpus", () => {
  test("all four Phase 1 profile payloads pass their static strict decoder", async () => {
    expect(corpus.schema).toBe("alpha.host-extension-package.decoder-corpus.v1")
    const cases = corpus.cases.filter((item) => item.expect === "accepted")
    expect(cases.map((item) => item.name)).toEqual([
      "skill-v1",
      "agent-v1",
      "mcp-local-v1",
      "mcp-remote-v1",
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
    expect(calls).toEqual({ fetch: 1, decoder: 1, secret: 0, planner: 0 })
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

  test.each(negativeCases)("$name", async (negative) => {
    const source = corpus.cases.find((item) => item.name === negative.source)!
    const item = structuredClone(source)
    negative.mutateEnvelope?.(item.envelope)
    if (negative.mutatePayload) negative.mutatePayload(item.payload!)
    const payloadBytes = negative.payloadBytes?.(item.payload!) ?? jsonBytes(item.payload)
    const calls = noCalls()
    if (negative.mode === "payload") {
      const header = decodePackageEnvelopeHeaderV1(jsonBytes(source.envelope))
      if (!header.ok) throw new Error(`invalid source ${negative.source}: ${header.errors.join("\n")}`)
      const result = decodePackageProfilePayloadV1(
        header.envelope.components[0].profileId,
        payloadBytes,
        header.envelope.capabilities,
      )
      expect(result.ok ? "" : result.errors.join("\n")).toContain(negative.error)
      expect(calls).toEqual(noCalls())
      return
    }
    if (negative.mode === "package") bindPayload(item, payloadBytes)
    const result = await runCase(item, calls, payloadBytes)
    expect(result.ok ? "" : result.errors.join("\n")).toContain(negative.error)
    if (negative.mode === "header") {
      expect(calls).toEqual(noCalls())
      return
    }
    expect(calls).toEqual({ fetch: 1, decoder: 1, secret: 0, planner: 0 })
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
    union.capabilities = ["alpha.future.v1"]
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(union)))).toContain(
      "sorted union",
    )
  })
})

function bindPayload(item: CorpusCase, bytes = jsonBytes(item.payload)): void {
  const payloadRef = payloadRefOf(item.envelope)
  payloadRef.bytes = bytes.byteLength
  payloadRef.sha256 = createHash("sha256").update(bytes).digest("hex")
}

function componentOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return (envelope.components as Array<Record<string, unknown>>)[0]!
}

function payloadRefOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return componentOf(envelope).payloadRef as Record<string, unknown>
}

function behaviorOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.behavior as Record<string, unknown>
}

function errorsOf(result: ReturnType<typeof decodePackageEnvelopeHeaderV1>): string {
  return result.ok ? "" : result.errors.join("\n")
}
