#!/usr/bin/env bun
// alpha-code#1568 AC6 —— 第一方命名导出器(方案 req236-codepuppy-naming-migration §1.3、§3 第 2、3 条)。
//
// 只覆盖本票改名的层:MCP 服务器键、扩展插件工具(id 与可读标识)、模式 / agent、来源分类与来源证明、模型供应商 id。
// 每一层都**直接 import 它的权威**(不扫描、不手抄),外加 vendored 平台公开工具清单与随包 Office 工具清单,
// 推出模型真正收到的函数名(引擎自己的 `McpCatalog.toolName`)。断言三条:
//   ① 这些层里零旧名(`alpha` 品牌、旧云服务器键 `cloud`、重复拼接 `cloud_cloud_`、不带品牌的 `hub_*`),
//      第一方名字以 `codepuppy` 开头且品牌只出现一次;
//   ② 第一方插件动作集 ∩ 平台工具集 = ∅(否则插件工具与云工具拼出同一个模型函数名,引擎别名账本整轮装配失败);
//   ③ 全部模型函数名满足 `^[a-z0-9_-]{1,64}$`(各家接口约束的交集再收紧为小写)。
//
// 用法:`bun packages/ui-mac/scripts/export-codepuppy-names.ts` 打印清单 JSON;有违例时逐条打印并以 1 退出。
// 判据本身在 `src/main/codepuppy-names-export.test.ts`(随 ui-mac 全量门跑)。
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TOOL_TEXT } from "../../ext/src/context-injection"
import { McpCatalog } from "../../opencode/src/mcp/catalog"
import { ToolClass } from "../../schema/src/alpha-tool-policy"
import { ToolAuthority } from "../../schema/src/tool-identity"
import { ALPHA_AGENT_TEXT } from "../src/main/alpha-agents"
import catalog from "../src/main/alpha-models.json"
import { CLOUD_MCP_SERVER_NAME } from "../src/main/cloud-web-search"
import { CLOUD_MCP_TOOLS } from "../src/main/fixtures/cloud-mcp-tools"
import { ALPHA_OFFICE_CONNECTORS } from "../src/shared/office-advisories"

export type CodepuppyNames = {
  serverKeys: string[]
  pluginTools: Array<{ id: string; readable: string }>
  agents: string[]
  sourceClasses: string[]
  authorityKinds: string[]
  providerIds: string[]
  platformTools: string[]
  modelFunctionNames: string[]
}

/** 来源分类里不属于任何品牌的取值:内置 / 第三方 / 插件 / 未声明来源。 */
const NEUTRAL = new Set(["builtin", "third-party-mcp", "plugin", "not-asserted"])
const OLD_NAME = /(^|[^a-z0-9])alpha([^a-z0-9]|$)|^cloud$|cloud_cloud_|^hub_/i
const MODEL_FUNCTION_NAME = /^[a-z0-9_-]{1,64}$/

type OfficeManifest = { formats: Record<string, { tools: Array<{ name: string }> }> }
const OFFICE_TOOLS = join(import.meta.dir, "../resources/office-mcp/tools.json")

export function exportCodepuppyNames(): CodepuppyNames {
  const office = JSON.parse(readFileSync(OFFICE_TOOLS, "utf8")) as OfficeManifest
  const officeFunctions = ALPHA_OFFICE_CONNECTORS.flatMap((connector) =>
    (office.formats[connector.format]?.tools ?? []).map((tool) => McpCatalog.toolName(connector.name, tool.name)),
  )
  const authorityMembers = ToolAuthority.members as ReadonlyArray<{ fields: { kind: { literal: string } } }>
  return {
    serverKeys: [CLOUD_MCP_SERVER_NAME, ...ALPHA_OFFICE_CONNECTORS.map((connector) => connector.name)],
    pluginTools: Object.entries(TOOL_TEXT).map(([id, text]) => ({ id, readable: text.readable })),
    agents: Object.keys(ALPHA_AGENT_TEXT),
    sourceClasses: [...ToolClass.literals],
    authorityKinds: authorityMembers.map((member) => member.fields.kind.literal),
    providerIds: [catalog.platformProvider.id],
    platformTools: [...CLOUD_MCP_TOOLS],
    modelFunctionNames: [
      ...Object.keys(TOOL_TEXT),
      ...CLOUD_MCP_TOOLS.map((tool) => McpCatalog.toolName(CLOUD_MCP_SERVER_NAME, tool)),
      ...officeFunctions,
    ],
  }
}

/** 违例清单;空 = 三条全部成立。每条点名层与名字。 */
export function codepuppyNameViolations(names: CodepuppyNames): string[] {
  const out: string[] = []
  const firstParty: Array<[string, string]> = [
    ...names.serverKeys.map((name): [string, string] => ["serverKeys", name]),
    ...names.pluginTools.flatMap((tool): Array<[string, string]> => [["pluginTools", tool.id], ["pluginTools.readable", tool.readable]]),
    ...names.agents.map((name): [string, string] => ["agents", name]),
    ...names.sourceClasses.filter((name) => !NEUTRAL.has(name)).map((name): [string, string] => ["sourceClasses", name]),
    ...names.authorityKinds.filter((name) => !NEUTRAL.has(name)).map((name): [string, string] => ["authorityKinds", name]),
    ...names.providerIds.map((name): [string, string] => ["providerIds", name]),
  ]
  for (const [layer, name] of firstParty) {
    if (OLD_NAME.test(name)) out.push(`${layer}: old name ${JSON.stringify(name)}`)
    else if (!name.startsWith("codepuppy") || name.split("codepuppy").length !== 2)
      out.push(`${layer}: ${JSON.stringify(name)} must start with codepuppy and carry the brand exactly once`)
  }
  for (const name of [...names.sourceClasses, ...names.authorityKinds].filter((value) => NEUTRAL.has(value)))
    if (OLD_NAME.test(name)) out.push(`neutral: old name ${JSON.stringify(name)}`)
  const platform = new Set(names.platformTools)
  for (const tool of names.pluginTools) {
    const action = tool.readable.slice(tool.readable.indexOf(":") + 1)
    if (platform.has(action)) out.push(`pluginTools: action ${JSON.stringify(action)} (${tool.id}) is also a platform tool`)
  }
  const seen = new Set<string>()
  for (const name of names.modelFunctionNames) {
    if (!MODEL_FUNCTION_NAME.test(name)) out.push(`modelFunctionNames: ${JSON.stringify(name)} violates ${MODEL_FUNCTION_NAME}`)
    if (seen.has(name)) out.push(`modelFunctionNames: ${JSON.stringify(name)} is produced twice`)
    seen.add(name)
  }
  return out
}

if (import.meta.main) {
  const names = exportCodepuppyNames()
  console.log(JSON.stringify(names, null, 2))
  const violations = codepuppyNameViolations(names)
  for (const violation of violations) console.error(`✗ ${violation}`)
  process.exit(violations.length === 0 ? 0 : 1)
}
