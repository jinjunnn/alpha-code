import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import artifactDescriptorSchema from "../vendor/alpha-platform/contracts/v1/artifact-descriptor.schema.json"
import wireSchema from "../vendor/alpha-platform/contracts/v1/alpha-wire-contracts.schema.json"
import limits from "../vendor/alpha-platform/contracts/v1/limits.json"
import { ContractIncompatibleError, type ContractSurface } from "./error"
import type { ContractValues, RoutePurpose, TokenClaimsV1, UploadConsentClaimsV1 } from "./types"

export const ALPHA_CONTRACT_VERSION = 1 as const
export const CONTROL_ENVELOPE_MAX_BYTES = limits.CONTROL_ENVELOPE_MAX_BYTES
export const NON_STREAMING_PAYLOAD_MAX_BYTES = limits.NON_STREAMING_PAYLOAD_MAX_BYTES

const ajv = new Ajv2020({ strict: true, allErrors: true })
addFormats(ajv)
ajv.addSchema(artifactDescriptorSchema)
ajv.addSchema(wireSchema)

const validators = {
  TokenClaimsV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/TokenClaimsV1" }),
  UploadManifestV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/UploadManifestV1" }),
  LedgerPageV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/LedgerPageV1" }),
  ModelCatalogV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/ModelCatalogV1" }),
  CloudJobRequestV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/CloudJobRequestV1" }),
  CloudJobAcceptedV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/CloudJobAcceptedV1" }),
  CloudJobStatusV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/CloudJobStatusV1" }),
  ArtifactListV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/ArtifactListV1" }),
  ArtifactDescriptorV1: ajv.compile({ $ref: "artifact-descriptor.schema.json" }),
}

export type ContractName = keyof ContractValues

export function decodeContract<Name extends ContractName>(
  contract: Name,
  value: unknown,
  surface: ContractSurface,
): ContractValues[Name] {
  if (!validators[contract](value)) {
    throw new ContractIncompatibleError({
      surface,
      received_version: receivedVersion(value, contract === "ArtifactDescriptorV1" ? "schemaVersion" : "schema_version"),
      reason: "schema-validation",
    })
  }
  if (contract === "UploadManifestV1" && !uploadManifestInvariants(value)) {
    throw new ContractIncompatibleError({
      surface,
      received_version: receivedVersion(value, "schema_version"),
      reason: "schema-validation",
    })
  }
  return value as ContractValues[Name]
}

export function decodeJsonContract<Name extends ContractName>(
  contract: Name,
  text: string,
  surface: ContractSurface,
): ContractValues[Name] {
  if (new TextEncoder().encode(text).byteLength > NON_STREAMING_PAYLOAD_MAX_BYTES) {
    throw new ContractIncompatibleError({ surface, received_version: "unknown", reason: "size-limit" })
  }
  try {
    return decodeContract(contract, JSON.parse(text), surface)
  } catch (error) {
    if (error instanceof ContractIncompatibleError) throw error
    throw new ContractIncompatibleError({ surface, received_version: "unknown", reason: "schema-validation" })
  }
}

export function decodeTokenClaims(token: string): TokenClaimsV1 {
  try {
    const claims = decodeContract("TokenClaimsV1", decodeJwtPayload(token), "identity")
    if (claims.token_use !== "platform_access" || claims.iss !== "alpha-web" || claims.aud !== "alpha-platform-api") {
      throw new ContractIncompatibleError({
        surface: "identity",
        received_version: claims.schema_version,
        reason: "schema-validation",
      })
    }
    return claims
  } catch (error) {
    if (error instanceof ContractIncompatibleError) throw error
    throw new ContractIncompatibleError({ surface: "identity", received_version: "unknown", reason: "schema-validation" })
  }
}

export function decodeUploadConsentClaims(token: string): UploadConsentClaimsV1 {
  try {
    const claims = decodeContract("TokenClaimsV1", decodeJwtPayload(token), "identity") as unknown as UploadConsentClaimsV1
    if (
      claims.token_use !== "upload_consent" ||
      claims.iss !== "alpha-web" ||
      claims.aud !== "alpha-platform-upload" ||
      claims.purpose !== "artifact.upload" ||
      !claims.scope.includes("artifact.upload")
    ) {
      throw new ContractIncompatibleError({
        surface: "identity",
        received_version: claims.schema_version,
        reason: "schema-validation",
      })
    }
    return claims
  } catch (error) {
    if (error instanceof ContractIncompatibleError) throw error
    throw new ContractIncompatibleError({ surface: "identity", received_version: "unknown", reason: "schema-validation" })
  }
}

export function requireTokenPurpose(token: string, purpose: RoutePurpose): TokenClaimsV1 {
  const claims = decodeTokenClaims(token)
  if (claims.purpose !== purpose || !claims.scope.includes(purpose)) {
    throw new ContractIncompatibleError({
      surface: "identity",
      received_version: claims.schema_version,
      reason: "route-purpose-mismatch",
    })
  }
  return claims
}

export function validateFixture(fixture: unknown): boolean {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) return false
  const record = fixture as { contract?: unknown; expect?: unknown; value?: unknown }
  if (typeof record.contract !== "string" || !(record.contract in validators)) return false
  const valid = validators[record.contract as ContractName](record.value)
  return record.expect === "valid" ? valid : record.expect === "invalid" ? !valid : false
}

function receivedVersion(value: unknown, field: "schema_version" | "schemaVersion") {
  if (!value || typeof value !== "object" || Array.isArray(value) || !(field in value)) return "missing" as const
  const version = (value as Record<string, unknown>)[field]
  return typeof version === "number" ? version : ("unknown" as const)
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) {
    throw new ContractIncompatibleError({ surface: "identity", received_version: "missing", reason: "schema-validation" })
  }
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
}

function uploadManifestInvariants(value: unknown) {
  const manifest = value as ContractValues["UploadManifestV1"]
  return (
    manifest.file_count === manifest.files.length &&
    manifest.total_bytes === manifest.files.reduce((total, file) => total + file.size_bytes, 0) &&
    new Set(manifest.files.map((file) => file.path)).size === manifest.files.length
  )
}
