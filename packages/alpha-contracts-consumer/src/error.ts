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
  expected_version: 1
  received_version: number | "missing" | "unknown"
  reason: "schema-validation" | "size-limit" | "route-purpose-mismatch"
}

export class ContractIncompatibleError extends Error {
  readonly failure: ContractFailure

  constructor(failure: Omit<ContractFailure, "code" | "expected_version">) {
    super(`Alpha contract incompatible on ${failure.surface}: ${failure.reason}`)
    this.name = "ContractIncompatibleError"
    this.failure = { code: "contract-incompatible", expected_version: 1, ...failure }
  }
}

export function isContractIncompatibleError(error: unknown): error is ContractIncompatibleError {
  return error instanceof ContractIncompatibleError
}
