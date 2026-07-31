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
  fetchPackagePayload,
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

const packageWithComponentName = (
  profileId: "skill" | "agent" | "mcp-local" | "mcp-remote",
  name: string,
  requiredSecrets: string[] = [],
) => {
  const payload =
    profileId === "skill" || profileId === "agent"
      ? {
          schema: `alpha.host-extension-package.payload.${profileId}.v1`,
          behavior: {
            targetDir: profileId === "skill" ? "alpha-skills" : "alpha-agents",
            asset: {
              sha256: "a".repeat(64),
              bytes: 1,
              mediaType: "text/markdown",
              url: "https://example.invalid/extension.md",
            },
          },
        }
      : profileId === "mcp-local"
        ? {
            schema: "alpha.host-extension-package.payload.mcp-local.v1",
            behavior: { command: ["demo"], environment: {}, requiredSecrets },
          }
        : {
            schema: "alpha.host-extension-package.payload.mcp-remote.v1",
            behavior: {
              url: "https://mcp.example.invalid/service",
              headersTemplate: Object.fromEntries(
                requiredSecrets.map((variable, index) => [`X-Secret-${index}`, `{${variable}}`]),
              ),
              requiredSecrets,
              auth: "none",
            },
          }
  const bytes = canonicalBytes(payload)
  const capabilities = requiredSecrets.length ? ["alpha.secret-prerequisite.v1"] : []
  return {
    envelope: {
      schema: "alpha.host-extension-package.v1",
      prelude: { packageId: `package:${profileId}-name-boundary`, version: "1.0.0" },
      presentation: { displayName: profileId, description: "Host name boundary case" },
      components: [
        {
          id: `${profileId}:${name}`,
          required: true,
          dependencies: [],
          profileId,
          profileVersion: 1,
          capabilities,
          payloadRef: {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.byteLength,
            mediaType: `application/vnd.alpha.host-extension-package.${profileId}.v1+json`,
            url: "https://example.invalid/payload.json",
          },
        },
      ],
      capabilities,
    },
    bytes,
  }
}

describe("package installability authority", () => {
  test.each(["skill:demo-package", `${"n".repeat(31)}:${"a".repeat(128)}`])(
    "the contract-accepted package ID %s is not narrowed by the host",
    async (packageId) => {
      const { envelope, payload } = await corpus()
      if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
        throw new Error("producer corpus profile drifted")
      envelope.prelude = { packageId, version: "v".repeat(64) }
      payload.behavior.requiredSecrets = []
      // headersTemplate 必须一起清:宿主规则是双向的(每个 {NAME} 占位必须被声明)。
      // #738 re-vendor 之后 producer corpus 带上了真实 headersTemplate,只清一半就成了
      // 自相矛盾的夹具 —— 本仓已在三处踩过这个坑,判据是「两个字段一起改,别只改一个」。
      payload.behavior.headersTemplate = {}
      envelope.capabilities = []
      envelope.components[0].capabilities = []
      const bytes = bindPayload(envelope, payload)

      expect(decodePackageEnvelopeHeaderV1(canonicalBytes(envelope))).toMatchObject({
        ok: true,
        status: "accepted",
      })
      expect(validateCatalogPackageShape({ packages: [envelope] })).toMatchObject({
        ok: true,
        packages: [{ prelude: { packageId, version: "v".repeat(64) } }],
      })
      expect(
        await evaluatePackageForHost(envelope, {
          fetchPayload: async () => bytes,
        }),
      ).toMatchObject({
        catalogId: packageId,
        verdict: "compatible",
        action: { enabled: true },
      })
    },
  )

  test("a package ID rejected by the contract remains blocked by the host", async () => {
    const { envelope } = await corpus()
    envelope.prelude.packageId = "Skill:demo-package"

    expect(decodePackageEnvelopeHeaderV1(canonicalBytes(envelope))).toMatchObject({ ok: false })
    expect(validateCatalogPackageShape({ packages: [envelope] })).toMatchObject({ ok: false })
    expect(await evaluatePackageForHost(envelope)).toMatchObject({
      catalogId: "package:invalid",
      verdict: "blocked",
      action: { enabled: false, reasonCode: "package-invalid" },
    })
  })

  test("a contract-accepted namespace reaches package admission instead of the legacy planner", async () => {
    const calls = { package: 0, legacy: 0, catalog: 0 }
    const result = await runCatalogInstallWithPackagePreflight(
      {
        catalogId: "skill:demo-package",
        scope: { scope: "global" },
        attemptId: "attempt-1",
      },
      {
        loadVerifiedCatalog: async () => {
          calls.catalog++
          return { source: "none", error: "must not load before admission" }
        },
        installLegacy: async () => {
          calls.legacy++
          return { route: "legacy" }
        },
        installPackage: async () => {
          calls.package++
          return { route: "package" }
        },
      },
    )

    expect(result).toEqual({ route: "package" })
    expect(calls).toEqual({ package: 1, legacy: 0, catalog: 0 })
  })

  test.each(["skill", "agent"] as const)(
    "%s with an unrepresentable component name is disabled during installability",
    async (profileId) => {
      const item = packageWithComponentName(profileId, "a".repeat(65))
      expect(decodePackageEnvelopeHeaderV1(canonicalBytes(item.envelope))).toMatchObject({ ok: true })
      expect(
        await evaluatePackageForHost(item.envelope, {
          fetchPayload: async () => item.bytes,
        }),
      ).toMatchObject({
        verdict: "blocked",
        action: { enabled: false, reasonCode: "package-invalid" },
      })
    },
  )

  test.each(["mcp-local", "mcp-remote"] as const)(
    "%s with an unrepresentable secret-store name is disabled even without secrets",
    async (profileId) => {
      const item = packageWithComponentName(profileId, "a".repeat(65))
      expect(decodePackageEnvelopeHeaderV1(canonicalBytes(item.envelope))).toMatchObject({ ok: true })
      expect(
        await evaluatePackageForHost(item.envelope, {
          fetchPayload: async () => item.bytes,
        }),
      ).toMatchObject({
        verdict: "blocked",
        action: { enabled: false, reasonCode: "package-prerequisite-invalid" },
      })
    },
  )

  test.each(["skill", "agent", "mcp-local", "mcp-remote"] as const)(
    "%s consumes the shared host-name decision at the 64-character boundary",
    async (profileId) => {
      const item = packageWithComponentName(profileId, "a".repeat(64))
      expect(
        await evaluatePackageForHost(item.envelope, {
          fetchPayload: async () => item.bytes,
        }),
      ).toMatchObject({ verdict: "compatible", action: { enabled: true } })
    },
  )

  test("decoded maximum-length secret names are not reinterpreted by prerequisite projection", async () => {
    const variable = "A".repeat(128)
    const item = packageWithComponentName("mcp-local", "secret-boundary", [variable])
    expect(
      await evaluatePackageForHost(item.envelope, {
        fetchPayload: async () => item.bytes,
      }),
    ).toMatchObject({
      verdict: "compatible",
      action: { enabled: true, reasonCode: "package-prerequisite-required" },
      prerequisites: { items: [{ prerequisiteId: `mcp-local:secret-boundary#${variable}` }] },
    })
  })

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
    // headersTemplate 必须一起清:宿主的规则是双向的(每个 {NAME} 占位必须被声明),
    // 只清 requiredSecrets 会造出一个自相矛盾的夹具。旧 corpus 的 headersTemplate 恰好是空的,
    // 所以这一点直到 alpha-web#101 把消费闸补进语料、re-vendor 之后才暴露。
    payload.behavior.headersTemplate = {}
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

  test("update-required safe view preserves the decoded package presentation", async () => {
    const { envelope } = await corpus()
    ;(envelope.components[0] as { profileId: string }).profileId = "future-profile"

    expect(await evaluatePackageForHost(envelope)).toEqual({
      catalogId: "package:generic-remote-mcp",
      verdict: "update-required",
      action: {
        kind: "update-alpha",
        enabled: true,
        reasonCode: "package-host-update-required",
      },
      prerequisites: { status: "ready", items: [] },
      presentation: {
        displayName: "Generic Remote MCP",
        description: "Generic Phase 1 compiler corpus input.",
        version: "1.0.0",
      },
    })

    // 上面那三个值恰好等于 corpus 的值,所以单靠它杀不掉「把 presentation 写死成常量」——
    // 全仓 package 语料只有这一个 presentation,没有任何断言能区分「取的是这个包自己的」
    // 和「取的是一个常量」。再评一次、换一份 presentation,断言它真的跟着变。
    const other = await corpus()
    ;(other.envelope.components[0] as { profileId: string }).profileId = "future-profile"
    other.envelope.presentation = {
      displayName: "Second Corpus Package",
      description: "A different description, so a hard-coded value cannot pass.",
    }
    const second = await evaluatePackageForHost(other.envelope)
    expect(second.verdict).toBe("update-required")
    expect(second.presentation).toEqual({
      displayName: "Second Corpus Package",
      description: "A different description, so a hard-coded value cannot pass.",
      version: "1.0.0",
    })
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
    [
      "unknown profileVersion",
      (envelope: AlphaPackageEnvelopeV1) => {
        ;(envelope.components[0] as { profileVersion: number }).profileVersion = 2
      },
      "package-host-update-required",
    ],
    [
      "profile mediaType mismatch",
      (envelope: AlphaPackageEnvelopeV1) => {
        envelope.components[0].payloadRef.mediaType =
          "application/vnd.alpha.host-extension-package.skill.v1+json"
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
        attemptId: "preflight-attempt",
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

  test("payload fetch failure has the package-payload-unavailable behavior code", async () => {
    const { envelope } = await corpus()
    const result = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => {
        throw new Error("offline")
      },
    })
    expect(result.action.reasonCode).toBe("package-payload-unavailable")
  })

  test("secret prerequisite decoder refusal has the package-prerequisite-invalid behavior code", async () => {
    const { envelope, payload } = await corpus()
    const bytes = bindPayload(envelope, payload)
    const result = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => bytes,
      decodeSecretPrerequisite: () => ({
        ok: false,
        state: "blocked",
        reasonCode: "secret-profile-invalid",
        errors: ["injected refusal"],
      }),
    })
    expect(result.action.reasonCode).toBe("package-prerequisite-invalid")
  })

  test("default payload fetch refuses the declared byte limit before network", async () => {
    let calls = 0
    await expect(
      fetchPackagePayload(
        {
          sha256: "a".repeat(64),
          bytes: 1024 * 1024 + 1,
          mediaType: "application/json",
          url: "https://example.com/payload",
        },
        (async () => {
          calls++
          return new Response()
        }) as typeof fetch,
      ),
    ).rejects.toThrow("exceeds host limit")
    expect(calls).toBe(0)
  })

  test('default payload fetch sets redirect:"error"', async () => {
    let redirect: RequestRedirect | undefined
    const bytes = await fetchPackagePayload(
      {
        sha256: "a".repeat(64),
        bytes: 1,
        mediaType: "application/json",
        url: "https://example.com/payload",
      },
      (async (_input, init) => {
        redirect = init?.redirect
        return new Response(new Uint8Array([1]), { status: 200 })
      }) as typeof fetch,
    )
    expect(redirect).toBe("error")
    expect(bytes).toEqual(new Uint8Array([1]))
  })

  test("default payload fetch rejects a non-success HTTP status", async () => {
    await expect(
      fetchPackagePayload(
        {
          sha256: "a".repeat(64),
          bytes: 1,
          mediaType: "application/json",
          url: "https://example.com/payload",
        },
        (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
      ),
    ).rejects.toThrow("HTTP 503")
  })

  test("default payload fetch rejects actual bytes above the host limit", async () => {
    await expect(
      fetchPackagePayload(
        {
          sha256: "a".repeat(64),
          bytes: 1,
          mediaType: "application/json",
          url: "https://example.com/payload",
        },
        (async () =>
          new Response(new Uint8Array(1024 * 1024 + 1), {
            status: 200,
          })) as typeof fetch,
      ),
    ).rejects.toThrow("exceeds host limit")
  })

  test("default payload fetch rejects a non-HTTPS final response URL", async () => {
    const response = new Response(new Uint8Array([1]), { status: 200 })
    Object.defineProperty(response, "url", { value: "http://example.com/payload" })
    await expect(
      fetchPackagePayload(
        {
          sha256: "a".repeat(64),
          bytes: 1,
          mediaType: "application/json",
          url: "https://example.com/payload",
        },
        (async () => response) as typeof fetch,
      ),
    ).rejects.toThrow("redirected outside HTTPS")
  })

  test("unsafe or duplicate preludes reject the whole candidate snapshot", async () => {
    const { envelope } = await corpus()
    const unsafe = structuredClone(envelope) as unknown as {
      prelude: { packageId: string }
    }
    unsafe.prelude.packageId = "Skill:not-a-package-root"
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
