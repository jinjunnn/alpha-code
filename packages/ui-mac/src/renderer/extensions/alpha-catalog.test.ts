// alpha-catalog 完整性单测(S23 补,E2/E6 上架时立)—— 把 S22 人工核对的「bundle 引用零悬空 /
// 钉版本纪律(A2)」固化为回归锁。catalog 是 JSON 数据,漂移(悬空引用/漏钉版本)此前只能靠人眼。
// S24(REQ-046)追加快照守卫:内置 catalog = C 已发布产物的字节级快照,禁手编。

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import rawCatalog from "./alpha-catalog.json"
import snapshotMeta from "./alpha-catalog.snapshot.json"
import type { Catalog, CatalogEntry, McpInstallSpec } from "./catalog-types"
import { ARCHIVED_OFFICE_ADVISORIES, EXCEL_MCP_PIN, checkExcelMcpSafety } from "../../shared/office-advisories"

const catalog = rawCatalog as unknown as Catalog

describe("快照守卫(REQ-046 禁手编)", () => {
  test("alpha-catalog.json 字节级等于最近一次快照(手编即红;刷新 = bun ui-mac scripts/sync-catalog-snapshot.mjs)", () => {
    const body = readFileSync(join(import.meta.dir, "alpha-catalog.json"))
    expect(createHash("sha256").update(body).digest("hex")).toBe(snapshotMeta.sha256)
    expect(catalog.version).toBe(snapshotMeta.version)
    expect(catalog.entries.length).toBe(snapshotMeta.entries)
  })
})

describe("alpha-catalog 完整性", () => {
  test("entry id 唯一", () => {
    const ids = catalog.entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("bundle 引用零悬空,且不引用其它 bundle", () => {
    const byId = new Map(catalog.entries.map((e) => [e.id, e]))
    for (const entry of catalog.entries.filter((e) => e.type === "bundle")) {
      expect(entry.bundleItems?.length).toBeGreaterThan(0)
      for (const item of entry.bundleItems!) {
        const target = byId.get(item.catalogEntryId)
        expect(target, `${entry.id} → ${item.catalogEntryId} 悬空`).toBeDefined()
        expect(target!.type).not.toBe("bundle")
      }
    }
  })

  test("MCP local 条目:npx/uvx 包全部钉精确版本(A2 纪律),mirrorCommand 与主命令同包同版", () => {
    const pinned = /@\d+\.\d+\.\d+([-.a-z0-9]*)?$/i
    for (const entry of catalog.entries.filter((e) => e.type === "mcp")) {
      const spec = entry.installSpec as McpInstallSpec
      if (spec.mcpType !== "local") continue
      const pkg = packageArg(spec.command!)
      expect(pkg, `${entry.id} 主命令缺包参数`).toBeDefined()
      expect(pinned.test(pkg!), `${entry.id} 未钉版本:${pkg}`).toBe(true)
      if (spec.mirrorCommand) {
        expect(packageArg(spec.mirrorCommand), `${entry.id} mirror 与主命令包/版本不一致`).toBe(pkg)
      }
    }
  })

  test("可安装条目必带 installSpec;requiredEnvVars 是合法 env 名(密钥经 {file:} 采集的前提)", () => {
    const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
    for (const entry of catalog.entries) {
      if (entry.type === "bundle") continue
      expect(entry.installSpec, `${entry.id} 缺 installSpec`).toBeDefined()
      const vars = (entry.installSpec as { requiredEnvVars?: string[] }).requiredEnvVars ?? []
      for (const v of vars) expect(envName.test(v), `${entry.id} 非法 env 名:${v}`).toBe(true)
    }
  })

  test("REQ-044 撤下的三条目只允许经远程通道回流(REQ-045 补货,禁 builtin 复活)", () => {
    // S26 补货后条目合法在场,但必须是 source:"remote"(资产经 C 端点下载 + sha256 钉死);
    // builtinAssetKey 形态 = 资产未随包的恒失败老路,永不回流。bundle:design 成员必须全为远程技能。
    const restocked = ["skill:mcp-builder", "skill:canvas-design", "skill:brand-guidelines"]
    for (const id of restocked) {
      const e = catalog.entries.find((x) => x.id === id)
      expect(e, `${id} 应随 REQ-045 补货在场`).toBeTruthy()
      const spec = e!.installSpec as { source?: string; builtinAssetKey?: string }
      expect(spec.source, `${id} 只允许远程通道`).toBe("remote")
      expect(spec.builtinAssetKey, `${id} 不得携带 builtinAssetKey(builtin 复活即回归恒失败)`).toBeUndefined()
      expect(e!.remoteAsset?.files?.length ?? 0, `${id} 必须带 remoteAsset 清单`).toBeGreaterThan(0)
    }
    const design = catalog.entries.find((x) => x.id === "bundle:design")
    expect(design, "bundle:design 成员齐后回归(REQ-045 验收④)").toBeTruthy()
    const memberIds = (design!.bundleItems ?? []).map((i) => i.catalogEntryId)
    expect(memberIds.sort()).toEqual(["skill:brand-guidelines", "skill:canvas-design"])
  })

  test("S23 存量条目:mcp:dbhub(E6)在场且只读档;中国办公三件套随 REQ-081 退役不在场", () => {
    const ids = new Set(catalog.entries.map((e) => e.id))
    expect(ids.has("mcp:dbhub")).toBe(true)
    // dbhub 只读档:--readonly 必须在命令里(0.12.0 CLI 档;丢失=静默变可写,supply-chain 回归锁)
    const dbhub = catalog.entries.find((e) => e.id === "mcp:dbhub")!
    const spec = dbhub.installSpec as McpInstallSpec
    expect(spec.command).toContain("--readonly")
    expect(spec.mirrorCommand).toContain("--readonly")
    // S23 同批上架的 dingtalk(E2)及 feishu/yuque/bundle:china-office 已于 2026-07-09 随
    // REQ-081 从 C 端 catalog 退役(产品拍板「接入形态未想清楚,先下架」,git 留档可重上架);
    // 2026-07-13.1 快照刷新起不在场是正确现实。未来 conscious 重上架时连同本断言一起更新
    // (参照上方 REQ-045 补货测试的形态)。
    for (const retired of ["mcp:dingtalk", "mcp:feishu", "mcp:yuque", "bundle:china-office"]) {
      expect(ids.has(retired), `${retired} 已随 REQ-081 退役;重上架须显式更新本断言`).toBe(false)
    }
  })
})

// REQ-105(#197)Office 纠偏守卫:离线 seed(内置快照)是远程 catalog 的回退底座 —— 归档
// Word/PPT 一旦混进来,离线/回退路径会把不再维护的连接器重新推给新用户。快照刷新走
// sync-catalog-snapshot.mjs(字节级复制 C 已发布产物),所以这组断言实质上是对「未来快照」的
// 准入闸:C 端(alpha-web#21)不下架,A 端快照就刷不进来。
describe("REQ-105 Office 纠偏守卫(归档连接器禁入离线 seed;Excel 锁审计版本)", () => {
  const rawText = readFileSync(join(import.meta.dir, "alpha-catalog.json"), "utf8")

  test("归档 Word/PPT 连接器不得出现在内置快照(catalog id + pypi 包名逐字扫描)", () => {
    for (const adv of ARCHIVED_OFFICE_ADVISORIES) {
      expect(
        catalog.entries.some((e) => e.id === adv.catalogId),
        `${adv.catalogId} 已归档(${adv.archivedAt}),不得进离线 seed`,
      ).toBe(false)
      expect(rawText.includes(adv.pypiPackage), `${adv.pypiPackage} 已归档,不得以任何形态进离线 seed`).toBe(false)
    }
  })

  test("bundle:office 成员不含归档连接器(默认 Office 套件不预缓存)", () => {
    const office = catalog.entries.find((e) => e.id === "bundle:office")
    expect(office, "bundle:office 应在场(markitdown+filesystem 底座)").toBeTruthy()
    const banned = new Set(ARCHIVED_OFFICE_ADVISORIES.map((a) => a.catalogId))
    for (const item of office!.bundleItems ?? []) {
      expect(banned.has(item.catalogEntryId), `bundle:office → ${item.catalogEntryId} 已归档`).toBe(false)
    }
  })

  test("excel-mcp-server 在场且精确钉审计版本、通过 sandbox 闸口(升级不重审计即红)", () => {
    // 2026-07-13.1 快照起 mcp:excel 在场(C 端纠偏 alpha-web 上架后刷入,REQ-105 收口)。
    // 先锁在场 —— 否则条目静默消失会让下方钉版/闸口断言退化为空转;再对每个引用 excel 包的
    // 命令断言:版本逐字 = EXCEL_MCP_PIN.pinnedSpec(0.1.8 审计记录),local stdio、零 host/port 绑定。
    expect(
      catalog.entries.some((e) => e.id === EXCEL_MCP_PIN.catalogId),
      `${EXCEL_MCP_PIN.catalogId} 应在场(2026-07-13.1 快照携带审计钉版条目)`,
    ).toBe(true)
    for (const entry of catalog.entries.filter((e) => e.type === "mcp")) {
      const spec = entry.installSpec as McpInstallSpec
      const cmds = [...(spec.command ?? []), ...(spec.mirrorCommand ?? [])]
      if (!cmds.some((a) => a.includes(EXCEL_MCP_PIN.pypiPackage))) continue
      expect(spec.mcpType, `${entry.id} 仅允许 local stdio`).toBe("local")
      expect(spec.command, `${entry.id} 必须钉 ${EXCEL_MCP_PIN.pinnedSpec}`).toContain(EXCEL_MCP_PIN.pinnedSpec)
      const verdict = checkExcelMcpSafety(entry.name, { type: "local", command: spec.command ?? [] })
      expect(verdict.ok, `${entry.id} 未通过 REQ-105 Excel sandbox 闸口:${verdict.ok ? "" : verdict.reason}`).toBe(true)
      if (spec.mirrorCommand) {
        const mirror = checkExcelMcpSafety(entry.name, { type: "local", command: spec.mirrorCommand })
        expect(mirror.ok, `${entry.id} mirror 命令未通过闸口`).toBe(true)
      }
    }
  })
})

/** npx/uvx 命令里的包参数(跳过 -y/--registry <url>/尾随 flag)。 */
function packageArg(command: string[]): string | undefined {
  const args = command.slice(1)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "-y") continue
    if (a === "--registry") {
      i++
      continue
    }
    if (a.startsWith("-")) continue
    return a
  }
  return undefined
}
