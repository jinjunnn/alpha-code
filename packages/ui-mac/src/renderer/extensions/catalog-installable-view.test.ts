import { describe, expect, test } from "bun:test"
import { createMemo } from "solid-js"
import { toV1Receipt, type InstallRecordV2 } from "../../main/ext-receipt-v2"
import type { CatalogPackageViewV1 } from "../../shared/catalog-package-view"
import { CURATION_SCHEMA_ID, decodeEntryCuration, INTAKE_PROVENANCE_SCHEMA_ID } from "../../shared/catalog-curation"
import type { Catalog, CatalogEntry } from "./catalog-types"
import { installableCatalogEntries, installableCatalogPackages } from "./catalog-installable-view"
import { nameOnlyLiveMcpIsUnambiguousGlobal, sdkMcpStatusForReceipt } from "./use-extensions"
import oldCatalog from "./testvectors/d5-old-catalog.json"
import oldPackageView from "./testvectors/d5-package-view.json"
import installedRecord from "./testvectors/d5-installed-record.json"

const mcp = (id: string, name: string, packageName = name): CatalogEntry => ({
  id,
  type: "mcp",
  name,
  displayName: name,
  description: name,
  source: "community",
  category: "office",
  installSpec: { kind: "mcp", mcpType: "local", command: ["uvx", `${packageName}@1.0.0`] },
})

const bundle = (id: string, catalogEntryId: string): CatalogEntry => ({
  id,
  type: "bundle",
  name: id.slice("bundle:".length),
  displayName: id,
  description: id,
  source: "alpha",
  category: "office",
  bundleItems: [{ catalogEntryId, optional: false, installOrder: 1 }],
})

const packageView = (catalogId: string, ...componentIds: string[]): CatalogPackageViewV1 => ({
  catalogId,
  verdict: "compatible",
  action: { kind: "install", enabled: true, reasonCode: "package-compatible" },
  components: componentIds.map((componentId, index) => ({
    componentId,
    role: index === 0 ? "root" : "leaf",
    required: true,
    included: true,
    skipReasonCode: null,
  })),
  prerequisites: { status: "ready", items: [] },
  presentation: { displayName: catalogId, description: catalogId, version: "1.0.0" },
})

describe("installableCatalogEntries(REQ-135 Hub retirement view)", () => {
  test("excludes retired identities and bundles that reference their ids", () => {
    const entries = [
      mcp("mcp:excel", "legacy-by-id"),
      mcp("mcp:legacy-excel-alias", "excel-mcp-server"),
      mcp("mcp:renamed-excel", "renamed-sheets", "excel-mcp-server"),
      mcp("mcp:codepuppy-excel", "codepuppy-excel"),
      bundle("bundle:retired-id", "mcp:excel"),
      bundle("bundle:retired-alias", "mcp:legacy-excel-alias"),
      bundle("bundle:retired-command", "mcp:renamed-excel"),
      bundle("bundle:alpha-office", "mcp:codepuppy-excel"),
    ]

    expect(installableCatalogEntries(entries).map((entry) => entry.id)).toEqual([
      "mcp:codepuppy-excel",
      "bundle:alpha-office",
    ])
    expect(installableCatalogEntries([bundle("bundle:orphan-retired-reference", "mcp:excel")])).toEqual([])
  })

  test("preserves unrelated Office identities without mutating the source view", () => {
    const entries = [
      mcp("mcp:codepuppy-excel", "codepuppy-excel"),
      mcp("mcp:word", "office-word-mcp-server"),
      mcp("mcp:powerpoint", "office-powerpoint-mcp-server"),
      bundle("bundle:alpha-office", "mcp:codepuppy-excel"),
      bundle("bundle:archived-office", "mcp:word"),
    ]
    const sourceIds = entries.map((entry) => entry.id)

    const installable = installableCatalogEntries(entries)
    expect(installable.map((entry) => entry.id)).toEqual([
      "mcp:codepuppy-excel",
      "mcp:word",
      "mcp:powerpoint",
      "bundle:alpha-office",
      "bundle:archived-office",
    ])
    expect(entries.map((entry) => entry.id)).toEqual(sourceIds)
    expect(installable[0]).toBe(entries[0])
  })

  test("excludes package views that reference retired ids, names, or renamed local commands", () => {
    const entries = [
      mcp("mcp:legacy-excel-alias", "excel-mcp-server"),
      mcp("mcp:renamed-excel", "renamed-sheets", "excel-mcp-server"),
      {
        ...mcp("mcp:renamed-excel-mirror", "renamed-mirror", "safe-mcp-server"),
        installSpec: {
          kind: "mcp" as const,
          mcpType: "local" as const,
          command: ["uvx", "safe-mcp-server@1.0.0"],
          mirrorCommand: ["uvx", "excel-mcp-server@1.0.0"],
        },
      },
      mcp("mcp:codepuppy-excel", "codepuppy-excel"),
    ]
    const packages = [
      packageView("mcp:excel", "mcp:safe"),
      packageView("package:retired-id", "mcp:excel"),
      packageView("package:retired-name", "mcp:excel-mcp-server"),
      packageView("package:retired-alias", "mcp:legacy-excel-alias"),
      packageView("package:retired-command", "mcp:renamed-excel"),
      packageView("package:retired-mirror-command", "mcp:renamed-excel-mirror"),
      packageView("package:alpha-office", "mcp:codepuppy-excel"),
    ]

    const installable = installableCatalogPackages(packages, entries)
    expect(installable.map((view) => view.catalogId)).toEqual(["package:alpha-office"])
    expect(packages).toHaveLength(7)
    expect(installable[0]).toBe(packages[6])
  })
})

// Minimized from D5-evidence/owner-catalog.json (2026-08-31.2, signed SHA-256
// 400e27a11d06e21ac1719e48fc1a8919955148b2f4117cd1ecabec20d7cb2562).
// Package view: catalog-evaluation.json; installed record: skill-active-result.json.
// Counterexamples below mutate those captured shapes; they are not invented wire fixtures.
//
// alpha-web#283:样本早于契约 ID 改名,五条策展记录写的是 `alpha.catalog.curation.v1` 与
// `alpha.intake-provenance.v1+json`,消费端如今只认 `codepuppy.*`(旧 ID = invalid,见下面 AC1 那条用例)。
// 这里研究的是条目形状与 Hub 视图,不是 ID,所以加载时只把这两个 ID 换成现行值,其余逐字取自样本;
// 样本文件本身不动。
const captured = oldCatalog as unknown as Catalog
const PREVIOUS_CURATION_SCHEMA_ID = "alpha.catalog.curation.v1"
const old = JSON.parse(
  JSON.stringify(captured)
    .replaceAll(`"${PREVIOUS_CURATION_SCHEMA_ID}"`, `"${CURATION_SCHEMA_ID}"`)
    .replaceAll('"alpha.intake-provenance.v1+json"', `"${INTAKE_PROVENANCE_SCHEMA_ID}+json"`),
) as Catalog
const safePackage = oldPackageView as CatalogPackageViewV1
const git = old.entries.find((entry) => entry.id === "mcp:git")!
const github = old.entries.find((entry) => entry.id === "mcp:github")!
const dev = old.entries.find((entry) => entry.id === "bundle:dev")!
const githubWithoutNote = {
  ...github,
  installSpec: { ...github.installSpec!, _verify: undefined },
}
const active = decodeEntryCuration(git)
if (active.kind !== "curated") throw new Error("D5 Git must carry valid active curation")

const entryCounterexamples = [
  { name: "archived without a verify note", entry: githubWithoutNote, blocked: [] },
  ...["unmaintained", "unknown"].map((upstreamStatus) => ({
    name: `upstream ${upstreamStatus}`,
    entry: { ...git, curation: { ...active.curation, review: { ...active.curation.review, upstreamStatus } } },
    blocked: [],
  })),
  { name: "invalid curation", entry: { ...git, curation: { ...active.curation, schema: "invalid" } }, blocked: [] },
  { name: "entry verify note", entry: { ...git, _verify: github.installSpec!._verify }, blocked: [] },
  {
    name: "installSpec verify note",
    entry: { ...git, installSpec: { ...git.installSpec!, _verify: github.installSpec!._verify } },
    blocked: [],
  },
  { name: "security advisory", entry: git, blocked: [git.id] },
]

const retained = old.entries.find((entry) => entry.id === "skill:mcp-builder")!
const counterexamples = [
  ...entryCounterexamples.map((sample) => ({
    name: sample.name,
    entries: [sample.entry, { ...dev, bundleItems: [{ ...dev.bundleItems![1]!, catalogEntryId: sample.entry.id }] }],
    views: [
      {
        ...safePackage,
        catalogId: "package:unavailable",
        components: [{ ...safePackage.components[0]!, componentId: sample.entry.id }],
      },
    ],
    blocked: sample.blocked,
  })),
  ...["dangling", "bundle", "empty"].map((kind) => ({
    name: `${kind} bundle members`,
    entries: [
      {
        ...dev,
        bundleItems:
          kind === "empty"
            ? []
            : [
                {
                  ...dev.bundleItems![1]!,
                  catalogEntryId: kind === "bundle" ? dev.id : "mcp:missing",
                },
              ],
      },
    ],
    views: [
      {
        ...safePackage,
        catalogId: "package:unavailable",
        components: [{ ...safePackage.components[0]!, componentId: dev.id }],
      },
    ],
    blocked: [],
  })),
  ...[
    { ...safePackage, verdict: "blocked", action: { kind: "none", enabled: false, reasonCode: "package-invalid" } },
    {
      ...safePackage,
      verdict: "update-required",
      action: { kind: "update-alpha", enabled: true, reasonCode: "package-host-update-required" },
    },
    { ...safePackage, action: { ...safePackage.action, enabled: false } },
  ].map((view) => ({
    name: `package ${view.verdict}/${view.action.kind}/${view.action.enabled}`,
    entries: [],
    views: [{ ...view, catalogId: "package:unavailable" }],
    blocked: [],
  })),
  {
    name: "package security advisory",
    entries: [],
    views: [{ ...safePackage, catalogId: "package:unavailable" }],
    blocked: ["package:unavailable"],
  },
]

describe("alpha-web#255 old-cache installable view", () => {
  test("alpha-web#283 AC1: the captured curation record under the previous-brand schema ID is refused", () => {
    const capturedGit = captured.entries.find((entry) => entry.id === "mcp:git")!
    expect((capturedGit.curation as { schema?: unknown }).schema).toBe(PREVIOUS_CURATION_SCHEMA_ID)
    expect(decodeEntryCuration(capturedGit).kind).toBe("invalid")
    expect(decodeEntryCuration(git).kind).toBe("curated")
  })

  test("AC3 hides D5 GitHub, DBHub, unresolved notes and the dev bundle without changing signed data", () => {
    const before = JSON.stringify(old)
    expect(installableCatalogEntries(old.entries).map((entry) => entry.id)).toEqual(["mcp:git", "skill:mcp-builder"])
    const packages = [
      safePackage,
      ...["mcp:github", "mcp:dbhub", "bundle:dev"].map((componentId) => ({
        ...safePackage,
        catalogId: `package:${componentId.split(":")[1]}`,
        components: [{ ...safePackage.components[0]!, componentId }],
      })),
    ]
    expect(installableCatalogPackages(packages, old.entries)).toEqual([safePackage])
    expect(JSON.stringify(old)).toBe(before)
  })

  test.each(counterexamples)("AC4 remote/cache/builtin share the Hub view: $name", (sample) => {
    const input = {
      version: old.version,
      entries: [retained, ...sample.entries],
      packages: oldCatalog.packages,
    }
    const views = [safePackage, ...sample.views]
    // Isolate catalog-source's module signals and IPC mock from the other renderer tests.
    // Execute the production Hub declarations so forgetting to pass advisory IDs also goes red.
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
      import { expect, mock } from "bun:test"
      import { createMemo } from "solid-js"
      import { installableCatalogEntries, installableCatalogPackages } from "./catalog-installable-view"
      import { projectRemoteCatalogForRenderer } from "../../main/remote-catalog"
      const input = ${JSON.stringify(input)}
      const views = ${JSON.stringify(views)}
      mock.module("./alpha-catalog.json", () => ({ default: input }))
      const queue = ["remote", "cache"]
      mock.module("./ext-ipc", () => ({ extIpc: { remoteCatalog: async () => projectRemoteCatalogForRenderer({
        source: queue.shift(), catalog: input, packageViews: views, version: input.version,
        fetchedAt: "2026-10-13T02:00:00Z", via: "v1", channel: "stable",
      }) } }))
      const { catalog, catalogSource, refreshCatalog } = await import("./catalog-source")
      const source = await Bun.file("./extension-hub.tsx").text()
      const wiring = source.slice(source.indexOf("  const installableEntries ="), source.indexOf("  const byType ="))
      const view = new Function("catalog", "advisoryBlocked", "createMemo", "installableCatalogEntries", "installableCatalogPackages",
        new Bun.Transpiler({ loader: "ts" }).transformSync(wiring) + "return [installableEntries(), installablePackages()]")
      for (const channel of ["builtin", "remote", "cache"]) {
        if (channel !== "builtin") await refreshCatalog()
        expect(catalogSource()).toBe(channel)
        expect(catalog().entries).toEqual(input.entries)
        expect(view(catalog, () => new Set(${JSON.stringify(sample.blocked)}), createMemo,
          installableCatalogEntries, installableCatalogPackages)).toEqual([[input.entries[0]], channel === "builtin" ? [] : [views[0]]])
      }
    `,
      ],
      { cwd: import.meta.dir },
    )
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  })

  test("AC3 installed archived GitHub remains in the production installed view with its receipt", async () => {
    const source = await Bun.file(new URL("./extension-hub.tsx", import.meta.url)).text()
    const lookup = source.match(/  const byId =[^\n]+/)![0]
    const projection = source.slice(source.indexOf("  const installedAll ="), source.indexOf("  // REQ-103(#195,AC5)"))
    const installed = new Function(
      "catalog",
      "ext",
      "createMemo",
      "sdkMcpStatusForReceipt",
      "nameOnlyLiveMcpIsUnambiguousGlobal",
      new Bun.Transpiler({ loader: "ts" }).transformSync(lookup + "\n" + projection) + "return installedAll()",
    )
    // Mutation of the real D5 installed record: same ledger shape, archived GitHub identity.
    const receipt = toV1Receipt({
      ...installedRecord,
      id: github.id,
      name: github.name,
      kind: "mcp",
    } as InstallRecordV2)
    const rows = installed(
      () => old,
      { store: { receipts: [receipt], projectReceipts: [], mcp: {} } },
      createMemo,
      sdkMcpStatusForReceipt,
      nameOnlyLiveMcpIsUnambiguousGlobal,
    )
    expect(installableCatalogEntries(old.entries)).not.toContain(github)
    expect(rows).toHaveLength(1)
    expect(rows[0].entry).toBe(github)
    expect(rows[0].displayName).toBe(github.displayName)
    expect(rows[0].receipt).toBe(receipt)
    expect(receipt.name).toBe("github") // management/uninstall still receives the original key
  })
})
