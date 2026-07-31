import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
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

async function fixture() {
  const compiled = (await Bun.file(artifact).json()) as {
    envelope: AlphaPackageEnvelopeV1
    payload: PackageProfilePayloadV1
  }
  const envelope = structuredClone(compiled.envelope)
  const payload = structuredClone(compiled.payload)
  if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
    throw new Error("producer corpus profile drifted")
  payload.behavior.requiredSecrets = ["A_KEY"]
  payload.behavior.headersTemplate = { Authorization: "Bearer {A_KEY}" }
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
  envelope.components[0].payloadRef.bytes = bytes.byteLength
  envelope.components[0].payloadRef.sha256 = createHash("sha256").update(bytes).digest("hex")
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
})
