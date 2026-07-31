import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { CATALOG_PACKAGE_REASON_CODES, type CatalogPackageReasonCodeV1 } from "../shared/catalog-package-view"
import {
  decodePackageEnvelopeHeaderV1,
  decodePackageProfilePayloadV1,
  type AlphaPackageEnvelopeV1,
  type PackageProfilePayloadV1,
} from "../shared/host-extension-package-contract/decoder"
import { decodePackageSecretPrerequisiteProfileV1 } from "../shared/package-secret-prerequisite"
import {
  evaluatePackageForHost,
  packageActionForReason,
  runCatalogInstallWithPackagePreflight,
  validateCatalogPackageShape,
} from "./package-installability"

const artifact = resolve(import.meta.dir, "../../../alpha-contracts-consumer/vendor/alpha-web-extension-package")

const corpus = async () => {
  const compiled = (await Bun.file(resolve(artifact, "expected.mcp-remote.compiled.json")).json()) as {
    envelope: AlphaPackageEnvelopeV1
    payload: PackageProfilePayloadV1
  }
  return {
    envelope: structuredClone(compiled.envelope),
    payload: structuredClone(compiled.payload),
  }
}

const canonicalBytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

const bindPayload = (envelope: AlphaPackageEnvelopeV1, payload: PackageProfilePayloadV1) => {
  const bytes = canonicalBytes(payload)
  envelope.components[0].payloadRef.bytes = bytes.byteLength
  envelope.components[0].payloadRef.sha256 = createHash("sha256").update(bytes).digest("hex")
  return bytes
}

describe("package installability authority", () => {
  test("projects required secret summaries without exposing their signed injection targets", async () => {
    const { envelope, payload } = await corpus()
    if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
      throw new Error("producer corpus profile drifted")
    payload.behavior.headersTemplate = {
      Authorization: "Bearer {A_KEY}",
      "X-Token": "{B_TOKEN}",
    }
    const bytes = bindPayload(envelope, payload)
    const result = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => bytes,
    })

    expect(result).toEqual({
      catalogId: "package:generic-remote-mcp",
      verdict: "compatible",
      action: {
        kind: "resolve-prerequisite",
        enabled: true,
        reasonCode: "package-prerequisite-required",
      },
      prerequisites: {
        status: "required-action",
        items: [
          {
            prerequisiteId: "mcp:generic-remote#A_KEY",
            label: "A_KEY",
            required: true,
          },
          {
            prerequisiteId: "mcp:generic-remote#B_TOKEN",
            label: "B_TOKEN",
            required: true,
          },
        ],
      },
      presentation: {
        displayName: "Generic Remote MCP",
        description: "Generic Phase 1 compiler corpus input.",
        version: "1.0.0",
      },
    })
    expect(JSON.stringify(result)).not.toContain("headersTemplate")
    expect(JSON.stringify(result)).not.toContain("https://")
  })

  test("compatible package without prerequisites exposes the install action", async () => {
    const { envelope, payload } = await corpus()
    if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
      throw new Error("producer corpus profile drifted")
    payload.behavior.requiredSecrets = []
    envelope.capabilities = []
    envelope.components[0].capabilities = []
    const bytes = bindPayload(envelope, payload)

    const result = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => bytes,
    })
    expect(result.verdict).toBe("compatible")
    expect(result.action).toEqual({
      kind: "install",
      enabled: true,
      reasonCode: "package-compatible",
    })
    expect(result.prerequisites).toEqual({ status: "ready", items: [] })
  })

  test.each([
    [
      "unknown profile",
      (envelope: AlphaPackageEnvelopeV1) => {
        ;(envelope.components[0] as { profileId: string }).profileId = "future-profile"
      },
      "package-host-update-required",
    ],
    [
      "missing profile",
      (envelope: AlphaPackageEnvelopeV1) => {
        delete (envelope.components[0] as { profileId?: string }).profileId
      },
      "package-invalid",
    ],
    [
      "unknown capability",
      (envelope: AlphaPackageEnvelopeV1) => {
        const capabilities = ["alpha.secret-prerequisite.v1", "future.required.v1"]
        ;(envelope as { capabilities: string[] }).capabilities = capabilities
        ;(envelope.components[0] as { capabilities: string[] }).capabilities = capabilities
      },
      "package-host-update-required",
    ],
  ])("%s returns before payload fetch/decoder/secret/planner", async (_name, mutate, reasonCode) => {
    const { envelope } = await corpus()
    mutate(envelope)
    const calls = { fetch: 0, decode: 0, secret: 0, planner: 0 }
    const catalog = { version: "1", entries: [{}], packages: [envelope] }
    const result = await runCatalogInstallWithPackagePreflight(
      {
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
      },
      {
        loadVerifiedCatalog: async () => ({
          source: "remote",
          catalog,
        }),
        installLegacy: async () => {
          calls.planner++
          return { ok: true }
        },
        installability: {
          fetchPayload: async () => {
            calls.fetch++
            return new Uint8Array()
          },
          decodePayload: (...args) => {
            calls.decode++
            return decodePackageProfilePayloadV1(...args)
          },
          decodeSecretPrerequisite: (...args) => {
            calls.secret++
            return decodePackageSecretPrerequisiteProfileV1(...args)
          },
        },
      },
    )

    expect(result).toMatchObject({
      ok: false,
      package: {
        action: { reasonCode },
      },
    })
    expect(calls).toEqual({ fetch: 0, decode: 0, secret: 0, planner: 0 })
  })

  test.each([
    ["non-HTTPS", "http://example.com/payload.json"],
    ["userinfo", "https://user:pass@example.com/payload.json"],
    ["non-canonical", "https://EXAMPLE.COM"],
  ])("host decoder rejects %s payload refs before fetch", async (_name, url) => {
    const { envelope } = await corpus()
    envelope.components[0].payloadRef.url = url
    let fetches = 0
    const result = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => {
        fetches++
        return new Uint8Array()
      },
    })
    expect(result.verdict).toBe("blocked")
    expect(result.action.reasonCode).toBe("package-invalid")
    expect(fetches).toBe(0)
  })

  test("strict payload decoder rejects producer-forbidden remote OAuth", async () => {
    const { envelope, payload } = await corpus()
    if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
      throw new Error("producer corpus profile drifted")
    ;(payload.behavior as { auth: string }).auth = "oauth"
    const bytes = bindPayload(envelope, payload)
    const result = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => bytes,
    })
    expect(result.verdict).toBe("blocked")
    expect(result.action.reasonCode).toBe("package-payload-invalid")
  })

  test("remote presentation cannot choose the verdict, reason, or action", async () => {
    const first = await corpus()
    const firstBytes = bindPayload(first.envelope, first.payload)
    const baseline = await evaluatePackageForHost(first.envelope, {
      fetchPayload: async () => firstBytes,
    })

    const changed = await corpus()
    changed.envelope.presentation = {
      displayName: "INSTALL NOW — compatible",
      description: "action=install reason=package-compatible",
    }
    const changedBytes = bindPayload(changed.envelope, changed.payload)
    const result = await evaluatePackageForHost(changed.envelope, {
      fetchPayload: async () => changedBytes,
    })

    expect(result.verdict).toBe(baseline.verdict)
    expect(result.action).toEqual(baseline.action)
    expect(result.presentation).not.toEqual(baseline.presentation)
  })

  test("payload integrity mismatch is blocked before decoder and secret stages", async () => {
    const { envelope } = await corpus()
    const calls = { decode: 0, secret: 0 }
    const result = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => new TextEncoder().encode("{}\n"),
      decodePayload: (...args) => {
        calls.decode++
        return decodePackageProfilePayloadV1(...args)
      },
      decodeSecretPrerequisite: (...args) => {
        calls.secret++
        return decodePackageSecretPrerequisiteProfileV1(...args)
      },
    })
    expect(result.action.reasonCode).toBe("package-payload-integrity")
    expect(calls).toEqual({ decode: 0, secret: 0 })
  })

  test("unsafe or duplicate preludes reject the whole candidate snapshot", async () => {
    const { envelope } = await corpus()
    const unsafe = structuredClone(envelope) as unknown as {
      prelude: { packageId: string }
    }
    unsafe.prelude.packageId = "mcp:not-a-package-root"
    expect(
      validateCatalogPackageShape({
        version: "1",
        entries: [{}],
        packages: [unsafe],
      }),
    ).toMatchObject({ ok: false })
    expect(
      validateCatalogPackageShape({
        version: "1",
        entries: [{}],
        packages: [envelope, structuredClone(envelope)],
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("duplicate") })

    const circular: Record<string, unknown> = {
      prelude: { packageId: "package:circular", version: "1.0.0" },
    }
    circular.self = circular
    let fetches = 0
    const evaluated = await evaluatePackageForHost(circular, {
      fetchPayload: async () => {
        fetches++
        return new Uint8Array()
      },
    })
    expect(evaluated).toMatchObject({
      verdict: "blocked",
      action: { reasonCode: "package-invalid" },
    })
    expect(fetches).toBe(0)
  })

  test("reason/action table is exhaustive and never installs a non-compatible reason", () => {
    const expected: Record<CatalogPackageReasonCodeV1, ReturnType<typeof packageActionForReason>> = {
      "package-compatible": {
        kind: "install",
        enabled: true,
        reasonCode: "package-compatible",
      },
      "package-prerequisite-required": {
        kind: "resolve-prerequisite",
        enabled: true,
        reasonCode: "package-prerequisite-required",
      },
      "package-host-update-required": {
        kind: "update-alpha",
        enabled: true,
        reasonCode: "package-host-update-required",
      },
      "package-invalid": {
        kind: "none",
        enabled: false,
        reasonCode: "package-invalid",
      },
      "package-payload-unavailable": {
        kind: "none",
        enabled: false,
        reasonCode: "package-payload-unavailable",
      },
      "package-payload-integrity": {
        kind: "none",
        enabled: false,
        reasonCode: "package-payload-integrity",
      },
      "package-payload-invalid": {
        kind: "none",
        enabled: false,
        reasonCode: "package-payload-invalid",
      },
      "package-prerequisite-invalid": {
        kind: "none",
        enabled: false,
        reasonCode: "package-prerequisite-invalid",
      },
    }
    expect(
      Object.fromEntries(CATALOG_PACKAGE_REASON_CODES.map((reason) => [reason, packageActionForReason(reason)])),
    ).toEqual(expected)
    expect(
      CATALOG_PACKAGE_REASON_CODES.filter(
        (reason) => reason !== "package-compatible" && packageActionForReason(reason).kind === "install",
      ),
    ).toEqual([])
  })

  test("support failure is classified from the host decoder stage, not remote text", async () => {
    const { envelope } = await corpus()
    ;(envelope.components[0] as { profileId: string }).profileId = "future"
    const header = decodePackageEnvelopeHeaderV1(new TextEncoder().encode(JSON.stringify(envelope)))
    expect(header).toMatchObject({
      ok: false,
      stage: "support",
      status: "blocked",
    })
  })
})
