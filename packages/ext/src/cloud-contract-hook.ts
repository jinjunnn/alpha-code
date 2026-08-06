// #650 —— 这道契约闸以前按**远端工具名**做精确相等,而钩子拿到的是**引擎工具 id**,于是
// 四个兄弟云工具的 `CloudJobRequestV1` / `CloudJobAcceptedV1` / `CloudJobStatusV1` /
// `ArtifactListV1` 校验一次也没执行过(不是「偶尔漏」,是恒不命中):
//
//   远端名(worker 自己 advertise,#643 P1.3 实测)   cloud_dispatch
//   引擎 id(McpCatalog.toolName(server, remote))    cloud_cloud_dispatch   ← plugin.ts 传进来的
//
// 现在 id 一律**推导**:server 名取注入面在本次 fork 写进 env 的那个(`ALPHA_CLOUD_MCP_SERVER`,
// 与 `cloud-websearch-kill.ts` 的治理豁免同源),远端名是下面这张表。仓里不许再出现第二份 id 字面量。

import { ContractIncompatibleError, decodeContract, decodeJsonContract, type ContractName } from "@alpha-code/contracts-consumer"
import { CLOUD_MCP_SERVER_ENV, mcpEngineToolId } from "./cloud-websearch-kill"

/** 云 worker **自己** advertise 的远端工具名(#643 P1.3 实测 `remoteToolNames`)。 */
export const CLOUD_DISPATCH_REMOTE_TOOL = "cloud_dispatch"
export const CLOUD_ARTIFACTS_REMOTE_TOOL = "cloud_artifacts"
export const CLOUD_CONTRACT_REMOTE_TOOLS = [
  CLOUD_DISPATCH_REMOTE_TOOL,
  "cloud_status",
  "cloud_await",
  CLOUD_ARTIFACTS_REMOTE_TOOL,
] as const

/**
 * 引擎工具 id → 它对应的远端工具名;不是本次 fork 注册的云工具则 `undefined`。
 *
 * server 名缺席(未登录 / BYOK / 非代付)时注入面根本不注册云 server,也就不存在云工具 —— 这时
 * 返回 `undefined` 与「没有云工具可校验」是同一件事,不是放行了一个真的云工具。
 */
function cloudRemoteToolOf(tool: string, env: Record<string, string | undefined>): string | undefined {
  const server = env[CLOUD_MCP_SERVER_ENV]
  if (!server) return undefined
  return CLOUD_CONTRACT_REMOTE_TOOLS.find((remote) => mcpEngineToolId(server, remote) === tool)
}

export function validateCloudToolInput(
  tool: string,
  args: unknown,
  env: Record<string, string | undefined> = process.env,
): void {
  if (cloudRemoteToolOf(tool, env) !== CLOUD_DISPATCH_REMOTE_TOOL) return
  decodeContract("CloudJobRequestV1", args, "cloud-mcp")
}

type CloudToolOutput = {
  output?: string
  metadata?: unknown
  structuredContent?: unknown
  content?: Array<{ type?: unknown; text?: unknown }>
}

export function validateCloudToolOutput(
  tool: string,
  output: CloudToolOutput,
  env: Record<string, string | undefined> = process.env,
): void {
  const remote = cloudRemoteToolOf(tool, env)
  if (!remote) return
  if (remote === CLOUD_DISPATCH_REMOTE_TOOL) {
    validateOutputContract("CloudJobAcceptedV1", output)
    return
  }
  if (remote === CLOUD_ARTIFACTS_REMOTE_TOOL) {
    validateOutputContract("ArtifactListV1", output)
    return
  }
  validateOutputContract("CloudJobStatusV1", output)
}

function validateOutputContract(contract: ContractName, output: CloudToolOutput) {
  if (output.structuredContent !== undefined && output.structuredContent !== null) {
    decodeContract(contract, output.structuredContent, "cloud-mcp")
    return
  }
  const text = output.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text
  if (typeof text === "string") {
    decodeJsonContract(contract, text, "cloud-mcp")
    return
  }
  if (typeof output.output === "string") {
    decodeJsonContract(contract, output.output, "cloud-mcp")
    return
  }
  if (output.metadata && typeof output.metadata === "object" && !Array.isArray(output.metadata)) {
    decodeContract(contract, output.metadata, "cloud-mcp")
    return
  }
  throw new ContractIncompatibleError({
    surface: "cloud-mcp",
    received_version: "missing",
    reason: "schema-validation",
  })
}
