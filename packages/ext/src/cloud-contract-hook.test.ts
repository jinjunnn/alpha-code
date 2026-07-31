import { afterEach, beforeEach, expect, test } from "bun:test"
import { resolve } from "node:path"
import { decodeContract } from "@alpha-code/contracts-consumer"
// #650:工具 id 只从**引擎自己的**拼名规则推导。ext 不依赖 opencode(生产侧因此自带一份
// `mcpEngineToolId`),但测试可以直接装真的 `McpCatalog` —— 拼名规则一变,下面全部期望值跟着变。
import { McpCatalog } from "../../opencode/src/mcp/catalog"
import {
  CLOUD_CONTRACT_REMOTE_TOOLS,
  CLOUD_DISPATCH_REMOTE_TOOL,
  validateCloudToolInput,
  validateCloudToolOutput,
} from "./cloud-contract-hook"
import { CLOUD_MCP_SERVER_ENV } from "./cloud-websearch-kill"

const fixture = (name: string) =>
  Bun.file(
    resolve(
      import.meta.dir,
      `../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer/${name}.json`,
    ),
  ).json()

/** 注入面在本次 fork 写进 sidecar env 的云 server 名(`alpha-config-injection.ts`)。 */
const CLOUD_SERVER = "cloud"
/** 引擎注册 id —— 钩子 `tool.execute.before/after` 拿到的就是它(`plugin.ts` 的 `hookInput.tool`)。 */
const engineToolId = (remoteName: string) => McpCatalog.toolName(CLOUD_SERVER, remoteName)

let saved: string | undefined
beforeEach(() => {
  saved = process.env[CLOUD_MCP_SERVER_ENV]
  process.env[CLOUD_MCP_SERVER_ENV] = CLOUD_SERVER
})
afterEach(() => {
  if (saved === undefined) delete process.env[CLOUD_MCP_SERVER_ENV]
  else process.env[CLOUD_MCP_SERVER_ENV] = saved
})

test("cloud HTTP and cloud MCP use the same pinned v1 decoder", async () => {
  const request = await fixture("cloud-job-request")
  const accepted = await fixture("cloud-job-accepted")
  const dispatch = engineToolId(CLOUD_DISPATCH_REMOTE_TOOL)
  expect(decodeContract("CloudJobRequestV1", request.value, "cloud-http")).toEqual(request.value)
  expect(() => validateCloudToolInput(dispatch, request.value)).not.toThrow()
  expect(() => validateCloudToolOutput(dispatch, { structuredContent: accepted.value })).not.toThrow()
  expect(() =>
    validateCloudToolOutput(dispatch, { content: [{ type: "text", text: JSON.stringify(accepted.value) }] }),
  ).not.toThrow()
})

test("cloud MCP rejects incompatible results as visible tool errors", async () => {
  const status = await fixture("cloud-job-status")
  status.value.status = "waiting"
  expect(() => validateCloudToolOutput(engineToolId("cloud_status"), { output: "", metadata: status.value })).toThrow(
    "Alpha contract incompatible",
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// #650 —— 这道契约闸此前对四个兄弟云工具**一次也没执行过**。
//
// 钩子拿到的是引擎工具 id(`McpCatalog.toolName(server, remote)`),而这里比的是远端工具名。
// 云 worker 的远端名自带 `cloud_` 前缀(`cloud_dispatch`),拼上 server 名 `cloud` 之后真实 id 是
// `cloud_cloud_dispatch` —— 精确相等恒不成立,契约违例一条也拦不住,而上面两条用例照样全绿,
// 因为它们**手喂**了远端名。下面两条把这个混淆钉死:期望值全部由 `McpCatalog.toolName` 推导。
// ─────────────────────────────────────────────────────────────────────────────

test("#650 契约校验按引擎真实 id 命中(远端名单独出现时不是云工具)", async () => {
  const request = await fixture("cloud-job-request")
  const broken = { ...request.value, status: "definitely-not-a-contract-field", schema_version: "v0" }

  for (const remote of CLOUD_CONTRACT_REMOTE_TOOLS) {
    const id = engineToolId(remote)
    // 引擎 id ≠ 远端名:混淆二者就是空闸门。
    expect([remote, id]).toEqual([remote, `${CLOUD_SERVER}_${remote}`])
    // 真实 id ⇒ 校验真的跑(输出面对四个工具都有契约)。
    expect(() => validateCloudToolOutput(id, { output: "", metadata: broken })).toThrow("Alpha contract incompatible")
    // 远端名本身不是任何已注册工具的 id ⇒ 不该被当成云工具。
    expect(() => validateCloudToolOutput(remote, { output: "", metadata: broken })).not.toThrow()
  }

  expect(() => validateCloudToolInput(engineToolId(CLOUD_DISPATCH_REMOTE_TOOL), broken)).toThrow(
    "Alpha contract incompatible",
  )
  expect(() => validateCloudToolInput(CLOUD_DISPATCH_REMOTE_TOOL, broken)).not.toThrow()
})

test("#650 server 名换了,闸跟着换 —— 不是钉在 `cloud_` 这个字面量上", async () => {
  const request = await fixture("cloud-job-request")
  const broken = { ...request.value, schema_version: "v0" }
  const renamed = "alpha-cloud"
  process.env[CLOUD_MCP_SERVER_ENV] = renamed

  expect(() => validateCloudToolInput(McpCatalog.toolName(renamed, CLOUD_DISPATCH_REMOTE_TOOL), broken)).toThrow(
    "Alpha contract incompatible",
  )
  // 旧 server 名下的 id 不再属于本次 fork 的云 server。
  expect(() => validateCloudToolInput(engineToolId(CLOUD_DISPATCH_REMOTE_TOOL), broken)).not.toThrow()

  // 注入面没点名任何云 server(未登录 / BYOK / 非代付)⇒ 本次 fork 根本没有云工具。
  delete process.env[CLOUD_MCP_SERVER_ENV]
  expect(() => validateCloudToolInput(engineToolId(CLOUD_DISPATCH_REMOTE_TOOL), broken)).not.toThrow()
})
