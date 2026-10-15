// E1: real preview bytes -> production admission/transaction -> disk receipt/grant.
// No network, signing or catalog publication. CLI inputs come from alpha-web's preview.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createPackageAdmissionCoordinator } from "../../../../packages/ui-mac/src/main/package-admission"
import { evaluatePackageForHost, runCatalogInstallWithPackagePreflight } from "../../../../packages/ui-mac/src/main/package-installability"
import { findRecordV2, readPackageGraphs } from "../../../../packages/ui-mac/src/main/ext-receipt-v2"
import { readCapabilityGrant } from "../../../../packages/ui-mac/src/main/ext-capability-grants"
import type { AlphaPackageEnvelopeV1, CloudPayloadV1 } from "../../../../packages/ui-mac/src/shared/host-extension-package-contract/decoder"

export const directory = resolve(import.meta.dir, "../results")
export const sha256 = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
export const save = (name: string, value: unknown) => Bun.write(join(directory, name), JSON.stringify(value, null, 2) + "\n")

export async function prepare(webRoot: string) {
  const hostRoot = resolve(import.meta.dir, "../../../..")
  assert.equal((await Bun.file(join(hostRoot, "packages/ui-mac/package.json")).json()).version, "0.1.20")
  const { canonicalJsonBytes } = await import(pathToFileURL(join(webRoot, "scripts/lib/catalog-intake-core.mjs")).href)
  const { catalogRuntimeDigest } = await import(pathToFileURL(join(webRoot, "scripts/lib/curation-gate.mjs")).href)
  mkdirSync(directory) // Exclusive evidence directory: do not overwrite an earlier run.
  const root = mkdtempSync(join(tmpdir(), "req235-install-"))
  process.env.ALPHA_GLOBAL_DIR = root
  const candidates = []
  for (const name of ["html", "image"]) {
    const source = `catalog-src/packages/package.cloud-${name}/1.0.0`
    const validation = Bun.spawnSync(["node", "scripts/package-declaration.mjs", "validate", source], { cwd: webRoot })
    assert.equal(validation.exitCode, 0, "declaration validation")
    const preview = Bun.spawnSync(["node", "scripts/package-declaration.mjs", "preview", source], { cwd: webRoot })
    assert.equal(preview.exitCode, 0, "declaration preview")
    await Bun.write(join(directory, `${name}-preview.json`), preview.stdout)
    const compiled = JSON.parse(preview.stdout.toString()) as {
      envelope: AlphaPackageEnvelopeV1
      payloads: Record<string, CloudPayloadV1>
    }
    const envelope = compiled.envelope
    assert.equal(envelope.prelude.packageId, `package:cloud-${name}`)
    assert.equal(envelope.root, `cloud:${name}`)
    assert.equal(envelope.components.length, 1)
    const bytes = new Uint8Array(canonicalJsonBytes(compiled.payloads[envelope.root]))
    const ref = envelope.components[0]!.payloadRef
    assert.equal(bytes.length, ref.bytes)
    assert.equal(sha256(bytes), ref.sha256)
    await Bun.write(join(directory, `${name}-payload.json`), bytes)
    const catalog = { version: "req235-preview", entries: [], packages: [envelope] }
    // Candidate digest, not a claim of a published/signed channel snapshot.
    const loadVerifiedCatalog = async () => ({ source: "remote" as const, catalog, snapshotDigest: sha256(canonicalJsonBytes(catalog)) })
    const admit = (payload: Uint8Array) => createPackageAdmissionCoordinator({
      loadVerifiedCatalog,
      root: () => root,
      userDataPath: join(root, "user-data"),
      casBaseRoot: () => join(root, "user-data"),
      environment: () => "dev",
      installability: { fetchPayload: async (requested) => {
        assert.equal(requested.url, ref.url)
        return payload
      } },
    })
    const installLegacy = async () => { throw new Error("cloud package reached legacy installer") }
    const intent = { catalogId: envelope.prelude.packageId, scope: { scope: "global" as const }, attemptId: `req235-${name}` }
    const corrupted = bytes.slice()
    corrupted[corrupted.length - 1] = corrupted.at(-1)! ^ 1 // One changed byte; unchanged length/ref.
    const negative = await runCatalogInstallWithPackagePreflight(intent, {
      loadVerifiedCatalog, installLegacy, installPackage: admit(corrupted),
    })
    await save(`${name}-integrity.json`, { changedByte: corrupted.length - 1, before: bytes.at(-1), after: corrupted.at(-1), outcome: negative })
    assert.ok(!negative.ok)
    assert.equal(negative.reason, "package-payload-integrity")
    assert.equal(findRecordV2(root, "cloud", name), null)
    assert.equal(readCapabilityGrant(root, `cloud--${name}`), null)
    const installPackage = admit(bytes)
    const previewOutcome = await runCatalogInstallWithPackagePreflight(intent, { loadVerifiedCatalog, installLegacy, installPackage })
    assert.ok(!previewOutcome.ok && "packageAuthorization" in previewOutcome)
    const authorization = previewOutcome.packageAuthorization
    assert.deepEqual(authorization.items, [{ key: `cloud--${name}`, previous: null, requested: ["cloud:dispatch"], added: ["cloud:dispatch"], removed: [], requiresConfirmation: true }])
    const installed = await runCatalogInstallWithPackagePreflight({
      ...intent, authorization: { confirmed: { [`cloud--${name}`]: ["cloud:dispatch"] }, binding: authorization.binding },
    }, { loadVerifiedCatalog, installLegacy, installPackage })
    assert.ok(installed.ok)
    const receipt = findRecordV2(root, "cloud", name)
    const grant = readCapabilityGrant(root, `cloud--${name}`)
    assert.equal(receipt?.id, envelope.root)
    assert.equal(receipt?.desiredState, "enabled")
    assert.equal(receipt?.origin, "catalog")
    assert.deepEqual(receipt?.files ?? [], [])
    assert.deepEqual(grant?.capabilities, ["cloud:dispatch"])
    const view = await evaluatePackageForHost(envelope, { fetchPayload: async () => bytes })
    assert.equal(view.verdict, "compatible")
    assert.ok(view.cloud)
    candidates.push({ name, packageId: envelope.prelude.packageId, version: envelope.prelude.version,
      digest: catalogRuntimeDigest(envelope) as string, payloadSha256: ref.sha256, payloadBytes: ref.bytes,
      cloud: view.cloud, installed, receipt, grant, authorization, integrityCode: negative.reason })
    console.log(`${envelope.prelude.packageId}: install pass; cloud:dispatch; negative package-payload-integrity`)
  }
  const graphs = readPackageGraphs(root)
  assert.ok(graphs.ok)
  assert.deepEqual(graphs.packageGraphs.map((item) => item.packageId).sort(), ["package:cloud-html", "package:cloud-image"])
  const evidence = {
    verifiedAt: new Date().toISOString(), hostVersion: "0.1.20", localRoot: root,
    hostCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: hostRoot }).stdout.toString().trim(),
    declarationCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: webRoot }).stdout.toString().trim(),
    ledger: await Bun.file(join(root, "installs.json")).json(), candidates,
  }
  await save("install.json", evidence)
  return evidence
}

if (import.meta.main) {
  assert.ok(process.argv[2], "usage: bun prepare.ts <alpha-web-worktree>")
  await prepare(resolve(process.argv[2]))
}
