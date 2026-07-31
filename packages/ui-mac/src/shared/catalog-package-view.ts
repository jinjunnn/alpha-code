export const CATALOG_PACKAGE_REASON_CODES = [
  "package-compatible",
  "package-prerequisite-required",
  "package-host-update-required",
  "package-invalid",
  "package-payload-unavailable",
  "package-payload-integrity",
  "package-payload-invalid",
  "package-prerequisite-invalid",
] as const

export type CatalogPackageReasonCodeV1 = (typeof CATALOG_PACKAGE_REASON_CODES)[number]
export type CatalogPackageVerdictV1 = "compatible" | "update-required" | "blocked"
export type CatalogPackageActionKindV1 = "install" | "update-alpha" | "resolve-prerequisite" | "none"

export type CatalogPackageActionV1 = {
  kind: CatalogPackageActionKindV1
  enabled: boolean
  reasonCode: CatalogPackageReasonCodeV1
}

export type CatalogPackageViewV1 = {
  catalogId: string
  verdict: CatalogPackageVerdictV1
  action: CatalogPackageActionV1
  prerequisites: {
    status: "ready" | "required-action"
    items: Array<{
      prerequisiteId: string
      label: string
      required: boolean
    }>
  }
  presentation: {
    displayName: string
    description: string
    version: string
  }
}
