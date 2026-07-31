import type {
  CatalogPackageActionKindV1,
  CatalogPackageReasonCodeV1,
  CatalogPackageVerdictV1,
  CatalogPackageViewV1,
} from "../../shared/catalog-package-view"

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

export function packagePresentation(view: CatalogPackageViewV1) {
  return {
    verdictKey: VERDICT_KEYS[view.verdict],
    actionKey: ACTION_KEYS[view.action.kind],
    reasonKey: REASON_KEYS[view.action.reasonCode],
    prerequisiteKey: PREREQUISITE_KEYS[view.prerequisites.status],
  }
}
