// REQ-103 slice 1(issue #195)—— ext-inventory 只读聚合面单测:既有真源(catalog/seed/账本)
// → 逐扩展五维 + 三态;join 规则(安装行/浏览行/seed-only 行)、global/project 同名分行(父 AC5)、
// REQ-105 advisory 贯通、v1-compat 面、输出 JSON 纯值(IPC 序列化就绪)与确定性排序。
// 真盘临时目录;纯模块直测,零 mock.module(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import type { InstallReceipt } from "../preload/types"
import { upsertRecordV2, type InstallRecordV2 } from "./ext-receipt-v2"
import { writeCapabilityGrantSync } from "./ext-capability-grants"
import {
  aggregateInventory,
  collectInventory,
  createInventoryQuery,
  type InventoryRow,
  type InventorySources,
} from "./ext-inventory"

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-inventory-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const entry = (over: Partial<CatalogEntry> & { id: string; type: CatalogEntry["type"]; name: string }): CatalogEntry => ({
  displayName: over.name,
  description: "fixture",
  source: "official",
  category: "test",
  ...over,
})

const record = (over: Partial<InstallRecordV2> & { id: string; name: string; kind: InstallRecordV2["kind"] }): InstallRecordV2 => ({
  schemaVersion: 2,
  environment: "prod",
  scope: { kind: "global" },
  desiredState: "enabled",
  generation: 1,
  origin: "catalog",
  installedAt: "2026-07-13T00:00:00.000Z",
  ...over,
})

const v1 = (over: Partial<InstallReceipt> & { id: string; name: string; type: InstallReceipt["type"] }): InstallReceipt => ({
  scope: "global",
  installedAt: "2026-07-13T00:00:00.000Z",
  origin: "catalog",
  ...over,
})

const byId = (rows: InventoryRow[], id: string, scope?: InventoryRow["scope"]) =>
  rows.filter((r) => r.id === id && (scope === undefined || r.scope === scope))

describe("aggregateInventory(纯函数核心)", () => {
  const CATALOG: InventorySources["catalog"] = {
    entries: [
      entry({ id: "mcp:word", type: "mcp", name: "office-word-mcp-server", source: "community", installSpec: { kind: "mcp", mcpType: "local" } }),
      entry({ id: "skill:writer", type: "skill", name: "writer", source: "alpha", installSpec: { kind: "skill", source: "builtin", targetDir: "alpha-skills" } }),
    ],
    channel: "remote",
    version: "9.9.9",
  }

  test("catalog-only 条目 → 浏览行:scope=null、availability=catalog、activation=not-installed、五维按 catalog 推导", () => {
    const view = aggregateInventory({ catalog: CATALOG, seedAssets: [], ledgers: [] })
    const row = byId(view.rows, "skill:writer")[0]!
    expect(row.scope).toBeNull()
    expect(row.availability.state).toBe("catalog")
    expect(row.activation).toBe("not-installed")
    expect(row.ownership.authored).toBe("alpha")
    expect(row.ownership.supportTier).toBe("alpha")
    expect(view.catalogVersion).toBe("9.9.9")
  })

  test("安装行 join catalog:五维与浏览面同源;activation 取 record.desiredState;不再另出浏览行", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [],
      ledgers: [
        {
          scope: "global",
          records: [record({ id: "skill:writer", name: "writer", kind: "skill", desiredState: "disabled", generation: 3, version: "1.2.0" })],
          v1Only: [],
          warnings: [],
        },
      ],
    })
    const rows = byId(view.rows, "skill:writer")
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.scope).toBe("global")
    expect(row.availability.state).toBe("installed")
    expect(row.availability.sources.catalog).toBe(true)
    expect(row.activation).toBe("disabled") // 已安装但关闭 ≠ 未安装(父 AC2)
    expect(row.health.state).toBe("ok")
    expect(row.ownership.authored).toBe("alpha")
    expect(row.generation).toBe(3)
    expect(row.version).toBe("1.2.0")
  })

  test("REQ-105 贯通:mcp:word 已安装且 enabled → health=degraded(archived),activation 不被塌缩", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [],
      ledgers: [
        { scope: "global", records: [record({ id: "mcp:word", name: "office-word-mcp-server", kind: "mcp" })], v1Only: [], warnings: [] },
      ],
    })
    const row = byId(view.rows, "mcp:word")[0]!
    expect(row.activation).toBe("enabled")
    expect(row.health.state).toBe("degraded")
    expect(row.health.issues[0]).toEqual({ kind: "archived-upstream", catalogId: "mcp:word", archivedAt: "2026-03-03" })
    expect(row.ownership.authored).toBe("community") // authored 如实,绝非 alpha(AC1)
  })

  test("REQ-105 贯通:mcp:word 未安装的浏览行同样带 archived(health ⊥ availability)", () => {
    const view = aggregateInventory({ catalog: CATALOG, seedAssets: [], ledgers: [] })
    const row = byId(view.rows, "mcp:word")[0]!
    expect(row.scope).toBeNull()
    expect(row.health.state).toBe("degraded")
  })

  test("global 与 project 同名安装 = 两行,scope 可区分、可单独判断(父 AC5)", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [],
      ledgers: [
        { scope: "global", records: [record({ id: "skill:writer", name: "writer", kind: "skill" })], v1Only: [], warnings: [] },
        {
          scope: "project",
          records: [
            record({
              id: "skill:writer",
              name: "writer",
              kind: "skill",
              desiredState: "disabled",
              scope: { kind: "project", projectPath: "/p", projectPathHash: "a".repeat(64) },
            }),
          ],
          v1Only: [],
          warnings: [],
        },
      ],
    })
    const rows = byId(view.rows, "skill:writer")
    expect(rows.map((r) => [r.scope, r.activation])).toEqual([
      ["global", "enabled"],
      ["project", "disabled"],
    ])
  })

  test("catalog 安装但条目已消失 → 五维如实降级(authored=unknown/tier=user),availability 无 catalog 来源", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [],
      ledgers: [{ scope: "global", records: [record({ id: "mcp:gone", name: "gone", kind: "mcp" })], v1Only: [], warnings: [] }],
    })
    const row = byId(view.rows, "mcp:gone")[0]!
    expect(row.ownership.authored).toBe("unknown")
    expect(row.ownership.supportTier).toBe("user")
    expect(row.availability.sources.catalog).toBe(false)
  })

  test("user-created MCP → 五维 user/user/engine-config;availability 仅 installed", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [],
      ledgers: [{ scope: "global", records: [record({ id: "user:my-mcp", name: "my-mcp", kind: "mcp", origin: "created" })], v1Only: [], warnings: [] }],
    })
    const row = byId(view.rows, "user:my-mcp")[0]!
    expect(row.ownership).toEqual({
      authored: "user",
      curated: "user",
      distributed: "engine-config",
      runtimeSurfaces: ["local-subprocess"],
      supportTier: "user",
    })
    expect(row.availability.sources).toEqual({ installed: true, bundled: false, catalog: false })
  })

  test("v1-only 存量 → activation=enabled(无 desired-state 通道)+ health=degraded(ledger-v1-compat)", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [],
      ledgers: [{ scope: "global", records: [], v1Only: [v1({ id: "skill:writer", name: "writer", type: "skill" })], warnings: [] }],
    })
    const row = byId(view.rows, "skill:writer")[0]!
    expect(row.scope).toBe("global")
    expect(row.activation).toBe("enabled")
    expect(row.health.issues[0]!.kind).toBe("ledger-v1-compat")
  })

  test("seed:catalog 同 id 条目的浏览行带 bundled 来源;seed-only 资产单独成行(bundled/未安装/unknown)", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [
        { id: "skill:writer", type: "skill", source: "alpha", platformCompatible: true },
        { id: "skill:seed-only", type: "skill", source: "official", platformCompatible: true },
        { id: "mcp:other-arch", type: "mcp", source: "official", platformCompatible: false },
      ],
      ledgers: [],
    })
    const inCatalog = byId(view.rows, "skill:writer")[0]!
    expect(inCatalog.availability.state).toBe("bundled")
    expect(inCatalog.availability.sources).toEqual({ installed: false, bundled: true, catalog: true })

    const seedOnly = byId(view.rows, "skill:seed-only")[0]!
    expect(seedOnly.scope).toBeNull()
    expect(seedOnly.name).toBe("seed-only")
    expect(seedOnly.ownership.distributed).toBe("bundled")
    expect(seedOnly.activation).toBe("not-installed")
    expect(seedOnly.health.state).toBe("unknown")

    // 平台不兼容的 seed 资产不可获得(bundledCompatible=false)。
    expect(byId(view.rows, "mcp:other-arch")[0]!.availability.state).toBe("unavailable")
  })

  test("输出为纯 JSON(IPC 序列化就绪):round-trip 深等;排序确定(id ↑,global<project<浏览行)", () => {
    const view = aggregateInventory({
      catalog: CATALOG,
      seedAssets: [{ id: "skill:seed-only", type: "skill", source: "alpha", platformCompatible: true }],
      ledgers: [
        { scope: "global", records: [record({ id: "skill:writer", name: "writer", kind: "skill" })], v1Only: [], warnings: ["w1"] },
      ],
    })
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
    expect(view.warnings).toContain("w1")
    const ids = view.rows.map((r) => r.id)
    expect(ids).toEqual([...ids].sort())
  })
})

describe("collectInventory(薄采集器,零写入)", () => {
  test("真盘账本(global v2 + project v2)聚合;seed 缺失/项目根非法如实进 warnings", () => {
    const globalRoot = path.join(tmp, "global")
    const projectDir = path.join(tmp, "project")
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.mkdirSync(path.join(projectDir, ".code-puppy"), { recursive: true })

    const g = upsertRecordV2(globalRoot, {
      id: "user:my-mcp",
      name: "my-mcp",
      kind: "mcp",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "created",
      installedAt: "2026-07-13T00:00:00.000Z",
    })
    expect(g.ok).toBe(true)
    const p = upsertRecordV2(path.join(projectDir, ".code-puppy"), {
      id: "skill:writer",
      name: "writer",
      kind: "skill",
      environment: "prod",
      scope: { kind: "project", projectPath: projectDir, projectPathHash: "b".repeat(64) },
      desiredState: "disabled",
      origin: "catalog",
      installedAt: "2026-07-13T00:00:00.000Z",
    })
    expect(p.ok).toBe(true)

    const view = collectInventory({
      catalog: { entries: [entry({ id: "skill:writer", type: "skill", name: "writer", source: "alpha" })], channel: "cache", version: "1.0.0" },
      seedDir: path.join(tmp, "no-such-seed"),
      globalRoot,
      projectDir,
    })

    expect(byId(view.rows, "user:my-mcp", "global")).toHaveLength(1)
    const proj = byId(view.rows, "skill:writer", "project")[0]!
    expect(proj.activation).toBe("disabled")
    expect(proj.ownership.authored).toBe("alpha")
    expect(view.warnings.some((w) => w.startsWith("packaged seed unavailable:"))).toBe(true)

    // 采集是只读的:两本账本文件内容不因聚合而改变。
    const before = fs.readFileSync(path.join(globalRoot, "installs.json"), "utf8")
    collectInventory({ catalog: null, globalRoot, projectDir })
    expect(fs.readFileSync(path.join(globalRoot, "installs.json"), "utf8")).toBe(before)
  })

  test("非法 projectDir → fail-closed 跳过项目账本并 loud 进 warnings(绝不退化)", () => {
    const globalRoot = path.join(tmp, "global2")
    fs.mkdirSync(globalRoot, { recursive: true })
    const view = collectInventory({ catalog: null, globalRoot, projectDir: path.join(tmp, "does-not-exist") })
    expect(view.rows).toEqual([])
    expect(view.warnings.some((w) => w.includes("project ledger skipped"))).toBe(true)
  })
})

// ── REQ-103 slice 2a(#195):createInventoryQuery —— IPC 通道核心的只读契约 ────────────────────

/** 目录树快照(relpath → 字节):零写入断言用 —— 查询前后必须逐字节一致。 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else out[path.relative(root, abs)] = fs.readFileSync(abs, "latin1")
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

describe("createInventoryQuery(IPC 通道核心:只读、fail-closed、纯 JSON)", () => {
  function seedGlobalLedger(globalRoot: string): void {
    fs.mkdirSync(globalRoot, { recursive: true })
    const g = upsertRecordV2(globalRoot, {
      id: "user:my-mcp",
      name: "my-mcp",
      kind: "mcp",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "created",
      installedAt: "2026-07-13T00:00:00.000Z",
    })
    expect(g.ok).toBe(true)
  }

  test("输出 = collectInventory 同输入等价;JSON round-trip 纯值(结构化克隆安全)", async () => {
    const globalRoot = path.join(tmp, "gq-root")
    seedGlobalLedger(globalRoot)
    const catalog = {
      entries: [entry({ id: "skill:writer", type: "skill", name: "writer", source: "alpha" })],
      channel: "cache" as const,
      version: "1.0.0",
    }
    const query = createInventoryQuery({ resolveCatalog: async () => catalog, seedDir: null, globalRoot: () => globalRoot })
    const view = await query(undefined)
    expect(view).toEqual(collectInventory({ catalog, seedDir: null, globalRoot }))
    expect(JSON.parse(JSON.stringify(view))).toEqual(view as never) // 零函数/句柄/undefined 孔洞
    expect(byId(view.rows, "user:my-mcp", "global")).toHaveLength(1)
  })

  test("catalog resolve 抛错 → catalog=null + loud warning,账本行照常(不清零其它真源)", async () => {
    const globalRoot = path.join(tmp, "gq-cat-fail")
    seedGlobalLedger(globalRoot)
    const query = createInventoryQuery({
      resolveCatalog: async () => {
        throw new Error("network down")
      },
      seedDir: null,
      globalRoot: () => globalRoot,
    })
    const view = await query()
    expect(view.catalogVersion).toBeNull()
    expect(view.catalogChannel).toBeNull()
    expect(view.warnings.some((w) => w.includes("catalog unavailable: network down"))).toBe(true)
    expect(byId(view.rows, "user:my-mcp", "global")).toHaveLength(1)
  })

  test("敌意 projectDir 输入(非 string / 对象 / 数字)→ 如实丢弃 + warning,绝不抛错", async () => {
    const globalRoot = path.join(tmp, "gq-hostile")
    seedGlobalLedger(globalRoot)
    const query = createInventoryQuery({ resolveCatalog: async () => null, seedDir: null, globalRoot: () => globalRoot })
    for (const hostile of [42, { projectDir: "/etc" }, ["/etc"], true, ""]) {
      const view = await query(hostile as never)
      expect(byId(view.rows, "user:my-mcp", "global")).toHaveLength(1) // global 面不受影响
      if (hostile !== "") expect(view.warnings.some((w) => w.includes("projectDir ignored"))).toBe(true)
      expect(view.rows.every((r) => r.scope !== "project")).toBe(true)
    }
  })

  test("负向:查询面零写入 —— 全根目录树(账本/一切)查询前后逐字节一致,含敌意输入", async () => {
    const globalRoot = path.join(tmp, "gq-ro")
    const projectDir = path.join(tmp, "gq-ro-project")
    seedGlobalLedger(globalRoot)
    fs.mkdirSync(path.join(projectDir, ".code-puppy"), { recursive: true })
    const p = upsertRecordV2(path.join(projectDir, ".code-puppy"), {
      id: "skill:writer",
      name: "writer",
      kind: "skill",
      environment: "prod",
      scope: { kind: "project", projectPath: projectDir, projectPathHash: "b".repeat(64) },
      desiredState: "disabled",
      origin: "catalog",
      installedAt: "2026-07-13T00:00:00.000Z",
    })
    expect(p.ok).toBe(true)

    const before = snapshotTree(tmp)
    const query = createInventoryQuery({
      resolveCatalog: async () => ({ entries: [], channel: "bundled" as const, version: "0" }),
      seedDir: path.join(tmp, "no-seed"),
      globalRoot: () => globalRoot,
    })
    await query(projectDir)
    await query(path.join(tmp, "does-not-exist"))
    await query({ evil: true } as never)
    await query()
    expect(snapshotTree(tmp)).toEqual(before)
  })
})

// ── #392(REQ-103):已授权能力 join —— grants/<key>.json 只读进 InventoryRow.granted ──────────────

describe("#392 已授权能力聚合(grants join,只读)", () => {
  const grant = { capabilities: ["network:remote"], grantedAt: "2026-07-16T00:00:00.000Z", txId: "tx-a" }

  test("aggregateInventory:按 <kind>--<name> join;无记录行不出 granted 字段;global/project 各取各账;空能力集如实保留([] ≠ 无记录)", () => {
    const projGrant = { capabilities: [], grantedAt: "2026-07-17T00:00:00.000Z", txId: "tx-b" }
    const view = aggregateInventory({
      catalog: null,
      seedAssets: [],
      ledgers: [
        {
          scope: "global",
          records: [record({ id: "mcp:fetch", name: "fetch", kind: "mcp" }), record({ id: "skill:writer", name: "writer", kind: "skill" })],
          v1Only: [],
          warnings: [],
          grants: { "mcp--fetch": grant },
        },
        {
          scope: "project",
          records: [
            record({
              id: "user:writer",
              name: "writer",
              kind: "skill",
              origin: "imported",
              scope: { kind: "project", projectPath: "/p", projectPathHash: "b".repeat(64) },
            }),
          ],
          v1Only: [],
          warnings: [],
          grants: { "skill--writer": projGrant },
        },
      ],
    })
    expect(byId(view.rows, "mcp:fetch", "global")[0]!.granted).toEqual(grant)
    // global writer 无授权记录 —— 不回填、不借 project 同名账。
    expect(byId(view.rows, "skill:writer", "global")[0]!.granted).toBeUndefined()
    expect(byId(view.rows, "user:writer", "project")[0]!.granted).toEqual(projGrant)
  })

  test("v1-only 存量行恒无 granted(早于 #348 闸口;即便 grants map 里有同 key 也不回填)", () => {
    const view = aggregateInventory({
      catalog: null,
      seedAssets: [],
      ledgers: [{ scope: "global", records: [], v1Only: [v1({ id: "mcp:old", name: "old", type: "mcp" })], warnings: [], grants: { "mcp--old": grant } }],
    })
    expect(byId(view.rows, "mcp:old", "global")[0]!.granted).toBeUndefined()
  })

  test("collectInventory:真盘 grant 随行返回(global+project);孤儿 grant(无账本记录)不进读面;坏 JSON 如实无记录", () => {
    const globalRoot = path.join(tmp, "g392")
    const projectDir = path.join(tmp, "p392")
    const projectRoot = path.join(projectDir, ".code-puppy")
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.mkdirSync(projectRoot, { recursive: true })

    expect(upsertRecordV2(globalRoot, record({ id: "user:my-mcp", name: "my-mcp", kind: "mcp", origin: "created" })).ok).toBe(true)
    expect(
      upsertRecordV2(
        projectRoot,
        record({
          id: "user:writer",
          name: "writer",
          kind: "skill",
          origin: "imported",
          scope: { kind: "project", projectPath: projectDir, projectPathHash: "b".repeat(64) },
        }),
      ).ok,
    ).toBe(true)
    writeCapabilityGrantSync(globalRoot, { v: 1, key: "mcp--my-mcp", capabilities: ["network:remote"], txId: "tx-g", grantedAt: "2026-07-17T01:00:00.000Z" })
    writeCapabilityGrantSync(projectRoot, { v: 1, key: "skill--writer", capabilities: ["prompt:context"], txId: "tx-p", grantedAt: "2026-07-17T02:00:00.000Z" })
    // 孤儿 grant:账本无此 record —— 不得凭空造行/附着到别的行。
    writeCapabilityGrantSync(globalRoot, { v: 1, key: "skill--ghost", capabilities: ["engine:plugin"], txId: "tx-x", grantedAt: "2026-07-17T03:00:00.000Z" })

    const view = collectInventory({ catalog: null, globalRoot, projectDir })
    expect(byId(view.rows, "user:my-mcp", "global")[0]!.granted).toEqual({ capabilities: ["network:remote"], grantedAt: "2026-07-17T01:00:00.000Z", txId: "tx-g" })
    expect(byId(view.rows, "user:writer", "project")[0]!.granted).toEqual({ capabilities: ["prompt:context"], grantedAt: "2026-07-17T02:00:00.000Z", txId: "tx-p" })
    expect(view.rows.some((r) => r.id.includes("ghost") || r.name.includes("ghost"))).toBe(false)

    // 坏 JSON 的 grant 文件 → 该行如实无 granted(readCapabilityGrant 容错返回 null,不抛、不进 warnings 噪音)。
    fs.writeFileSync(path.join(globalRoot, "ext-store", "mcp--my-mcp", "grants.json"), "{not json")
    const view2 = collectInventory({ catalog: null, globalRoot, projectDir })
    expect(byId(view2.rows, "user:my-mcp", "global")[0]!.granted).toBeUndefined()
  })
})
