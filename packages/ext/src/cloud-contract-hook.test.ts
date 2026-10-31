import { afterEach, beforeEach, expect, test } from "bun:test"
import { resolve } from "node:path"
import { decodeContract } from "@alpha-code/contracts-consumer"
// #650:工具 id 只从**引擎自己的**拼名规则推导。ext 不依赖 opencode(生产侧因此自带一份
// `mcpEngineToolId`),但测试可以直接装真的 `McpCatalog` —— 拼名规则一变,下面全部期望值跟着变。
import { McpCatalog } from "../../opencode/src/mcp/catalog"
import {
  CLOUD_CONTRACT_REMOTE_TOOLS,
  CLOUD_DISPATCH_REMOTE_TOOL,
  CLOUD_UNVALIDATED_REMOTE_TOOLS,
  CloudRemoteToolUnknownError,
  validateCloudToolInput,
  validateCloudToolOutput,
} from "./cloud-contract-hook"
import { CLOUD_MCP_SERVER_ENV, type McpOwnership, UNVERIFIED_MCP_OWNERSHIP } from "./cloud-websearch-kill"
import { TOOL_TEXT } from "./context-injection"

const fixture = (name: string) =>
  Bun.file(
    resolve(
      import.meta.dir,
      `../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer/${name}.json`,
    ),
  ).json()

/** 注入面在本次 fork 写进 sidecar env 的云 server 名(`alpha-config-injection.ts`;alpha-code#1568 起 `codepuppy`)。 */
const CLOUD_SERVER = "codepuppy"
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
  expect(() => validateCloudToolOutput(engineToolId("status"), { output: "", metadata: status.value })).toThrow(
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
  const renamed = "codepuppy-next"
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

// ─────────────────────────────────────────────────────────────────────────────
// alpha-code#1568(裁决 7)—— 远端名表落后于平台时不再静默跳过契约校验。
//
// 改名期间最容易悄悄失效的点:桌面表里还是 `cloud_dispatch`,平台已经叫 `dispatch`,引擎 id 对不上,
// 校验恒不执行而一切照常绿(#650 的同一形态)。现在:一个工具 id **确定**属于本次 fork 的治理云 server
// (归属快照里只有它一个候选),却既不在契约表、也不在平台公开的无契约表里 ⇒ 拒绝,不放过。
// 删掉 cloudRemoteToolOf 里那一句 throw ⇒ 第一条断言当场红。
// ─────────────────────────────────────────────────────────────────────────────

const GOVERNED: McpOwnership = { governed: [CLOUD_SERVER], foreign: [] }

test("#1568 治理云 server 上一个远端名都对不上的工具 ⇒ 响亮拒绝(输入与输出两面)", async () => {
  const stale = engineToolId("cloud_dispatch") // 改名前的远端名挂在新 server 键下
  const request = await fixture("cloud-job-request")
  expect(() => validateCloudToolInput(stale, request.value, process.env, GOVERNED)).toThrow(CloudRemoteToolUnknownError)
  expect(() => validateCloudToolOutput(stale, { output: "{}" }, process.env, GOVERNED)).toThrow(CloudRemoteToolUnknownError)
})

test("#1568 不误拒:平台公开的无契约工具、第一方插件工具、归属有歧义或未核验的工具照常通过", async () => {
  const request = await fixture("cloud-job-request")
  for (const remote of CLOUD_UNVALIDATED_REMOTE_TOOLS)
    expect(() => validateCloudToolInput(engineToolId(remote), {}, process.env, GOVERNED)).not.toThrow()
  // 第一方插件工具与云 server 共用 `codepuppy_` 前缀(方案 §1.5 第 4 条)—— 按扩展自己的工具表排除。
  for (const own of Object.keys(TOOL_TEXT)) expect(() => validateCloudToolInput(own, {}, process.env, GOVERNED)).not.toThrow()
  const stale = engineToolId("cloud_dispatch")
  // 同一个 id 也可能来自一个叫 `codepuppy_cloud` 的第三方 server:归属有歧义 ⇒ 不替它下结论。
  const ambiguous: McpOwnership = { governed: [CLOUD_SERVER], foreign: ["codepuppy_cloud"] }
  expect(() => validateCloudToolInput(stale, request.value, process.env, ambiguous)).not.toThrow()
  // config 钩子没跑过(归属未核验):判不了「确定属于治理 server」,不拒。
  expect(() => validateCloudToolInput(stale, request.value, process.env, UNVERIFIED_MCP_OWNERSHIP)).not.toThrow()
})
