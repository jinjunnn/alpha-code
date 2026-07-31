import type { PackageComponentSkipReasonV1 } from "./host-extension-package-contract/decoder"

export const CATALOG_PACKAGE_REASON_CODES = [
  "package-compatible",
  "package-prerequisite-required",
  "package-host-update-required",
  "package-bundle-activation-pending",
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

/**
 * One row per signed component, root included. `included` is the only authority on whether a
 * component takes part in the install; `skipReasonCode` is the decoder's own token, carried
 * verbatim so the detail page, the plan preview, and the receipt cannot each invent their own
 * wording for the same fact. It is `null` — never absent — so the wire key set does not vary
 * between rows.
 */
export type CatalogPackageComponentV1 = {
  componentId: string
  role: "root" | "leaf"
  required: boolean
  included: boolean
  skipReasonCode: PackageComponentSkipReasonV1 | null
}

export type CatalogPackageViewV1 = {
  catalogId: string
  verdict: CatalogPackageVerdictV1
  action: CatalogPackageActionV1
  components: CatalogPackageComponentV1[]
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
