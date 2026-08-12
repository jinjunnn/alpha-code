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
// #640: the LedgerPageV1 consumer pin this repository authors and submits to alpha-platform's
// cutover gate (contracts/v1/consumer-cutover-required.json). It lives outside vendor/ because
// vendor/ is hash-locked to upstream bytes; these are ours until upstream vendors them back.
const authored = async (path: string) => Bun.file(resolve(root, "fixtures", path)).json()

describe("immutable Alpha contract pin", () => {
  test("contract lock resolves to the exact immutable alpha-platform commit", async () => {
    const lock = await Bun.file(resolve(root, "alpha-platform-contract.lock.json")).json()
    expect(lock.repo).toBe("jinjunnn/alpha-platform")
    // #400 / platform#255: idempotency_key becomes required, the public status enum gains
    // `cancelling`, and CloudJobCancelResultV1 appears. The desktop client moved in the same PR.
    expect(lock.commit).toBe("9cf67bd994e4a44aad3af3fdd150df207f1a234f")
    expect(ALPHA_CONTRACT_VERSION).toBe(1)
  })

  test("contract source lock matches vendored artifact hashes", async () => {
    const lock = (await Bun.file(resolve(root, "alpha-platform-contract.lock.json")).json()) as {
      files: Array<{ path: string; sha256: string }>
    }
    // 22 = 17 (#681 moved the model-catalog producer fixture onto its own pin) + 5 from
    // platform#255: cancel-result + cancelling-status producers and the three invalid
    // idempotency-key fixtures.
    expect(lock.files.length).toBe(22)
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
      "contracts/v1/fixtures/producer/cloud-job-cancel-result.json",
      "contracts/v1/fixtures/producer/cloud-job-request.json",
      "contracts/v1/fixtures/producer/cloud-job-status.json",
      "contracts/v1/fixtures/producer/cloud-job-status-cancelling.json",
      "contracts/v1/fixtures/producer/ledger-page.json",
    ]
    for (const path of paths) expect(validateFixture(await fixture(path)), path).toBe(true)
  })

  // platform#255: `cancelling` is "cancel accepted, stop protocol not yet closed" — a live state.
  // Decoding it must yield exactly that value, not a coercion into a terminal one; the desktop UI
  // relies on this distinction to never show "cancelled" before the server says so.
  test("the seventh status `cancelling` decodes as itself on status and cancel-result surfaces", async () => {
    const status = (await fixture("contracts/v1/fixtures/producer/cloud-job-status-cancelling.json")).value
    expect(decodeContract("CloudJobStatusV1", status, "cloud-http").status).toBe("cancelling")
    const cancel = (await fixture("contracts/v1/fixtures/producer/cloud-job-cancel-result.json")).value
    const decoded = decodeContract("CloudJobCancelResultV1", cancel, "cloud-http")
    expect(decoded.status).toBe("cancelling")
    expect(decoded.accepted).toBe(true)
  })

  // platform#255: the old cancel wire shape (`{ job_id, status }`, no schema_version / accepted)
  // is not a decodable cancel result. This portfolio ships no compatibility branch: the desktop
  // fails closed instead of treating an unversioned blob as evidence the job stopped.
  test("rejects the pre-#255 unversioned cancel response instead of trusting it", () => {
    expect(() =>
      decodeContract("CloudJobCancelResultV1", { job_id: "job_fixture1", status: "cancelled" }, "cloud-http"),
    ).toThrow(ContractIncompatibleError)
  })

  test("upstream invalid idempotency-key fixtures are rejected by the desktop's own compiled schema", async () => {
    const paths = [
      "contracts/v1/fixtures/invalid/cloud-missing-idempotency-key.json",
      "contracts/v1/fixtures/invalid/cloud-idempotency-key-charset.json",
      "contracts/v1/fixtures/invalid/cloud-idempotency-key-trailing-newline.json",
    ]
    for (const path of paths) {
      const invalid = await fixture(path)
      expect(validateFixture(invalid), path).toBe(true)
      expect(() => decodeContract("CloudJobRequestV1", invalid.value, "cloud-http"), path).toThrow(
        ContractIncompatibleError,
      )
    }
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

  // The model-catalog enum/required-field rejections moved with the contract: they now live in
  // model-catalog-v2-consumer.test.ts, against the independently pinned V2 artifact.

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

  // platform#177: the sixth branch is a token issued to SOMEONE ELSE — a third-party MCP client —
  // and it is schema-valid. That is exactly why it needs its own negative: `decodeTokenClaims` is
  // the desktop's credential path, and "valid against the shared schema" must not be enough to
  // enter it. The three-way hard check (token_use / iss / aud) is what keeps it out; deleting any
  // one of them turns this test red.
  test("alpha auth rejects a schema-valid mcp_access token — it is not this client's credential", async () => {
    const value = {
      schema_version: 1,
      iss: "https://auth.tidelabs.click",
      aud: "https://alpha-cloud.tidelabs.click/mcp",
      sub: "tenant_fixture",
      token_use: "mcp_access",
      scope: ["cloud.read", "artifact.read"],
      iat: 1_800_000_000,
      exp: 1_800_003_600,
      jti: "mcp-fixture",
    }
    // Guard against the test proving nothing: the branch really is present in the vendored schema.
    const schema = (await Bun.file(
      resolve(vendor, "contracts/v1/alpha-wire-contracts.schema.json"),
    ).json()) as { $defs: { TokenClaimsV1: { oneOf: Array<{ properties: { token_use: { const: string } } }> } } }
    expect(schema.$defs.TokenClaimsV1.oneOf.map((branch) => branch.properties.token_use.const)).toContain(
      "mcp_access",
    )
    expect(() => decodeTokenClaims(jwt(value))).toThrow(ContractIncompatibleError)
  })

  // The other half of the same bump: the five branches this repository DOES consume are untouched,
  // and the new purpose is a legal member of the platform_access vocabulary without becoming a
  // route purpose here.
  test("the platform_access branch still verifies unchanged, private issuer and all", async () => {
    const value = await claims()
    expect(value.iss).toBe("alpha-web")
    expect(value.token_use).toBe("platform_access")
    expect(() => decodeTokenClaims(jwt(value))).not.toThrow()
    const schema = (await Bun.file(
      resolve(vendor, "contracts/v1/alpha-wire-contracts.schema.json"),
    ).json()) as {
      $defs: {
        TokenClaimsV1: {
          oneOf: Array<{ properties: { token_use: { const: string }; purpose?: { enum?: string[] } } }>
        }
      }
    }
    const platformAccess = schema.$defs.TokenClaimsV1.oneOf.find(
      (branch) => branch.properties.token_use.const === "platform_access",
    )
    expect(platformAccess?.properties.purpose?.enum).toContain("account.keys.manage")
  })

  test("rejects a platform_access token whose purpose does not match the route", async () => {
    const token = jwt(await claims())
    expect(() => requireTokenPurpose(token, "account.read")).toThrow(
      expect.objectContaining({ failure: expect.objectContaining({ reason: "route-purpose-mismatch" }) }),
    )
  })

  test("alpha account rejects an incompatible LedgerPageV1 without cached success", async () => {
    const value = structuredClone((await fixture("contracts/v1/fixtures/producer/ledger-page.json")).value)
    // A fact kind this build does not know is drift, not a row to render blank.
    value.transactions[0].kind = "usage_settled_v2"
    expect(() => decodeContract("LedgerPageV1", value, "account")).toThrow(ContractIncompatibleError)
  })

  // #640 hard cut: the pre-cut row shape must be *rejected*, not silently tolerated. If this ever
  // passes, a compatibility shim has grown back and the account surface would render a page whose
  // amounts it cannot attribute to a domain.
  test("alpha account rejects the pre-cut ledger row shape at an unchanged schema_version", () => {
    const legacy = {
      schema_version: 1,
      transactions: [
        {
          schema_version: 1,
          id: "tx_1",
          type: "usage",
          title: "模型调用",
          amount_fen: -1250,
          created_at: "2026-07-29T00:00:00.000Z",
          status: "success",
        },
      ],
    }
    expect(() => decodeContract("LedgerPageV1", legacy, "account")).toThrow(ContractIncompatibleError)
  })

  // The other half of #640: the consumer pin alpha-platform's cutover gate reads is decoded here by
  // the *shipped* decoder, so "alpha-code is on the new shape" is executed, not asserted in prose.
  test("the #640 consumer pin decodes through the shipped strict LedgerPageV1 decoder", async () => {
    const pin = await authored("consumers/alpha-code-640/ledger-page.json")
    expect(pin.contract).toBe("LedgerPageV1")
    expect(pin.consumer).toBe("alpha-code")
    expect(pin.expect).toBe("valid")
    expect(validateFixture(pin)).toBe(true)

    // decodeJsonContract is the exact call fetchTransactions makes on the account response body.
    const page = decodeJsonContract("LedgerPageV1", JSON.stringify(pin.value), "account")
    expect(page.transactions.map((entry) => entry.seq)).toEqual([1042, 1041, 1040, 1039])
    // The pin must exercise what the account surface has to survive: both balance domains, both
    // amount signs, and each optional field the wire may carry.
    expect(new Set(page.transactions.map((entry) => entry.domain))).toEqual(new Set(["wallet", "allowance"]))
    expect(page.transactions.some((entry) => entry.amount > 0)).toBe(true)
    expect(page.transactions.some((entry) => entry.amount < 0)).toBe(true)
    expect(page.transactions.some((entry) => entry.window_id !== undefined)).toBe(true)
    expect(page.transactions.some((entry) => entry.external_ref !== undefined)).toBe(true)
    expect(page.transactions.every((entry) => Number.isInteger(entry.created_at))).toBe(true)
  })

  test("the #640 consumer pin declares the shipped desktop version the cutover gate pins to", async () => {
    const pin = await authored("consumers/alpha-code-640/ledger-page.json")
    const shipped = await Bun.file(resolve(root, "../ui-mac/package.json")).json()
    expect(pin.consumer_version).toBe(shipped.version)
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
    expect(() => decodeJsonContract("ModelCatalogV2", " ".repeat(plusOne.wire_bytes), "model-catalog")).toThrow(
      expect.objectContaining({
        // The size-limit branch must also report the contract's own generation — reporting "expected v1"
        // for a V2 wire would send a maintainer looking at the wrong producer.
        failure: expect.objectContaining({ reason: "size-limit", expected_version: 2 }),
      }),
    )
  })
})
