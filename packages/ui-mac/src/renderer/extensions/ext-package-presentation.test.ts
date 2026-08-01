import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  CATALOG_PACKAGE_REASON_CODES,
  type CatalogPackageActionKindV1,
  type CatalogPackageReasonCodeV1,
  type CatalogPackageVerdictV1,
  type CatalogPackageViewV1,
} from "../../shared/catalog-package-view"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { packagePresentation } from "./ext-package-presentation"

const blockedReasons = [
  "package-invalid",
  "package-payload-unavailable",
  "package-payload-integrity",
  "package-payload-invalid",
  "package-prerequisite-invalid",
] as const

const legalViews: CatalogPackageViewV1[] = [
  {
    catalogId: "package:ready",
    verdict: "compatible",
    action: { kind: "install", enabled: true, reasonCode: "package-compatible" },
    components: [],
    prerequisites: { status: "ready", items: [] },
    presentation: { displayName: "Ready", description: "Ready package", version: "1.0.0" },
  },
  {
    catalogId: "package:prerequisite",
    verdict: "compatible",
    action: {
      kind: "resolve-prerequisite",
      enabled: true,
      reasonCode: "package-prerequisite-required",
    },
    components: [],
    prerequisites: {
      status: "required-action",
      items: [{ prerequisiteId: "component#TOKEN", label: "TOKEN", required: true }],
    },
    presentation: {
      displayName: "Prerequisite",
      description: "Prerequisite package",
      version: "1.0.0",
    },
  },
  {
    catalogId: "package:update",
    verdict: "update-required",
    action: {
      kind: "update-alpha",
      enabled: true,
      reasonCode: "package-host-update-required",
    },
    components: [],
    prerequisites: { status: "ready", items: [] },
    presentation: { displayName: "Update", description: "Update package", version: "1.0.0" },
  },
  ...blockedReasons.map(
    (reasonCode): CatalogPackageViewV1 => ({
      catalogId: `package:${reasonCode}`,
      verdict: "blocked",
      action: { kind: "none", enabled: false, reasonCode },
      components: [],
      prerequisites: { status: "ready", items: [] },
      presentation: { displayName: reasonCode, description: "Blocked package", version: "1.0.0" },
    }),
  ),
]

describe("package safe-view presentation", () => {
  test("exhausts every legal verdict/action/reason/prerequisite combination", () => {
    expect(legalViews).toHaveLength(8)
    expect([...new Set(legalViews.map((view) => view.verdict))].sort()).toEqual(
      ["blocked", "compatible", "update-required"] satisfies CatalogPackageVerdictV1[],
    )
    expect([...new Set(legalViews.map((view) => view.action.kind))].sort()).toEqual(
      ["install", "none", "resolve-prerequisite", "update-alpha"] satisfies CatalogPackageActionKindV1[],
    )
    expect([...new Set(legalViews.map((view) => view.action.reasonCode))].sort()).toEqual(
      [...CATALOG_PACKAGE_REASON_CODES].sort() satisfies CatalogPackageReasonCodeV1[],
    )
    expect([...new Set(legalViews.map((view) => view.prerequisites.status))].sort()).toEqual([
      "ready",
      "required-action",
    ])

    expect(legalViews.map(packagePresentation)).toEqual([
      {
        verdictKey: "alpha.ext.packageVerdictCompatible",
        actionKey: "alpha.ext.packageActionInstall",
        reasonKey: "alpha.ext.packageReasonCompatible",
        prerequisiteKey: "alpha.ext.packagePrerequisiteReady",
      },
      {
        verdictKey: "alpha.ext.packageVerdictCompatible",
        actionKey: "alpha.ext.packageActionResolvePrerequisite",
        reasonKey: "alpha.ext.packageReasonPrerequisiteRequired",
        prerequisiteKey: "alpha.ext.packagePrerequisiteRequired",
      },
      {
        verdictKey: "alpha.ext.packageVerdictUpdateRequired",
        actionKey: "alpha.ext.packageActionUpdateAlpha",
        reasonKey: "alpha.ext.packageReasonHostUpdateRequired",
        prerequisiteKey: "alpha.ext.packagePrerequisiteReady",
      },
      ...blockedReasons.map((reason) => ({
        verdictKey: "alpha.ext.packageVerdictBlocked" as const,
        actionKey: "alpha.ext.packageActionNone" as const,
        reasonKey: {
          "package-invalid": "alpha.ext.packageReasonInvalid",
          "package-payload-unavailable": "alpha.ext.packageReasonPayloadUnavailable",
          "package-payload-integrity": "alpha.ext.packageReasonPayloadIntegrity",
          "package-payload-invalid": "alpha.ext.packageReasonPayloadInvalid",
          "package-prerequisite-invalid": "alpha.ext.packageReasonPrerequisiteInvalid",
        }[reason],
        prerequisiteKey: "alpha.ext.packagePrerequisiteReady" as const,
      })),
    ])
  })

  test("every presentation key has non-empty local English and Chinese copy", () => {
    const presentationKeys = legalViews.flatMap((view) =>
      Object.values(packagePresentation(view)),
    )
    expect(
      new Set(legalViews.map((view) => packagePresentation(view).reasonKey)).size,
    ).toBe(CATALOG_PACKAGE_REASON_CODES.length)
    for (const key of presentationKeys) {
      expect(en[key].trim(), `${key} missing English copy`).not.toBe("")
      expect(zh[key].trim(), `${key} missing Chinese copy`).not.toBe("")
    }
  })

  test("the static visual harness Chinese copy stays aligned with the renderer dictionary", async () => {
    const harness = await Bun.file(
      resolve(
        import.meta.dir,
        "../../../../../docs/verification/2026-07-31-req128-package-detail/harness/package-detail-harness.html",
      ),
    ).text()
    const keys = [
      "alpha.ext.back",
      "alpha.ext.tabFeatured",
      "alpha.ext.detailAbout",
      "alpha.ext.detailVersion",
      "alpha.ext.packageType",
      "alpha.ext.packageSourceRemote",
      "alpha.ext.packageInstallability",
      "alpha.ext.packageVerdictCompatible",
      "alpha.ext.packageVerdictUpdateRequired",
      "alpha.ext.packageVerdictBlocked",
      "alpha.ext.packageComponentsTitle",
      "alpha.ext.packageComponent",
      "alpha.ext.packagePrerequisiteStatus",
      "alpha.ext.packagePrerequisiteReady",
      "alpha.ext.packagePrerequisiteRequired",
      "alpha.ext.packageRequired",
      "alpha.ext.packageReasonTitle",
      "alpha.ext.packageReasonCompatible",
      "alpha.ext.packageReasonPrerequisiteRequired",
      "alpha.ext.packageReasonHostUpdateRequired",
      "alpha.ext.packageReasonInvalid",
      "alpha.ext.packageReasonPayloadIntegrity",
      "alpha.ext.packageActions",
      "alpha.ext.packageActionInstall",
      "alpha.ext.packageActionUpdateAlpha",
      "alpha.ext.packageActionResolvePrerequisite",
      "alpha.ext.packageActionNone",
      "alpha.ext.confirmInstall",
      "alpha.ext.cancel",
      "alpha.ext.packageConfirmEnv",
      "alpha.ext.packageKeyPlaceholder",
      "alpha.ext.packageKeysRequired",
      "alpha.ext.keyHint",
      "alpha.ext.confirmNote",
      "alpha.ext.authz.chipNew",
      "alpha.ext.authz.note",
    ] as const
    // 先钉非空,再钉漂移:下面那条是子串包含判据,而 `includes("")` 恒真 ——
    // 把任一 key 的值清空,漂移闸与 cases 里的同源断言(`toBe(zh[key])`,`"" === ""`)
    // 会**同时**退化,三条闸全绿,而用户看到的是一个空的解释段。
    // 审计实测三个新 key 各自清空都零红存活,这一行把 36 个 key 一次罩住。
    expect(
      keys.filter((key) => zh[key].trim() === "" || en[key].trim() === ""),
      "every rendered key must have non-empty copy in both locales",
    ).toEqual([])
    expect(
      keys.filter((key) => !harness.includes(zh[key])),
      "visual harness contains Chinese literals, so every rendered phrase must track zh.ts",
    ).toEqual([])
    expect(
      [
        zh["alpha.ext.confirmTitle"].replace("{{name}}", "${esc(view.name)}"),
        zh["alpha.ext.authz.introFirst"].replace("{{name}}", "${esc(view.name)}"),
      ].filter((copy) => !harness.includes(copy)),
      "visual harness interpolated Chinese copy must track zh.ts",
    ).toEqual([])
  })
})
