export type ContractSurface =
  | "identity"
  | "endpoint-discovery"
  | "account"
  | "model-catalog"
  | "cloud-http"
  | "cloud-mcp"
  | "artifact"

export type ContractFailure = {
  code: "contract-incompatible"
  surface: ContractSurface
  /** #681 / ADR-039: generations are per-contract now — `/v1/models` expects ModelCatalogV2 while every
   *  other wire is still generation 1. The URL's `v1` is an HTTP namespace, not this number. */
  expected_version: 1 | 2
  received_version: number | "missing" | "unknown"
  reason: "schema-validation" | "size-limit" | "route-purpose-mismatch"
}

export class ContractIncompatibleError extends Error {
  readonly failure: ContractFailure

  constructor(failure: Omit<ContractFailure, "code" | "expected_version"> & { expected_version?: 1 | 2 }) {
    super(`Alpha contract incompatible on ${failure.surface}: ${failure.reason}`)
    this.name = "ContractIncompatibleError"
    // `expected_version` last and coalesced: spreading an explicitly-`undefined` field over a default
    // would leave the record claiming `1 | 2` while carrying `undefined`.
    this.failure = { code: "contract-incompatible", ...failure, expected_version: failure.expected_version ?? 1 }
  }
}

export function isContractIncompatibleError(error: unknown): error is ContractIncompatibleError {
  return error instanceof ContractIncompatibleError
}
