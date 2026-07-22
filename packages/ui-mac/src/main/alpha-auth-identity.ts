import { ContractIncompatibleError, requireTokenPurpose, type RoutePurpose } from "@alpha-code/contracts-consumer"

export function parseAccessTokenIdentity(token: string, purpose: RoutePurpose) {
  const claims = requireTokenPurpose(token, purpose)
  if (claims.sub !== claims.sub.trim() || /[\u0000-\u001f\u007f]/.test(claims.sub)) {
    throw new ContractIncompatibleError({
      surface: "identity",
      received_version: claims.schema_version,
      reason: "schema-validation",
    })
  }
  return { accessToken: token, tenantId: claims.sub }
}
