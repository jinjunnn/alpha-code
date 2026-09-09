import type {
  PackageComponentSkipReasonV1,
  PackageListingV1,
} from "./host-extension-package-contract/decoder"

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
  /**
   * `#1287`:签名信封里的上架呈现段,**逐字转发**。字段集的唯一权威是
   * `alpha-package-envelope-v1.schema.json`,所以这里不重列一遍 —— 加字段只改那个 JSON。
   * 缺席是常态(已发布的条目一个都没有),消费端必须当可选处理。
   */
  listing?: PackageListingV1
}
