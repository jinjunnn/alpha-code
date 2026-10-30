#!/usr/bin/env bun
// gen-office-mcp-tools — #1565(REQ-236 §2.3):四个随包文档工具的「声明定义」清单 resources/office-mcp/tools.json。
//
// 引擎在文档工具连上之前就要把它们的用法告诉模型(连上要几秒;那几秒里模型会以为没有文档工具)。用法只有一个来源:
// server.py 的 tools_for()。本脚本以模块方式载入 server.py(它的 `__main__` 守卫不让 stdio 循环跑起来;`-B` 不写
// 字节码,server.py 所在目录一个字节都不动),逐格式取 tools_for(),连同每个格式的随包命令模板
// (office-advisories.ts 的 alphaOfficeInstallCommand,`{alphaResources}` 槽原样保留)与 server.py 的 sha256 写成
// `{serverSha256, formats}`,入库。引擎只对命令与模板逐 token 相等、且随包 server.py 摘要仍与清单一致的条目使用它
// (packages/plugin/src/alpha-first-party-mcp.ts)。
//
// 改了 server.py 的工具 schema 或命令模板之后重跑:`bun scripts/gen-office-mcp-tools.ts`。
// office-mcp-tools-snapshot.test.ts 重新生成并与入库内容逐字节比较,忘了重跑即红。
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { ALPHA_OFFICE_CONNECTORS, alphaOfficeInstallCommand } from "../src/shared/office-advisories"

const OFFICE_MCP_DIR = join(import.meta.dir, "..", "resources", "office-mcp")
export const OFFICE_MCP_SERVER = join(OFFICE_MCP_DIR, "server.py")
export const OFFICE_MCP_MANIFEST = join(OFFICE_MCP_DIR, "tools.json")

// argv: <server.py> <format>...;server.py 的 FORMATS 与传入的格式集合不同 ⇒ 失败(新增格式必须先进 office-advisories)。
const EXPORT_TOOLS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("alpha_office_server", sys.argv[1])
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
formats = sys.argv[2:]
if set(formats) != set(server.FORMATS):
    raise SystemExit("server.py FORMATS %s != office-advisories %s" % (sorted(server.FORMATS), formats))
print(json.dumps({name: server.tools_for(name) for name in formats}))
`

/** 由 `server` 的 tools_for() 渲染清单全文(不写盘)。 */
export function renderOfficeMcpTools(server: string = OFFICE_MCP_SERVER): string {
  const formats = ALPHA_OFFICE_CONNECTORS.map((connector) => connector.format)
  const python = Bun.which("python3")
  if (!python) throw new Error("gen-office-mcp-tools: python3 is not on PATH (needed to load server.py's tools_for)")
  const run = Bun.spawnSync([python, "-I", "-B", "-c", EXPORT_TOOLS, server, ...formats], { stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`gen-office-mcp-tools: ${python} exited ${run.exitCode}: ${run.stderr.toString()}`)
  const tools = JSON.parse(run.stdout.toString()) as Record<string, unknown[]>
  const manifest = {
    serverSha256: createHash("sha256").update(readFileSync(server)).digest("hex"),
    formats: Object.fromEntries(
      formats.map((format) => [format, { command: alphaOfficeInstallCommand(format), tools: tools[format] }]),
    ),
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

if (import.meta.main) {
  writeFileSync(OFFICE_MCP_MANIFEST, renderOfficeMcpTools())
  console.log(`gen-office-mcp-tools: ${OFFICE_MCP_MANIFEST}`)
}
