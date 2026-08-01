import type {
  CatalogPackageActionKindV1,
  CatalogPackageComponentV1,
  CatalogPackageReasonCodeV1,
  CatalogPackageVerdictV1,
  CatalogPackageViewV1,
} from "../../shared/catalog-package-view"
import type { PackageComponentSkipReasonV1 } from "../../shared/host-extension-package-contract/decoder"

const VERDICT_KEYS = {
  compatible: "alpha.ext.packageVerdictCompatible",
  "update-required": "alpha.ext.packageVerdictUpdateRequired",
  blocked: "alpha.ext.packageVerdictBlocked",
} as const satisfies Record<CatalogPackageVerdictV1, string>

const ACTION_KEYS = {
  install: "alpha.ext.packageActionInstall",
  "update-alpha": "alpha.ext.packageActionUpdateAlpha",
  "resolve-prerequisite": "alpha.ext.packageActionResolvePrerequisite",
  none: "alpha.ext.packageActionNone",
} as const satisfies Record<CatalogPackageActionKindV1, string>

const REASON_KEYS = {
  "package-compatible": "alpha.ext.packageReasonCompatible",
  "package-prerequisite-required": "alpha.ext.packageReasonPrerequisiteRequired",
  "package-host-update-required": "alpha.ext.packageReasonHostUpdateRequired",
  "package-invalid": "alpha.ext.packageReasonInvalid",
  "package-payload-unavailable": "alpha.ext.packageReasonPayloadUnavailable",
  "package-payload-integrity": "alpha.ext.packageReasonPayloadIntegrity",
  "package-payload-invalid": "alpha.ext.packageReasonPayloadInvalid",
  "package-prerequisite-invalid": "alpha.ext.packageReasonPrerequisiteInvalid",
} as const satisfies Record<CatalogPackageReasonCodeV1, string>

const PREREQUISITE_KEYS = {
  ready: "alpha.ext.packagePrerequisiteReady",
  "required-action": "alpha.ext.packagePrerequisiteRequired",
} as const satisfies Record<CatalogPackageViewV1["prerequisites"]["status"], string>

/**
 * `#697`:每个 skip token 都必须有一句用户读得懂的话。`satisfies Record<…>` 让 decoder 新增一个
 * token 时**这里编译不过**,而不是让详情页悄悄显示一个空字符串或一段原始 token。
 */
const SKIP_REASON_KEYS = {
  "component-capability-unsupported": "alpha.ext.packageSkipCapabilityUnsupported",
  "component-media-type-mismatch": "alpha.ext.packageSkipMediaTypeMismatch",
  "component-profile-unsupported": "alpha.ext.packageSkipProfileUnsupported",
} as const satisfies Record<PackageComponentSkipReasonV1, string>

export const packageSkipReasonKey = (reason: PackageComponentSkipReasonV1) => SKIP_REASON_KEYS[reason]

const ROLE_KEYS = {
  root: "alpha.ext.packageComponentRoot",
  leaf: "alpha.ext.packageComponentLeaf",
} as const satisfies Record<CatalogPackageComponentV1["role"], string>

/**
 * One row of the detail page's component table. `included` decides which of the two answers the
 * user gets — "this arrives" or "this does not arrive, because …" — and the reason travels as the
 * decoder's own token so the detail page, the confirm screen and the receipt cannot drift apart.
 */
export function packageComponentPresentation(component: CatalogPackageComponentV1) {
  return {
    roleKey: ROLE_KEYS[component.role],
    requirementKey: component.required ? "alpha.ext.packageRequired" : "alpha.ext.packageOptional",
    stateKey: component.included ? "alpha.ext.packageComponentIncluded" : "alpha.ext.packageComponentSkipped",
    skipReasonKey: component.skipReasonCode ? SKIP_REASON_KEYS[component.skipReasonCode] : undefined,
  }
}

export function packagePresentation(view: CatalogPackageViewV1) {
  return {
    verdictKey: VERDICT_KEYS[view.verdict],
    actionKey: ACTION_KEYS[view.action.kind],
    reasonKey: REASON_KEYS[view.action.reasonCode],
    prerequisiteKey: PREREQUISITE_KEYS[view.prerequisites.status],
  }
}
