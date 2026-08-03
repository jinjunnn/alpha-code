import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import {
  claimMcpSecretVersionDir,
  mcpSecretVersionedRef,
  removeMcpServerSecretsStrict,
  writeMcpSecretVersioned,
} from "../main/alpha-mcp-secrets"
import { reloadInstalledMcp } from "../main/ext-mcp-activation"
import {
  decodePackageEnvelopeHeaderV1,
  decodePackageProfilePayloadV1,
  type AlphaPackageEnvelopeV1,
  type PackageProfilePayloadV1,
} from "./host-extension-package-contract/decoder"
import {
  decodePackageSecretPrerequisiteProfileV1,
  evaluatePackageSecretReferenceV1,
  evaluatePackageSecretSubmissionV1,
  packageSecretReferenceV1,
  type PackageSecretPrerequisiteProfileV1,
} from "./package-secret-prerequisite"

const root = mkdtempSync(resolve(tmpdir(), "alpha-package-secret-"))
const encoder = new TextEncoder()
const secretValue = "REQ128_SECRET_DO_NOT_ECHO_7db4"

afterAll(() => rmSync(root, { recursive: true, force: true }))

function jsonBytes(value: unknown) {
  return encoder.encode(`${JSON.stringify(value)}\n`)
}

function decodedPackage(
  profileId: "mcp-local" | "mcp-remote" = "mcp-local",
  requiredSecrets = ["API_TOKEN"],
): {
  envelope: AlphaPackageEnvelopeV1
  payload: PackageProfilePayloadV1
} {
  const payload =
    profileId === "mcp-local"
      ? {
          schema: "alpha.host-extension-package.payload.mcp-local.v1",
          behavior: {
            command: ["demo-mcp"],
            environment: { LOG_LEVEL: "info" },
            requiredSecrets,
          },
        }
      : {
          schema: "alpha.host-extension-package.payload.mcp-remote.v1",
          behavior: {
            url: "https://mcp.example.invalid/service",
            headersTemplate: requiredSecrets.length ? { Authorization: `Bearer {${requiredSecrets[0]}}` } : {},
            requiredSecrets,
            auth: "none",
          },
        }
  const bytes = jsonBytes(payload)
  const capabilities = requiredSecrets.length ? ["alpha.secret-prerequisite.v1"] : []
  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: `${profileId}:demo`, version: "1.0.0" },
    presentation: { displayName: "Demo", description: "Demo MCP" },
    root: `${profileId}:demo`,
    components: [
      {
        id: `${profileId}:demo`,
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
  }
  const header = decodePackageEnvelopeHeaderV1(jsonBytes(envelope))
  if (!header.ok) throw new Error(header.errors.join("; "))
  const rootEntry = header.components.find((entry) => entry.role === "root")
  if (rootEntry?.status !== "supported") throw new Error("root component is not supported")
  const decoded = decodePackageProfilePayloadV1(
    rootEntry.component.profileId,
    bytes,
    rootEntry.component.capabilities,
  )
  if (!decoded.ok) throw new Error(decoded.errors.join("; "))
  return { component: rootEntry.component, payload: decoded.payload }
}

function profileOf(profileId: "mcp-local" | "mcp-remote" = "mcp-local"): PackageSecretPrerequisiteProfileV1 {
  const decoded = decodedPackage(profileId)
  const result = decodePackageSecretPrerequisiteProfileV1(decoded.component, decoded.payload)
  if (!result.ok) throw new Error(result.errors.join("; "))
  return result.profile
}

/**
 * `#809`(REQ-128 Phase 4,基线 §5 第 6 类):一个**经生产 support gate 解码出来的** managed
 * plugin 组件 + payload。夹具不自己造 `PackageSupportedComponentV1` —— 那个类型的**唯一**构造点
 * 是 `decoder.ts` 里 support gate 命中之后的 `narrowComponent`,绕开它就等于绕开了这条链上真正
 * 的咽喉,而本组用例要验的恰恰是「走完整条链之后,plugin 的密钥前置是空的」。
 */
function decodedManagedPlugin(overrides?: { behavior?: Record<string, unknown> }): {
  component: Parameters<typeof decodePackageSecretPrerequisiteProfileV1>[0]
  payload: PackageProfilePayloadV1
  decodeErrors: string[]
} {
  const assetBytes = encoder.encode("export default async () => ({})\n")
  const payload = {
    schema: "alpha.host-extension-package.payload.opencode-plugin.v1",
    behavior: overrides?.behavior ?? {
      asset: {
        sha256: createHash("sha256").update(assetBytes).digest("hex"),
        bytes: assetBytes.byteLength,
        mediaType: "text/javascript",
        url: "https://example.invalid/plugin.js",
      },
    },
  }
  const bytes = jsonBytes(payload)
  const capabilities = ["engine:config", "engine:plugin"]
  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: "plugin:demo", version: "1.0.0" },
    presentation: { displayName: "Demo", description: "Demo managed plugin" },
    root: "plugin:demo",
    components: [
      {
        id: "plugin:demo",
        required: true,
        dependencies: [],
        profileId: "opencode-plugin",
        profileVersion: 1,
        capabilities,
        payloadRef: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
          mediaType: "application/vnd.alpha.host-extension-package.opencode-plugin.v1+json",
          url: "https://example.invalid/payload.json",
        },
      },
    ],
    capabilities,
  }
  const header = decodePackageEnvelopeHeaderV1(jsonBytes(envelope))
  if (!header.ok) throw new Error(header.errors.join("; "))
  const rootEntry = header.components.find((entry) => entry.role === "root")
  if (rootEntry?.status !== "supported") throw new Error("root component is not supported")
  const decoded = decodePackageProfilePayloadV1(
    rootEntry.component.profileId,
    bytes,
    rootEntry.component.capabilities,
  )
  return {
    component: rootEntry.component,
    payload: decoded.ok ? decoded.payload : ({} as PackageProfilePayloadV1),
    decodeErrors: decoded.ok ? [] : decoded.errors,
  }
}

describe("package secret prerequisite", () => {
  /**
   * `#809`(基线 §5 第 6 类不变量 1):`opencode-plugin` 的密钥前置是**显式**的空集,由这一条
   * **具名**用例钉住 —— 不是靠「没写分支所以落进函数末尾那个 else」。区别在于:那个 else 是
   * 一条对**任何**未匹配 schema 都返回空集的兜底,而这条用例说的是「对 plugin 这个 profile,
   * 空集是正确答案」。哪天 plugin 长出密钥语义,红的是这一条。
   */
  test("#809 managed plugin 的密钥前置显式为空集(具名,不是走兜底 else)", () => {
    const { component, payload, decodeErrors } = decodedManagedPlugin()
    expect(decodeErrors).toEqual([])
    const result = decodePackageSecretPrerequisiteProfileV1(component, payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.profile).toEqual({
      profile: "alpha.secret-prerequisite.v1",
      componentId: "plugin:demo",
      server: "demo",
      items: [],
    })
  })

  /**
   * 不变量 2 的 schema 半场:plugin payload **不得**声明任何密钥前置。咽喉是 payload schema 的
   * `additionalProperties:false` —— 放宽它,这条立刻绿,所以这条就是它的守卫。
   */
  test("#809 plugin payload 里塞 requiredSecrets ⇒ 解码期就被拒(schema 不许额外键)", () => {
    const assetBytes = encoder.encode("export default async () => ({})\n")
    const { decodeErrors } = decodedManagedPlugin({
      behavior: {
        asset: {
          sha256: createHash("sha256").update(assetBytes).digest("hex"),
          bytes: assetBytes.byteLength,
          mediaType: "text/javascript",
          url: "https://example.invalid/plugin.js",
        },
        requiredSecrets: ["API_TOKEN"],
      },
    })
    expect(decodeErrors.length).toBeGreaterThan(0)
    expect(decodeErrors.join("; ")).toContain("requiredSecrets")
  })

  test("strictly derives local secret identity and target from the signed host profile", () => {
    expect(profileOf()).toEqual({
      profile: "alpha.secret-prerequisite.v1",
      componentId: "mcp-local:demo",
      server: "demo",
      items: [
        {
          prerequisiteId: "mcp-local:demo#API_TOKEN",
          componentId: "mcp-local:demo",
          label: "API_TOKEN",
          required: true,
          target: { kind: "mcp-environment", variable: "API_TOKEN" },
        },
      ],
    })
  })

  /**
   * The `{VAR}`-must-be-declared rule moved to the decoder (CONTRACT.md invariant 4), so it is
   * asserted there and not restated here. What main still owns is the other direction: a declared
   * secret that no header consumes would be a prompt for a value nothing ever uses.
   */
  test("strictly derives remote header targets and refuses a declared secret with no header target", () => {
    expect(profileOf("mcp-remote").items[0]?.target).toEqual({
      kind: "mcp-remote-headers",
      headers: ["Authorization"],
      variable: "API_TOKEN",
    })
    const decoded = decodedPackage("mcp-remote")
    const payload = structuredClone(decoded.payload)
    if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1") throw new Error("wrong fixture")
    payload.behavior.headersTemplate = { "X-Unrelated": "static" }
    const result = decodePackageSecretPrerequisiteProfileV1(decoded.component, payload)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join("; ")).toContain('"API_TOKEN" has no header target')
  })

  test("renderer cannot add an undeclared secret", () => {
    const result = evaluatePackageSecretSubmissionV1(profileOf(), {
      decision: "submit",
      secrets: [
        {
          prerequisiteId: "mcp-local:demo#OTHER_TOKEN",
          value: secretValue,
        },
      ],
    })
    expect(result).toEqual({
      state: "blocked",
      reasonCode: "secret-undeclared",
      prerequisiteIds: [],
    })
    expect(JSON.stringify(result)).not.toContain(secretValue)
  })

  test("renderer target/id tampering is rejected and main keeps the signed target", () => {
    const profile = profileOf()
    const result = evaluatePackageSecretSubmissionV1(profile, {
      decision: "submit",
      secrets: [
        {
          prerequisiteId: profile.items[0]!.prerequisiteId,
          value: secretValue,
          target: { kind: "mcp-environment", variable: "ATTACKER_TARGET" },
        },
      ],
    })
    expect(result.reasonCode).toBe("secret-undeclared")
    expect(profile.items[0]!.target).toEqual({
      kind: "mcp-environment",
      variable: "API_TOKEN",
    })
  })

  test("cancel fails closed without a reference or value echo", () => {
    const result = evaluatePackageSecretSubmissionV1(profileOf(), {
      decision: "cancel",
    })
    expect(result).toEqual({
      state: "blocked",
      reasonCode: "secret-cancelled",
      prerequisiteIds: [],
    })
    expect(JSON.stringify(result)).not.toContain(secretValue)
  })

  test("missing and empty values require action", () => {
    const profile = profileOf()
    for (const secrets of [[], [{ prerequisiteId: profile.items[0]!.prerequisiteId, value: "" }]]) {
      const result = evaluatePackageSecretSubmissionV1(profile, {
        decision: "submit",
        secrets,
      })
      expect(result.state).toBe("required-action")
      expect(result.reasonCode).toBe("secret-value-required")
    }
  })

  test("ready submission result carries IDs and status only", () => {
    const profile = profileOf()
    const result = evaluatePackageSecretSubmissionV1(profile, {
      decision: "submit",
      secrets: [
        {
          prerequisiteId: profile.items[0]!.prerequisiteId,
          value: secretValue,
        },
      ],
    })
    expect(result).toEqual({
      state: "ready",
      reasonCode: "secret-ready",
      prerequisiteIds: ["mcp-local:demo#API_TOKEN"],
    })
    expect(JSON.stringify(result)).not.toContain(secretValue)
  })

  test("reference uses the existing append-only store identity and contains no value digest", () => {
    const profile = profileOf()
    const reference = packageSecretReferenceV1(profile, profile.items[0]!.prerequisiteId, "v-0123456789abcdef")
    expect(reference).toEqual({
      schema: "alpha.package-secret-reference.v1",
      prerequisiteId: "mcp-local:demo#API_TOKEN",
      componentId: "mcp-local:demo",
      store: "alpha-mcp-secrets",
      server: "demo",
      version: "v-0123456789abcdef",
      variable: "API_TOKEN",
    })
    expect(JSON.stringify(reference)).not.toContain(secretValue)
    expect(JSON.stringify(reference)).not.toContain("digest")
  })

  test("missing reference and missing file both fail closed", () => {
    const profile = profileOf()
    const id = profile.items[0]!.prerequisiteId
    expect(evaluatePackageSecretReferenceV1(profile, id, undefined, undefined, false).reasonCode).toBe(
      "secret-reference-missing",
    )
    const reference = packageSecretReferenceV1(profile, id, "v-1111111111111111")!
    expect(
      evaluatePackageSecretReferenceV1(profile, id, { status: "ready", reference }, reference.version, false)
        .reasonCode,
    ).toBe("secret-reference-missing")
  })

  test("stale reference fails closed after replacement", () => {
    const profile = profileOf()
    const id = profile.items[0]!.prerequisiteId
    const reference = packageSecretReferenceV1(profile, id, "v-2222222222222222")!
    expect(
      evaluatePackageSecretReferenceV1(profile, id, { status: "ready", reference }, "v-3333333333333333", true)
        .reasonCode,
    ).toBe("secret-reference-stale")
    expect(
      evaluatePackageSecretReferenceV1(profile, id, { status: "replaced", reference }, reference.version, true)
        .reasonCode,
    ).toBe("secret-reference-replaced")
  })

  test("uninstall status fails closed even if an old file remains", () => {
    const profile = profileOf()
    const id = profile.items[0]!.prerequisiteId
    const reference = packageSecretReferenceV1(profile, id, "v-4444444444444444")!
    expect(
      evaluatePackageSecretReferenceV1(profile, id, { status: "uninstalled" }, reference.version, true).reasonCode,
    ).toBe("secret-reference-uninstalled")
  })

  test("existing store supports ready, replacement, and strict uninstall without plaintext records", () => {
    const userData = resolve(root, "store")
    const profile = profileOf()
    const id = profile.items[0]!.prerequisiteId
    const oldVersion = "v-5555555555555555"
    const nextVersion = "v-6666666666666666"
    expect(claimMcpSecretVersionDir(userData, profile.server, oldVersion).ok).toBe(true)
    expect(writeMcpSecretVersioned(userData, profile.server, oldVersion, "API_TOKEN", secretValue).ok).toBe(true)
    expect(claimMcpSecretVersionDir(userData, profile.server, nextVersion).ok).toBe(true)
    expect(writeMcpSecretVersioned(userData, profile.server, nextVersion, "API_TOKEN", `${secretValue}-next`).ok).toBe(
      true,
    )

    const current = packageSecretReferenceV1(profile, id, nextVersion)!
    expect(
      evaluatePackageSecretReferenceV1(profile, id, { status: "ready", reference: current }, nextVersion, true).state,
    ).toBe("ready")
    const fileRef = mcpSecretVersionedRef(userData, profile.server, nextVersion, "API_TOKEN")
    expect(fileRef).not.toContain(secretValue)
    expect(removeMcpServerSecretsStrict(userData, profile.server, () => false).ok).toBe(true)
    expect(existsSync(resolve(userData, "alpha-mcp-secrets", profile.server, nextVersion, "API_TOKEN"))).toBe(false)
  })

  test.each([
    ["connected", "connected"],
    ["disabled", "disabled"],
    ["failed", "failed"],
    ["error", "reload-pending"],
  ] as const)(
    "main reload maps engine status %s to %s and returns status only",
    async (engineStatus, expectedStatus) => {
      const requests: Array<{ path: string; method: string; authorization: string | null }> = []
      const fetchImpl = (async (request: RequestInfo | URL, init?: RequestInit) => {
        const normalized = new Request(request, init)
        const url = new URL(normalized.url)
        requests.push({
          path: url.pathname,
          method: normalized.method,
          authorization: normalized.headers.get("authorization"),
        })
        if (url.pathname === "/global/dispose") return Response.json(true)
        if (url.pathname === "/mcp")
          return engineStatus === "error"
            ? Response.json({ message: "cold start failed" }, { status: 500 })
            : Response.json({ demo: { status: engineStatus } })
        return new Response("not found", { status: 404 })
      }) as typeof fetch
      const result = await reloadInstalledMcp(
        "demo",
        async () => ({
          url: "http://127.0.0.1:39117",
          username: "opencode",
          password: "route-password",
        }),
        fetchImpl,
      )
      expect(result).toEqual({ reference: "demo", status: expectedStatus })
      expect(JSON.stringify(result)).not.toContain(secretValue)
      expect(requests.map(({ path, method }) => ({ path, method }))).toEqual([
        { path: "/global/dispose", method: "POST" },
        { path: "/mcp", method: "GET" },
      ])
      expect(
        requests.every(
          (request) => request.authorization === `Basic ${Buffer.from("opencode:route-password").toString("base64")}`,
        ),
      ).toBe(true)
    },
  )

  test("awaitServer, dispose, and status timeouts all return reload-pending", async () => {
    const never = () => new Promise<never>(() => {})
    const ready = async () => ({
      url: "http://127.0.0.1:39117",
      username: "opencode",
      password: "route-password",
    })
    const timeouts = { awaitServer: 5, dispose: 5, status: 5 }
    const cases = [
      {
        awaitServer: never,
        fetchImpl: (async () => Response.json(true)) as typeof fetch,
      },
      {
        awaitServer: ready,
        fetchImpl: (async () => never()) as typeof fetch,
      },
      {
        awaitServer: ready,
        fetchImpl: (async (request: RequestInfo | URL, init?: RequestInit) =>
          new URL(new Request(request, init).url).pathname === "/global/dispose"
            ? Response.json(true)
            : never()) as typeof fetch,
      },
    ]
    for (const item of cases)
      expect(await reloadInstalledMcp("demo", item.awaitServer, item.fetchImpl, timeouts)).toEqual({
        reference: "demo",
        status: "reload-pending",
      })
  })

  test("preload/result, renderer state, planner, log, manifest, and receipt have no truth echo seam", async () => {
    const paths = [
      resolve(import.meta.dir, "../preload/types.ts"),
      resolve(import.meta.dir, "../renderer/extensions/use-extensions.ts"),
      resolve(import.meta.dir, "../main/ext-install-planner.ts"),
      resolve(import.meta.dir, "../main/ext-mcp-activation.ts"),
      resolve(import.meta.dir, "../main/ext-ipc.ts"),
      resolve(import.meta.dir, "../main/ext-manifest-v2.ts"),
      resolve(import.meta.dir, "../main/ext-receipt-v2.ts"),
      resolve(import.meta.dir, "../main/logging.ts"),
    ]
    const sources = (await Promise.all(paths.map((path) => Bun.file(path).text()))).join("\n")
    expect(sources).not.toContain(secretValue)
    expect(sources).not.toContain("live" + "Mcp")
    expect(
      sources.includes("mcpActivation") &&
        sources.includes('status: "connected" | "disabled" | "failed" | "reload-pending"'),
    ).toBe(true)
  })
})
