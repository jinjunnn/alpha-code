import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  CATALOG_PACKAGE_REASON_CODES,
  type CatalogPackageActionKindV1,
  type CatalogPackageComponentV1,
  type CatalogPackageReasonCodeV1,
  type CatalogPackageVerdictV1,
  type CatalogPackageViewV1,
} from "../../shared/catalog-package-view"
import { PACKAGE_COMPONENT_SKIP_REASONS_V1 } from "../../shared/host-extension-package-contract/decoder"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import {
  packageComponentPresentation,
  packagePresentation,
  packageSkipReasonKey,
} from "./ext-package-presentation"

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

  /**
   * 逐组件那一面的文案穷举闸。
   *
   * 这条是补一个**实测存在**的假绿:此前只有 `packagePresentation` 的四张表被穷举,而
   * `packageSkipReasonKey` / `packageComponentPresentation` 一条都没进闸。审计方把 en 与 zh 里的
   * `alpha.ext.packageSkipMediaTypeMismatch` **同时删掉**,这个文件与 locale key-parity 闸仍然
   * 11 pass / 0 fail —— 而 `renderer/i18n/index.ts` 的 `t()` 在缺翻译时**回退到 key 本身**,
   * 于是用户会在详情页读到一行 `alpha.ext.packageSkipMediaTypeMismatch`。
   *
   * 判据必须是**遍历常量**,不是逐个手写断言:后者对「decoder 新增第四个 token」默认放行,
   * 正是「枚举对新成员默认放行」的形态。这里遍历 `PACKAGE_COMPONENT_SKIP_REASONS_V1` 与
   * 逐组件呈现的全部合法输入,所以新 token 没补文案时**这条会红**。
   */
  test("every component-row and skip-reason key has non-empty English and Chinese copy", () => {
    // ① 映射表与 decoder 的 token 集**互为**子集 —— 少一个 = 该 token 没有话可说;
    //    多一个 = 指向一个 decoder 永远不会产出的原因。
    // `satisfies Record<PackageComponentSkipReasonV1, string>` 只在编译期挡漏映射,而 bun 直接
    // 剥类型 ⇒ 新 token 在测试里拿到的是 `undefined`。先把它揪出来并**点名是哪个 token**,
    // 否则下面按 `typeof === "string"` 过滤时它会被静默丢掉,闸门自己就成了假的。
    const unmapped = PACKAGE_COMPONENT_SKIP_REASONS_V1.filter((reason) => {
      const key = packageSkipReasonKey(reason)
      return typeof key !== "string" || key.trim() === ""
    })
    expect(unmapped, "decoder 的每个 skip token 都必须在 SKIP_REASON_KEYS 里有一条文案 key").toEqual([])

    const mapped = PACKAGE_COMPONENT_SKIP_REASONS_V1.map((reason) => packageSkipReasonKey(reason))
    expect(mapped).toHaveLength(PACKAGE_COMPONENT_SKIP_REASONS_V1.length)
    expect(new Set(mapped).size, "两个 token 不得共用一句文案").toBe(mapped.length)

    // ② 逐组件呈现的全部合法输入:role × required × (included | 每一个 skip token)。
    const rows: CatalogPackageComponentV1[] = [
      ...(["root", "leaf"] as const).flatMap((role) =>
        [true, false].map((required) => ({
          componentId: `skill:${role}-${required}`,
          role,
          required,
          included: true,
          skipReasonCode: null,
        })),
      ),
      ...PACKAGE_COMPONENT_SKIP_REASONS_V1.map((skipReasonCode) => ({
        componentId: `skill:skipped-${skipReasonCode}`,
        role: "leaf" as const,
        required: false,
        included: false,
        skipReasonCode,
      })),
    ]
    // 每一种 skip token 都真的被走到(而不是「循环恰好空转」)。
    expect(
      rows.filter((row) => !row.included).map((row) => row.skipReasonCode),
      "每个 skip token 都要有一行喂进呈现层",
    ).toEqual([...PACKAGE_COMPONENT_SKIP_REASONS_V1])

    const keys = [
      ...mapped,
      ...rows.flatMap((row) => Object.values(packageComponentPresentation(row))),
    ].filter((key): key is string => typeof key === "string")
    // 逐字钉住这一面**全部**会被渲染的 key。下界式的 `>= 8` 会留出余量,少一个仍然全绿;
    // 这里对新成员默认拒绝 —— 新增一个组件行维度或一个 skip token 都必须显式过这一条。
    expect([...new Set(keys)].sort()).toEqual([
      "alpha.ext.packageComponentIncluded",
      "alpha.ext.packageComponentLeaf",
      "alpha.ext.packageComponentRoot",
      "alpha.ext.packageComponentSkipped",
      "alpha.ext.packageOptional",
      "alpha.ext.packageRequired",
      "alpha.ext.packageSkipCapabilityUnsupported",
      "alpha.ext.packageSkipMediaTypeMismatch",
      "alpha.ext.packageSkipProfileUnsupported",
    ])

    // ③ **存在且非空**,两个语种都要。`en[key]` 缺失时是 undefined —— 先判存在再 trim,
    //    否则抛的是 TypeError 而不是一条指得出是哪个 key 的断言失败。
    const missing = [...new Set(keys)].flatMap((key) => {
      const problems: string[] = []
      const english = (en as Record<string, string | undefined>)[key]
      const chinese = (zh as Record<string, string | undefined>)[key]
      if (typeof english !== "string" || english.trim() === "") problems.push(`${key} (en)`)
      if (typeof chinese !== "string" || chinese.trim() === "") problems.push(`${key} (zh)`)
      return problems
    })
    expect(
      missing,
      "缺翻译时 t() 回退到 key 本身 —— 用户会读到一行 alpha.ext.* 而不是一句话",
    ).toEqual([])
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
