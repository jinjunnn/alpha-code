import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, expect, test } from "bun:test"
import type {
  AlphaPackageEnvelopeV1,
  PackageProfilePayloadV1,
} from "../src/shared/host-extension-package-contract/decoder"
import { sha256Hex, type ChannelClientDeps } from "../src/main/catalog-channels"
import { createPackageAdmissionCoordinator } from "../src/main/package-admission"
import { refreshRemoteCatalog } from "../src/main/remote-catalog"

const now = Date.parse("2026-07-31T12:00:00.000Z")
const baseUrl = "https://signed-package.test/catalog/v1"
const tmp = mkdtempSync(join(tmpdir(), "package-admission-signed-"))
const catalogState = join(tmp, "catalog-state")
const root = join(tmp, "root")
const userData = join(tmp, "user-data")
const previousRoot = process.env.ALPHA_GLOBAL_DIR
const secretCanary = "REQ128_SIGNED_ENVELOPE_SECRET_9fd15c"

mkdirSync(root, { recursive: true })
process.env.ALPHA_GLOBAL_DIR = root

afterAll(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

type SigningKey = {
  keyId: string
  publicKeyB64: string
  privateKey: KeyObject
}

function signingKey(): SigningKey {
  const pair = generateKeyPairSync("ed25519")
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer
  return {
    keyId: createHash("sha256").update(publicKey).digest("hex"),
    publicKeyB64: publicKey.toString("base64"),
    privateKey: pair.privateKey,
  }
}

function signature(body: string, key: SigningKey) {
  return sign(null, Buffer.from(body, "utf8"), key.privateKey).toString("base64")
}

function fetchFrom(routes: Record<string, string>) {
  return (async (input: string | URL | Request) => {
    const body = routes[String(input)]
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 })
  }) as typeof fetch
}

test("verified signed snapshot and Envelope secret prerequisite reach the restricted version directory", async () => {
  const payload = {
    schema: "alpha.host-extension-package.payload.mcp-remote.v1",
    behavior: {
      url: "https://mcp.example.com/",
      headersTemplate: { Authorization: "Bearer {A_KEY}" },
      requiredSecrets: ["A_KEY"],
      auth: "none",
    },
  } as unknown as PackageProfilePayloadV1
  const payloadBytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
  // 宿主自持的 v2 信封,沿用 producer 语料的身份。vendored producer 产物本身没有 `root`,
  // 在 v2 合同下应当被拒 —— 那道过渡闸在 package-installability{,.wiring}.test.ts,不在这里重述。
  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: "package:generic-remote-mcp", version: "1.0.0" },
    presentation: {
      displayName: "Generic Remote MCP",
      description: "Generic Phase 1 compiler corpus input.",
    },
    root: "mcp:generic-remote",
    components: [
      {
        id: "mcp:generic-remote",
        required: true,
        dependencies: [],
        profileId: "mcp-remote",
        profileVersion: 1,
        capabilities: ["alpha.secret-prerequisite.v1"],
        payloadRef: {
          sha256: createHash("sha256").update(payloadBytes).digest("hex"),
          bytes: payloadBytes.byteLength,
          mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
          url: "https://alphacodeone.com/catalog/assets/mcp.generic-remote/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: ["alpha.secret-prerequisite.v1"],
  } as unknown as AlphaPackageEnvelopeV1

  const key = signingKey()
  const catalogBody = JSON.stringify({
    version: "2026-07-31.1",
    entries: [{}],
    packages: [envelope],
  })
  const trustBody = JSON.stringify({
    schema: "alpha.catalog.trust.v1",
    sequence: 1,
    publishedAt: "2026-07-31T00:00:00.000Z",
    expires: "2026-12-31T00:00:00.000Z",
    keyId: key.keyId,
    keys: [
      {
        keyId: key.keyId,
        publicKey: key.publicKeyB64,
        status: "active",
        notBefore: "2026-01-01T00:00:00.000Z",
      },
    ],
    revokedTargets: [],
  })
  const channelBody = JSON.stringify({
    schema: "alpha.catalog.channel-metadata.v1",
    channel: "dev",
    sequence: 1,
    publishedAt: "2026-07-31T00:00:00.000Z",
    expires: "2026-08-31T00:00:00.000Z",
    keyId: key.keyId,
    target: {
      catalogVersion: "2026-07-31.1",
      sha256: sha256Hex(catalogBody),
      bytes: Buffer.byteLength(catalogBody),
      url: `${baseUrl}/releases/2026-07-31.1/catalog.json`,
      sigUrl: `${baseUrl}/releases/2026-07-31.1/catalog.json.sig`,
    },
  })
  const advisoriesBody = JSON.stringify({
    schema: "alpha.catalog.advisories.v1",
    sequence: 1,
    publishedAt: "2026-07-31T00:00:00.000Z",
    expires: "2026-12-31T00:00:00.000Z",
    keyId: key.keyId,
    records: [],
  })
  const snapshotBody = JSON.stringify({
    schema: "alpha.catalog.snapshot.v1",
    sequence: 1,
    publishedAt: "2026-07-31T00:00:00.000Z",
    expires: "2026-08-31T00:00:00.000Z",
    keyId: key.keyId,
    entries: {
      trust: { sequence: 1, sha256: sha256Hex(trustBody) },
      dev: { sequence: 1, sha256: sha256Hex(channelBody) },
      advisories: { sequence: 1, sha256: sha256Hex(advisoriesBody) },
    },
  })
  const routes = {
    [`${baseUrl}/channels/trust.json`]: trustBody,
    [`${baseUrl}/channels/trust.json.sig`]: signature(trustBody, key),
    [`${baseUrl}/channels/snapshot.json`]: snapshotBody,
    [`${baseUrl}/channels/snapshot.json.sig`]: signature(snapshotBody, key),
    [`${baseUrl}/channels/advisories.json`]: advisoriesBody,
    [`${baseUrl}/channels/advisories.json.sig`]: signature(advisoriesBody, key),
    [`${baseUrl}/channels/dev.json`]: channelBody,
    [`${baseUrl}/channels/dev.json.sig`]: signature(channelBody, key),
    [`${baseUrl}/releases/2026-07-31.1/catalog.json`]: catalogBody,
    [`${baseUrl}/releases/2026-07-31.1/catalog.json.sig`]: signature(catalogBody, key),
  }
  const channelDeps: ChannelClientDeps = {
    fetchImpl: fetchFrom(routes),
    now: () => now,
    baseUrl,
    builtinKeyB64: key.publicKeyB64,
  }
  const loadVerifiedCatalog = () =>
    refreshRemoteCatalog(catalogState, "dev", {
      ...channelDeps,
      packageInstallability: { fetchPayload: async () => payloadBytes },
    })
  const verified = await loadVerifiedCatalog()
  expect(verified).toMatchObject({
    source: "remote",
    snapshotDigest: sha256Hex(snapshotBody),
  })
  if (verified.source === "none") throw new Error(verified.error)
  expect(verified.packageViews?.[0]).toMatchObject({
    catalogId: envelope.prelude.packageId,
    verdict: "compatible",
  })

  const admit = createPackageAdmissionCoordinator({
    loadVerifiedCatalog,
    root: () => root,
    userDataPath: userData,
    environment: () => "dev",
    installability: { fetchPayload: async () => payloadBytes },
    secretVersionId: () => "v-a1b2c3d4",
    now: () => new Date(now),
  })
  const intent = {
    catalogId: envelope.prelude.packageId,
    scope: { scope: "global" as const },
    attemptId: "signed-envelope-attempt",
  }
  const preview = await admit(intent)
  expect(preview).toMatchObject({ ok: false, stage: "authorize" })
  if (preview.ok || preview.stage !== "authorize")
    throw new Error(`expected authorization preview: ${JSON.stringify(preview)}`)
  expect(preview.packageAuthorization.binding.snapshotDigest).toBe(sha256Hex(snapshotBody))
  expect(preview.packageAuthorization.plan.items[0]).toMatchObject({
    componentId: "mcp:generic-remote",
    operations: ["write-secret-version", "update-config", "write-install-record", "write-capability-grant"],
  })
  expect(JSON.stringify(preview.packageAuthorization.plan)).not.toContain(secretCanary)
  expect(preview.authorization).toEqual([
    {
      key: "mcp--generic-remote",
      requested: ["alpha.secret-prerequisite.v1"],
      previous: null,
      added: ["alpha.secret-prerequisite.v1"],
      removed: [],
      requiresConfirmation: true,
    },
  ])
  expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)

  const result = await admit({
    ...intent,
    grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
    authorization: {
      confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
      binding: preview.packageAuthorization.binding,
    },
  })
  expect(result).toMatchObject({
    ok: true,
    kind: "mcp",
    name: "generic-remote",
    installedDisabled: true,
  })
  expect(JSON.stringify(result)).not.toContain(secretCanary)

  const secretFile = join(userData, "alpha-mcp-secrets", "generic-remote", "v-a1b2c3d4", "A_KEY")
  expect(readdirSync(join(userData, "alpha-mcp-secrets", "generic-remote"))).toEqual(["v-a1b2c3d4"])
  expect(readFileSync(secretFile, "utf8")).toBe(secretCanary)
  expect(statSync(secretFile).mode & 0o777).toBe(0o600)
  const config = readFileSync(join(root, "alpha.jsonc"), "utf8")
  expect(config).toContain(`{file:${secretFile}}`)
  expect(config).not.toContain(secretCanary)
  expect(existsSync(join(root, "installs.json"))).toBe(true)
  const grants = join(root, "ext-store", "mcp--generic-remote", "grants.json")
  expect(existsSync(grants)).toBe(true)
  expect(readFileSync(join(root, "installs.json"), "utf8")).not.toContain(secretCanary)
  expect(readFileSync(grants, "utf8")).not.toContain(secretCanary)
  const journals = readdirSync(join(root, "ext-tx", "journal"))
  expect(journals).toHaveLength(1)
  expect(readFileSync(join(root, "ext-tx", "journal", journals[0]!), "utf8")).not.toContain(
    secretCanary,
  )
})
