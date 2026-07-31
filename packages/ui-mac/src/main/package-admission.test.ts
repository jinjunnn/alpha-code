import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AlphaPackageEnvelopeV1, PackageProfilePayloadV1 } from "../shared/host-extension-package-contract/decoder"
import type { PackageAdmissionBindingV1 } from "../shared/package-admission"
import { createPackageAdmissionCoordinator } from "./package-admission"
import { runExtensionTransaction } from "./ext-transaction"

const artifact = resolve(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-web-extension-package/expected.mcp-remote.compiled.json",
)
const snapshotDigest = "7".repeat(64)
const secretCanary = "REQ128_ADMISSION_SECRET_8d38a2"
let tmp = ""
let root = ""
let userData = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "package-admission-"))
  root = join(tmp, "root")
  userData = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * A host-owned v2 package reusing the producer corpus's identity. The vendored producer artifact
 * itself carries no `root` and is refused under the v2 contract until P2-B′ re-vendors it; that
 * transition is gated in package-installability{,.wiring}.test.ts, not restated here.
 */
async function fixture() {
  const payload = {
    schema: "alpha.host-extension-package.payload.mcp-remote.v1",
    behavior: {
      url: "https://mcp.example.com/",
      headersTemplate: { Authorization: "Bearer {A_KEY}" },
      requiredSecrets: ["A_KEY"],
      auth: "none",
    },
  } as unknown as PackageProfilePayloadV1
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
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
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
          mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
          url: "https://alphacodeone.com/catalog/assets/mcp.generic-remote/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: ["alpha.secret-prerequisite.v1"],
  } as unknown as AlphaPackageEnvelopeV1
  return { envelope, bytes }
}

function confirmation(preview: {
  authorization: Array<{ key: string; requested: string[] }>
  packageAuthorization: { binding: PackageAdmissionBindingV1 }
}) {
  return {
    confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
    binding: preview.packageAuthorization.binding,
  }
}

describe("package admission", () => {
  test.each([
    [
      "top-level keys such as decidedAt",
      (intent: Record<string, unknown>) => ({ ...intent, decidedAt: "2026-07-31T12:00:00.000Z" }),
      "renderer-supplied key",
    ],
    [
      "attemptId with a leading space",
      (intent: Record<string, unknown>) => ({ ...intent, attemptId: " attempt-invalid" }),
      "invalid attemptId",
    ],
    [
      "grants with an extra key",
      (intent: Record<string, unknown>) => ({
        ...intent,
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary }, extra: true },
      }),
      "invalid grants",
    ],
    [
      "global scope with an extra projectDir",
      (intent: Record<string, unknown>) => ({
        ...intent,
        scope: { scope: "global", projectDir: "/tmp/not-global" },
      }),
      "invalid scope",
    ],
    [
      "uppercase catalogId",
      (intent: Record<string, unknown>) => ({ ...intent, catalogId: "package:Generic-remote-mcp" }),
      "tampered or is stale",
    ],
    [
      "non-hex authorization binding",
      (intent: Record<string, unknown>) => {
        const changed = structuredClone(intent)
        ;(
          changed.authorization as {
            binding: { snapshotDigest: string }
          }
        ).binding.snapshotDigest = "g".repeat(64)
        return changed
      },
      "invalid authorization binding",
    ],
  ])("coordinator rejects %s before the transaction", async (_name, mutate, reason) => {
    const { envelope, bytes } = await fixture()
    let transactionCalls = 0
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => bytes },
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const intent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: `attempt-decode-${_name.replaceAll(" ", "-")}`,
    }
    const preview = await admit(intent)
    if (preview.ok || preview.stage !== "authorize") throw new Error("expected package authorization preview")

    const result = await admit(
      mutate({
        ...intent,
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
        authorization: confirmation(preview),
      }),
    )

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(reason) })
    expect(transactionCalls).toBe(0)
  })

  // 长度界消费契约的值(decoder 对 packageId 的 max 是 160)。它必须在**第一趟**就拒 ——
  // attempt 正是在第一趟被放进有界的 attempts Map 的,那里才是被攻陷 renderer 的着力点。
  test("coordinator refuses a catalogId beyond the contract bound on the first round", async () => {
    const { envelope, bytes } = await fixture()
    let transactionCalls = 0
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => bytes },
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const result = await admit({
      catalogId: `package:${"a".repeat(200)}`,
      scope: { scope: "global" as const },
      attemptId: "attempt-catalogid-bound",
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("invalid catalogId") })
    expect(transactionCalls).toBe(0)
  })

  test("coordinator correlates a non-package namespace through decoded catalog identity", async () => {
    const { envelope, bytes } = await fixture()
    envelope.prelude.packageId = "skill:contract-package"
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => bytes },
    })

    const preview = await admit({
      catalogId: "skill:contract-package",
      scope: { scope: "global" },
      attemptId: "attempt-contract-package",
    })
    expect(preview).toMatchObject({
      ok: false,
      stage: "authorize",
      packageAuthorization: { plan: { packageId: "skill:contract-package" } },
    })
  })

  test("actual transaction writes the signed secret prerequisite into the restricted version directory", async () => {
    const { envelope, bytes } = await fixture()
    let transactionCalls = 0
    let payloadFetches = 0
    const order: string[] = []
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: {
        fetchPayload: async () => {
          payloadFetches++
          order.push(payloadFetches === 1 ? "preview" : "revalidate")
          expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)
          return bytes
        },
      },
      secretVersionId: () => "v-12345678",
      transaction: async (...args) => {
        transactionCalls++
        order.push("transaction")
        return runExtensionTransaction(args[0], args[1], {
          ...args[2],
          populatePrepared: async () => {
            order.push("populate-prepared")
            await args[2].populatePrepared?.()
          },
          probePrepared: async () => {
            order.push("probe-prepared")
            return (
              (await args[2].probePrepared?.()) ?? {
                healthy: false,
                reason: "package test expected a prepared probe",
              }
            )
          },
          commitReceipt: (records) => {
            order.push("commit-receipt")
            return args[2].commitReceipt?.(records)
          },
        })
      },
    })
    const intent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-e2e",
    }
    expect(
      await admit({
        ...intent,
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("only after the authorization preview"),
    })
    expect(transactionCalls).toBe(0)
    expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)

    const first = await admit(intent)
    expect(first).toMatchObject({ ok: false, stage: "authorize" })
    if (first.ok || first.stage !== "authorize") throw new Error("expected package authorization preview")
    expect(transactionCalls).toBe(0)
    expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)

    const second = await admit({
      ...intent,
      grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
      authorization: confirmation(first),
    })
    expect(second).toMatchObject({
      ok: true,
      kind: "mcp",
      name: "generic-remote",
      installedDisabled: true,
    })
    expect(transactionCalls).toBe(1)
    const secretFile = join(userData, "alpha-mcp-secrets", "generic-remote", "v-12345678", "A_KEY")
    expect(readFileSync(secretFile, "utf8")).toBe(secretCanary)
    expect(statSync(secretFile).mode & 0o777).toBe(0o600)
    const config = readFileSync(join(root, "alpha.jsonc"), "utf8")
    expect(config).toContain(`{file:${secretFile}}`)
    expect(config).not.toContain(secretCanary)
    expect(existsSync(join(root, "installs.json"))).toBe(true)
    expect(existsSync(join(root, "ext-store", "mcp--generic-remote", "grants.json"))).toBe(true)
    expect(order).toEqual([
      "preview",
      "revalidate",
      "transaction",
      "populate-prepared",
      "probe-prepared",
      "commit-receipt",
    ])
  })

  test("cancel, binding tamper, stale revalidation, and replay have zero transaction or secret side effects", async () => {
    const { envelope, bytes } = await fixture()
    const changedEnvelope = structuredClone(envelope)
    const changedPayload = JSON.parse(new TextDecoder().decode(bytes)) as PackageProfilePayloadV1
    if (changedPayload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
      throw new Error("producer corpus profile drifted")
    changedPayload.behavior.url = `${changedPayload.behavior.url}?revision=2`
    const changedBytes = new TextEncoder().encode(`${JSON.stringify(changedPayload, null, 2)}\n`)
    changedEnvelope.components[0].payloadRef.bytes = changedBytes.byteLength
    changedEnvelope.components[0].payloadRef.sha256 = createHash("sha256").update(changedBytes).digest("hex")
    let loads = 0
    let transactionCalls = 0
    let changingPackage = false
    let activeBytes = bytes
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => {
        const changed = changingPackage && ++loads % 2 === 0
        activeBytes = changed ? changedBytes : bytes
        return {
          source: "remote",
          catalog: {
            version: "1",
            entries: [{}],
            packages: [changed ? changedEnvelope : envelope],
          },
          snapshotDigest,
        }
      },
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => activeBytes },
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const preview = async (attemptId: string) => {
      const result = await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId,
      })
      if (result.ok || result.stage !== "authorize") throw new Error(`expected preview: ${JSON.stringify(result)}`)
      return result
    }

    const cancelled = await preview("attempt-cancel")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-cancel",
        authorization: confirmation(cancelled),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("secret-cancelled") })

    const undeclared = await preview("attempt-secret-undeclared")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-secret-undeclared",
        grants: {
          secrets: {
            "mcp:generic-remote#A_KEY": secretCanary,
            "mcp:generic-remote#B_KEY": "not-signed",
          },
        },
        authorization: confirmation(undeclared),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("secret-undeclared") })

    const capabilityTamper = await preview("attempt-capability-tamper")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-capability-tamper",
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
        authorization: {
          ...confirmation(capabilityTamper),
          confirmed: { "mcp--generic-remote": [] },
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("does not exactly match") })

    for (const field of ["snapshotDigest", "envelopeDigest", "itemDigests", "capabilityDigest"] as const) {
      const attemptId = `attempt-tamper-${field}`
      const first = await preview(attemptId)
      const binding = structuredClone(first.packageAuthorization.binding)
      if (field === "itemDigests") binding.itemDigests[envelope.components[0].id] = "9".repeat(64)
      else binding[field] = "9".repeat(64)
      expect(
        await admit({
          catalogId: envelope.prelude.packageId,
          scope: { scope: "global" },
          attemptId,
          grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
          authorization: { ...confirmation(first), binding },
        }),
      ).toMatchObject({ ok: false, reason: expect.stringContaining("tampered") })
    }

    changingPackage = true
    loads = 0
    const stale = await preview("attempt-stale")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-stale",
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
        authorization: confirmation(stale),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("facts changed") })
    expect(loads).toBe(2)
    expect(changedEnvelope.components[0].capabilities).toEqual(envelope.components[0].capabilities)
    expect(changedEnvelope.components[0].payloadRef.sha256).not.toBe(envelope.components[0].payloadRef.sha256)

    changingPackage = false
    const replay = await preview("attempt-replay")
    const authorized = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" },
      attemptId: "attempt-replay",
      grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
      authorization: confirmation(replay),
    }
    expect((await admit(authorized)).ok).toBe(true)
    expect(await admit(authorized)).toMatchObject({ ok: false, reason: expect.stringContaining("replayed") })
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-replay",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("replayed") })
    expect(transactionCalls).toBe(1)
    expect(
      readdirSync(join(userData, "alpha-mcp-secrets", "generic-remote")).filter((name) => name.startsWith("v-")),
    ).toHaveLength(1)
  })

  test("prepared secret failures abort and remove every unreferenced version", async () => {
    const { envelope, bytes } = await fixture()
    const secretRoot = join(userData, "alpha-mcp-secrets", "generic-remote")
    const dependencies = {
      loadVerifiedCatalog: async () => ({
        source: "remote" as const,
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev" as const,
      installability: { fetchPayload: async () => bytes },
    }

    const populateFailure = createPackageAdmissionCoordinator({
      ...dependencies,
      secretVersionId: () => "v-deadbeef",
      transaction: (...args) =>
        runExtensionTransaction(args[0], args[1], {
          ...args[2],
          populatePrepared: async () => {
            await args[2].populatePrepared?.()
            throw new Error("injected prepared secret write failure")
          },
        }),
    })
    const populateIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-populate-failure",
    }
    const populatePreview = await populateFailure(populateIntent)
    if (populatePreview.ok || populatePreview.stage !== "authorize")
      throw new Error("expected package authorization preview")
    expect(
      await populateFailure({
        ...populateIntent,
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
        authorization: confirmation(populatePreview),
      }),
    ).toMatchObject({ ok: false })
    expect(readdirSync(secretRoot)).toEqual([])

    const unhealthyProbe = createPackageAdmissionCoordinator({
      ...dependencies,
      secretVersionId: () => "v-cafebabe",
      transaction: (...args) =>
        runExtensionTransaction(args[0], args[1], {
          ...args[2],
          probePrepared: () => ({ healthy: false, reason: "injected unhealthy prepared secret" }),
        }),
    })
    const probeIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-unhealthy-probe",
    }
    const probePreview = await unhealthyProbe(probeIntent)
    if (probePreview.ok || probePreview.stage !== "authorize") throw new Error("expected package authorization preview")
    expect(
      await unhealthyProbe({
        ...probeIntent,
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
        authorization: confirmation(probePreview),
      }),
    ).toMatchObject({ ok: false })
    expect(readdirSync(secretRoot)).toEqual([])
  })

  test("preexisting and lock-raced handwritten MCP config is never adopted or overwritten", async () => {
    const { envelope, bytes } = await fixture()
    const configPath = join(root, "alpha.jsonc")
    const handwritten =
      '{\n  // user-owned MCP leaf\n  "mcp": {\n    "generic-remote": { "type": "remote", "url": "https://user.example/mcp" }\n  }\n}\n'
    const dependencies = {
      loadVerifiedCatalog: async () => ({
        source: "remote" as const,
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev" as const,
      installability: { fetchPayload: async () => bytes },
    }

    writeFileSync(configPath, handwritten)
    let transactionCalls = 0
    const preexisting = createPackageAdmissionCoordinator({
      ...dependencies,
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const preexistingIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-preexisting-mcp",
    }
    const preexistingPreview = await preexisting(preexistingIntent)
    if (preexistingPreview.ok || preexistingPreview.stage !== "authorize")
      throw new Error("expected package authorization preview")
    expect(
      await preexisting({
        ...preexistingIntent,
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
        authorization: confirmation(preexistingPreview),
      }),
    ).toMatchObject({ ok: false })
    expect(transactionCalls).toBe(0)
    expect(readFileSync(configPath, "utf8")).toBe(handwritten)

    writeFileSync(configPath, "{}\n")
    const raced = createPackageAdmissionCoordinator({
      ...dependencies,
      secretVersionId: () => "v-feedface",
      transaction: async (...args) => {
        transactionCalls++
        writeFileSync(configPath, handwritten)
        return runExtensionTransaction(...args)
      },
    })
    const racedIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-raced-mcp",
    }
    const racedPreview = await raced(racedIntent)
    if (racedPreview.ok || racedPreview.stage !== "authorize") throw new Error("expected package authorization preview")
    expect(
      await raced({
        ...racedIntent,
        grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
        authorization: confirmation(racedPreview),
      }),
    ).toMatchObject({ ok: false })
    expect(transactionCalls).toBe(1)
    expect(readFileSync(configPath, "utf8")).toBe(handwritten)
  })
})
