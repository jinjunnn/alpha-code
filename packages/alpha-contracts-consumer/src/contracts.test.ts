import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  ALPHA_CONTRACT_VERSION,
  CONTROL_ENVELOPE_MAX_BYTES,
  ContractIncompatibleError,
  NON_STREAMING_PAYLOAD_MAX_BYTES,
  decodeContract,
  decodeJsonContract,
  decodeTokenClaims,
  decodeUploadConsentClaims,
  requireTokenPurpose,
  type UploadConsentClaimsV1,
  type UploadManifestV1,
  validateFixture,
} from "./index"

const root = resolve(import.meta.dir, "..")
const vendor = resolve(root, "vendor/alpha-platform")
const fixture = async (path: string) => Bun.file(resolve(vendor, path)).json()

describe("immutable Alpha contract pin", () => {
  test("contract lock resolves to the exact immutable alpha-platform commit", async () => {
    const lock = await Bun.file(resolve(root, "alpha-platform-contract.lock.json")).json()
    expect(lock.repo).toBe("jinjunnn/alpha-platform")
    expect(lock.commit).toBe("bcc60bbf4870dd23ea5a63c9dca3107aa7a4b990")
    expect(ALPHA_CONTRACT_VERSION).toBe(1)
  })

  test("contract source lock matches vendored artifact hashes", async () => {
    const lock = (await Bun.file(resolve(root, "alpha-platform-contract.lock.json")).json()) as {
      files: Array<{ path: string; sha256: string }>
    }
    expect(lock.files.length).toBe(18)
    for (const file of lock.files) {
      const bytes = new Uint8Array(await Bun.file(resolve(vendor, file.path)).arrayBuffer())
      expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(file.sha256)
    }
  })
})

describe("producer and consumer fixtures", () => {
  test("producer v1 fixtures decode through the desktop consumer", async () => {
    const paths = [
      "contracts/v1/fixtures/producer/artifact-list.json",
      "contracts/v1/fixtures/producer/cloud-job-accepted.json",
      "contracts/v1/fixtures/producer/cloud-job-request.json",
      "contracts/v1/fixtures/producer/cloud-job-status.json",
      "contracts/v1/fixtures/producer/ledger-page.json",
      "contracts/v1/fixtures/producer/model-catalog.json",
    ]
    for (const path of paths) expect(validateFixture(await fixture(path)), path).toBe(true)
  })

  test("consumer v1 fixtures validate against the pinned producer schemas", async () => {
    const paths = [
      "contracts/v1/fixtures/consumers/alpha-code-224/cloud-and-artifact.json",
      "contracts/v1/fixtures/consumers/alpha-web-22/platform-access-claims.json",
    ]
    for (const path of paths) expect(validateFixture(await fixture(path)), path).toBe(true)
  })

  test("rejects incompatible producer fixture drift", async () => {
    const value = structuredClone((await fixture("contracts/v1/fixtures/producer/cloud-job-status.json")).value)
    value.status = "almost-complete"
    expect(() => decodeContract("CloudJobStatusV1", value, "cloud-http")).toThrow(ContractIncompatibleError)
  })

  test("rejects missing schema_version before side effects", async () => {
    const invalid = await fixture("contracts/v1/fixtures/invalid/cloud-missing-version.json")
    expect(validateFixture(invalid)).toBe(true)
    expect(() => decodeContract("CloudJobRequestV1", invalid.value, "cloud-http")).toThrow(ContractIncompatibleError)
  })

  test("rejects a mutated v1 enum without coercion", async () => {
    const value = structuredClone((await fixture("contracts/v1/fixtures/producer/model-catalog.json")).value)
    value.data[0].provider = "DeepSeek"
    expect(() => decodeContract("ModelCatalogV1", value, "model-catalog")).toThrow(ContractIncompatibleError)
  })

  test("model catalog rejects incompatible v1 data without static fallback", async () => {
    const value = structuredClone((await fixture("contracts/v1/fixtures/producer/model-catalog.json")).value)
    delete value.byok_providers
    expect(() => decodeContract("ModelCatalogV1", value, "model-catalog")).toThrow(ContractIncompatibleError)
  })

  test("rejects unknown CloudJobStatus.status instead of mapping it to running", async () => {
    const value = structuredClone((await fixture("contracts/v1/fixtures/producer/cloud-job-status.json")).value)
    value.status = "waiting"
    expect(() => decodeContract("CloudJobStatusV1", value, "cloud-http")).toThrow(ContractIncompatibleError)
  })
})

describe("identity, account, and artifact fail closed", () => {
  const claims = async () =>
    (await fixture("contracts/v1/fixtures/consumers/alpha-web-22/platform-access-claims.json")).value as Record<
      string,
      unknown
    >
  const jwt = (value: unknown) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`

  test("alpha auth rejects incompatible token claims before persistence", async () => {
    const value = await claims()
    delete value.schema_version
    expect(() => decodeTokenClaims(jwt(value))).toThrow(ContractIncompatibleError)
  })

  test("alpha auth rejects a non-platform-access TokenClaimsV1 union branch", async () => {
    const value = { ...(await claims()), token_use: "job", aud: "alpha-cloud", iss: "alpha-platform" }
    expect(() => decodeTokenClaims(jwt(value))).toThrow(ContractIncompatibleError)
  })

  test("rejects a platform_access token whose purpose does not match the route", async () => {
    const token = jwt(await claims())
    expect(() => requireTokenPurpose(token, "account.read")).toThrow(
      expect.objectContaining({ failure: expect.objectContaining({ reason: "route-purpose-mismatch" }) }),
    )
  })

  test("alpha account rejects an incompatible LedgerPageV1 without cached success", async () => {
    const value = structuredClone((await fixture("contracts/v1/fixtures/producer/ledger-page.json")).value)
    value.transactions[0].status = "pending"
    expect(() => decodeContract("LedgerPageV1", value, "account")).toThrow(ContractIncompatibleError)
  })

  test("rejects legacy inline artifact metadata without fallback", async () => {
    const invalid = await fixture("contracts/v1/fixtures/invalid/artifact-inline-content.json")
    expect(validateFixture(invalid)).toBe(true)
    expect(() => decodeContract("ArtifactDescriptorV1", invalid.value, "artifact")).toThrow(ContractIncompatibleError)
  })

  test("decodes the vendored alpha-web upload_consent branch and rejects a platform issuer", () => {
    const value: UploadConsentClaimsV1 = {
      schema_version: 1,
      iss: "alpha-web",
      aud: "alpha-platform-upload",
      sub: "tenant-a",
      token_use: "upload_consent",
      purpose: "artifact.upload",
      scope: ["artifact.upload"],
      iat: 1,
      exp: 2,
      jti: "consent-1",
      manifest_id: "manifest-1",
      manifest_sha256: "a".repeat(64),
      egress: [{ egress_class: "explicit.file-upload", enforcement: "required" }],
    }
    expect(decodeUploadConsentClaims(jwt(value))).toEqual(value)
    expect(() => decodeUploadConsentClaims(jwt({ ...value, iss: "alpha-platform" }))).toThrow(
      ContractIncompatibleError,
    )
  })
})

describe("UploadManifestV1 fail-closed invariants", () => {
  const manifest = (): UploadManifestV1 => ({
    schema_version: 1,
    manifest_id: "manifest-1",
    tenant_id: "tenant-a",
    created_at: "2026-07-22T12:00:00.000Z",
    retention_class: "standard",
    consent_required: false,
    egress: [{ egress_class: "explicit.file-upload", enforcement: "required" }],
    file_count: 1,
    total_bytes: 4,
    files: [{ path: "src/a.ts", size_bytes: 4, sha256: "a".repeat(64) }],
  })

  test("accepts the vendored explicit.file-upload manifest shape", () => {
    expect(decodeContract("UploadManifestV1", manifest(), "cloud-http")).toEqual(manifest())
  })

  test("rejects count total and path uniqueness drift not expressible in JSON Schema", () => {
    expect(() => decodeContract("UploadManifestV1", { ...manifest(), file_count: 0 }, "cloud-http")).toThrow()
    expect(() => decodeContract("UploadManifestV1", { ...manifest(), total_bytes: 5 }, "cloud-http")).toThrow()
    const duplicate = manifest()
    duplicate.file_count = 2
    duplicate.total_bytes = 8
    duplicate.files.push({ ...duplicate.files[0]! })
    expect(() => decodeContract("UploadManifestV1", duplicate, "cloud-http")).toThrow()
  })
})

describe("published byte limits", () => {
  test("rejects control envelopes larger than 256 KiB before dispatch", async () => {
    const exact = await fixture("contracts/v1/fixtures/limits/envelope-max-exact.json")
    const plusOne = await fixture("contracts/v1/fixtures/limits/envelope-max-plus-one.json")
    expect(exact.wire_bytes).toBe(CONTROL_ENVELOPE_MAX_BYTES)
    expect(plusOne.wire_bytes).toBe(CONTROL_ENVELOPE_MAX_BYTES + 1)
  })

  test("rejects non-streaming payloads larger than 512 KiB before parse", async () => {
    const exact = await fixture("contracts/v1/fixtures/limits/payload-max-exact.json")
    const plusOne = await fixture("contracts/v1/fixtures/limits/payload-max-plus-one.json")
    expect(exact.wire_bytes).toBe(NON_STREAMING_PAYLOAD_MAX_BYTES)
    expect(plusOne.wire_bytes).toBe(NON_STREAMING_PAYLOAD_MAX_BYTES + 1)
    expect(() => decodeJsonContract("ModelCatalogV1", " ".repeat(plusOne.wire_bytes), "model-catalog")).toThrow(
      expect.objectContaining({ failure: expect.objectContaining({ reason: "size-limit" }) }),
    )
  })
})
