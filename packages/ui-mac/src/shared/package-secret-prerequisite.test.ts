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
  const decoded = decodePackageProfilePayloadV1(
    header.envelope.components[0].profileId,
    bytes,
    header.envelope.capabilities,
  )
  if (!decoded.ok) throw new Error(decoded.errors.join("; "))
  return { envelope: header.envelope, payload: decoded.payload }
}

function profileOf(profileId: "mcp-local" | "mcp-remote" = "mcp-local"): PackageSecretPrerequisiteProfileV1 {
  const decoded = decodedPackage(profileId)
  const result = decodePackageSecretPrerequisiteProfileV1(decoded.envelope, decoded.payload)
  if (!result.ok) throw new Error(result.errors.join("; "))
  return result.profile
}

describe("package secret prerequisite", () => {
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

  test("strictly derives remote header targets and rejects undeclared placeholders", () => {
    expect(profileOf("mcp-remote").items[0]?.target).toEqual({
      kind: "mcp-remote-headers",
      headers: ["Authorization"],
      variable: "API_TOKEN",
    })
    const decoded = decodedPackage("mcp-remote")
    const payload = structuredClone(decoded.payload)
    if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1") throw new Error("wrong fixture")
    payload.behavior.headersTemplate.Authorization = "Bearer {OTHER_TOKEN}"
    const result = decodePackageSecretPrerequisiteProfileV1(decoded.envelope, payload)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join("; ")).toContain('undeclared secret placeholder "OTHER_TOKEN"')
    payload.behavior.headersTemplate.Authorization = "Bearer {lowercase}"
    const invalidPlaceholder = decodePackageSecretPrerequisiteProfileV1(decoded.envelope, payload)
    expect(invalidPlaceholder.ok).toBe(false)
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
