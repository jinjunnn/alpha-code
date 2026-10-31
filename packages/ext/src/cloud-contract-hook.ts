// #650 —— 这道契约闸以前按**远端工具名**做精确相等,而钩子拿到的是**引擎工具 id**,于是
// 四个兄弟云工具的 `CloudJobRequestV1` / `CloudJobAcceptedV1` / `CloudJobStatusV1` /
// `ArtifactListV1` 校验一次也没执行过(不是「偶尔漏」,是恒不命中):
//
//   远端名(worker 自己 advertise;platform#560 起只说动作)   dispatch
//   引擎 id(McpCatalog.toolName(server, remote))           codepuppy_dispatch   ← plugin.ts 传进来的
//
// 现在 id 一律**推导**:server 名取注入面在本次 fork 写进 env 的那个(`ALPHA_CLOUD_MCP_SERVER`,
// 与 `cloud-websearch-kill.ts` 的治理豁免同源),远端名是下面这张表。仓里不许再出现第二份 id 字面量。
//
// alpha-code#1568:表与平台公开工具清单的关系由 ui-mac `cloud-remote-names-pin.test.ts` 双向钉住(下面两张表合起来
// = 平台 §6 全集)。运行期再补一道:一个工具 id **确定**属于本次 fork 的治理云 server、却一个远端名都对不上,
// 就响亮拒绝,不再静默跳过契约校验 —— 改名期间远端名表落后于平台,正是 #650 那种「闸一次都没跑」的形态。

import { ContractIncompatibleError, decodeContract, decodeJsonContract, type ContractName } from "@alpha-code/contracts-consumer"
import {
  CLOUD_MCP_SERVER_ENV,
  isGovernedCloudTool,
  mcpEngineToolId,
  type McpOwnership,
  UNVERIFIED_MCP_OWNERSHIP,
} from "./cloud-websearch-kill"
import { TOOL_TEXT } from "./context-injection"

/** 云 worker **自己** advertise 的、带契约要校验的远端工具名。 */
export const CLOUD_DISPATCH_REMOTE_TOOL = "dispatch"
export const CLOUD_ARTIFACTS_REMOTE_TOOL = "artifacts"
export const CLOUD_CONTRACT_REMOTE_TOOLS = [
  CLOUD_DISPATCH_REMOTE_TOOL,
  "status",
  "await",
  CLOUD_ARTIFACTS_REMOTE_TOOL,
] as const
/** 平台公开、但没有契约要校验的远端工具名。 */
export const CLOUD_UNVALIDATED_REMOTE_TOOLS = ["cancel", "web_search", "web_fetch", "vision", "decide", "account_status"] as const

export class CloudRemoteToolUnknownError extends Error {
  constructor(tool: string) {
    super(
      `${tool} belongs to the Code Puppy cloud server but matches none of the remote tool names this app knows; ` +
        "its contract cannot be checked, so the call is refused instead of passing unchecked. Update the app.",
    )
    this.name = "CloudRemoteToolUnknownError"
  }
}

/**
 * 引擎工具 id → 它对应的远端工具名;不是本次 fork 注册的云工具、或是平台公开但无契约的云工具则 `undefined`。
 *
 * server 名缺席(未登录 / BYOK / 非代付)时注入面根本不注册云 server,也就不存在云工具 —— 这时
 * 返回 `undefined` 与「没有云工具可校验」是同一件事,不是放行了一个真的云工具。
 *
 * 「确定属于治理云 server」沿用 web search 闸的同一判据(`isGovernedCloudTool`:候选归属方只有治理 server);
 * 第一方插件工具与云 server 共用 `codepuppy_` 前缀(方案 §1.5 第 4 条),按扩展自己的工具表排除。
 */
function cloudRemoteToolOf(tool: string, env: Record<string, string | undefined>, ownership: McpOwnership): string | undefined {
  const server = env[CLOUD_MCP_SERVER_ENV]
  if (!server) return undefined
  const remote = CLOUD_CONTRACT_REMOTE_TOOLS.find((name) => mcpEngineToolId(server, name) === tool)
  if (remote) return remote
  if (Object.hasOwn(TOOL_TEXT, tool) || !isGovernedCloudTool(tool, ownership)) return undefined
  if (CLOUD_UNVALIDATED_REMOTE_TOOLS.some((name) => mcpEngineToolId(server, name) === tool)) return undefined
  throw new CloudRemoteToolUnknownError(tool)
}

export function validateCloudToolInput(
  tool: string,
  args: unknown,
  env: Record<string, string | undefined> = process.env,
  ownership: McpOwnership = UNVERIFIED_MCP_OWNERSHIP,
): void {
  if (cloudRemoteToolOf(tool, env, ownership) !== CLOUD_DISPATCH_REMOTE_TOOL) return
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
  ownership: McpOwnership = UNVERIFIED_MCP_OWNERSHIP,
): void {
  const remote = cloudRemoteToolOf(tool, env, ownership)
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
