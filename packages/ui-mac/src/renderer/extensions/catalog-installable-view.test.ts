import { describe, expect, test } from "bun:test"
import type { CatalogPackageViewV1 } from "../../shared/catalog-package-view"
import type { CatalogEntry } from "./catalog-types"
import { installableCatalogEntries, installableCatalogPackages } from "./catalog-installable-view"

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
      mcp("mcp:alpha-excel", "alpha-excel"),
      bundle("bundle:retired-id", "mcp:excel"),
      bundle("bundle:retired-alias", "mcp:legacy-excel-alias"),
      bundle("bundle:retired-command", "mcp:renamed-excel"),
      bundle("bundle:alpha-office", "mcp:alpha-excel"),
    ]

    expect(installableCatalogEntries(entries).map((entry) => entry.id)).toEqual([
      "mcp:alpha-excel",
      "bundle:alpha-office",
    ])
    expect(installableCatalogEntries([bundle("bundle:orphan-retired-reference", "mcp:excel")])).toEqual([])
  })

  test("preserves Alpha Excel and archived Word/PPT semantics without mutating the source view", () => {
    const entries = [
      mcp("mcp:alpha-excel", "alpha-excel"),
      mcp("mcp:word", "office-word-mcp-server"),
      mcp("mcp:powerpoint", "office-powerpoint-mcp-server"),
      bundle("bundle:alpha-office", "mcp:alpha-excel"),
      bundle("bundle:archived-office", "mcp:word"),
    ]
    const sourceIds = entries.map((entry) => entry.id)

    const installable = installableCatalogEntries(entries)
    expect(installable.map((entry) => entry.id)).toEqual([
      "mcp:alpha-excel",
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
      mcp("mcp:alpha-excel", "alpha-excel"),
    ]
    const packages = [
      packageView("mcp:excel", "mcp:safe"),
      packageView("package:retired-id", "mcp:excel"),
      packageView("package:retired-name", "mcp:excel-mcp-server"),
      packageView("package:retired-alias", "mcp:legacy-excel-alias"),
      packageView("package:retired-command", "mcp:renamed-excel"),
      packageView("package:retired-mirror-command", "mcp:renamed-excel-mirror"),
      packageView("package:alpha-office", "mcp:alpha-excel"),
    ]

    const installable = installableCatalogPackages(packages, entries)
    expect(installable.map((view) => view.catalogId)).toEqual(["package:alpha-office"])
    expect(packages).toHaveLength(7)
    expect(installable[0]).toBe(packages[6])
  })
})
