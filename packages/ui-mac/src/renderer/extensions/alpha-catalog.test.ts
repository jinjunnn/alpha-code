// alpha-catalog 完整性单测(S23 补,E2/E6 上架时立)—— 把 S22 人工核对的「bundle 引用零悬空 /
// 钉版本纪律(A2)」固化为回归锁。catalog 是 JSON 数据,漂移(悬空引用/漏钉版本)此前只能靠人眼。

import { describe, expect, test } from "bun:test"

import rawCatalog from "./alpha-catalog.json"
import type { Catalog, CatalogEntry, McpInstallSpec } from "./catalog-types"

const catalog = rawCatalog as unknown as Catalog

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

  test("REQ-044 撤下的三无资产条目不得回流(补货唯一通道=远程 catalog,REQ-045)", () => {
    const banned = ["skill:mcp-builder", "skill:canvas-design", "skill:brand-guidelines", "bundle:design"]
    const ids = new Set(catalog.entries.map((e) => e.id))
    for (const id of banned) expect(ids.has(id), `${id} 不应内置回流`).toBe(false)
  })

  test("S23 新条目在场:mcp:dingtalk / mcp:dbhub(E2/E6),钉钉入中国办公套件", () => {
    const ids = new Set(catalog.entries.map((e) => e.id))
    expect(ids.has("mcp:dingtalk")).toBe(true)
    expect(ids.has("mcp:dbhub")).toBe(true)
    const china = catalog.entries.find((e) => e.id === "bundle:china-office")!
    expect(china.bundleItems!.some((i) => i.catalogEntryId === "mcp:dingtalk")).toBe(true)
    // dbhub 只读档:--readonly 必须在命令里(0.12.0 CLI 档;丢失=静默变可写,supply-chain 回归锁)
    const dbhub = catalog.entries.find((e) => e.id === "mcp:dbhub")!
    const spec = dbhub.installSpec as McpInstallSpec
    expect(spec.command).toContain("--readonly")
    expect(spec.mirrorCommand).toContain("--readonly")
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
