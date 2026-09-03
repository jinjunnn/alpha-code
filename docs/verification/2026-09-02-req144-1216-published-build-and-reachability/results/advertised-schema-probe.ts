// 复现:云 worker 的 cloud_dispatch 广播出什么 inputSchema。
// 跑法:放进 alpha-platform/packages/gateway/ 下 `bun advertised-schema-probe.ts`
// (必须用该包 node_modules 里装着的 @modelcontextprotocol/sdk 与 zod,不要换版本)。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { CloudJobRequestV1Schema } from "./src/contracts/v1/cloud-job"

const server = new McpServer({ name: "probe", version: "0" })
// 被测:逐字引用生产源
server.registerTool("cloud_dispatch", { description: "d", inputSchema: CloudJobRequestV1Schema },
  async (args: any) => ({ content: [{ type: "text" as const, text: "handler ran with autonomy=" + args?.autonomy }] }))
// 对照臂:普通 z.object —— 证明探针能看见非空 schema
server.registerTool("control_plain", { description: "d", inputSchema: z.object({ query: z.string(), n: z.number().optional() }) },
  async () => ({ content: [{ type: "text" as const, text: "ok" }] }))

const [ct, st] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: "probe", version: "0" })
await Promise.all([server.connect(st), client.connect(ct)])

for (const t of (await client.listTools()).tools) console.log(t.name, JSON.stringify(t.inputSchema))

for (const [label, args] of [["empty", {}], ["valid", { schema_version: 1, idempotency_key: "t1216-probe-0001", autonomy: "bounded-agent", objective: "hi", capabilities: [] }]] as Array<[string, any]>) {
  const r: any = await client.callTool({ name: "cloud_dispatch", arguments: args })
  console.log(label, "isError=" + !!r.isError, (r.content?.[0]?.text ?? "").slice(0, 120).replace(/\n/g, " "))
}
process.exit(0)
