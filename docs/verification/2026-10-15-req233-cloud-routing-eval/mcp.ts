import { Server } from "../../../packages/opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"
import { StdioServerTransport } from "../../../packages/opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "../../../packages/opencode/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"
import snapshot from "./tool-snapshot.json"

const group = process.argv[2]
const tools = group === "cloud" ? snapshot.cloud : snapshot.office[group as keyof typeof snapshot.office]
if (!tools) throw new Error("Unknown stub group")
const server = new Server({ name: `eval-${group}`, version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "EVAL_STUB: fixed response; no files or services accessed" }],
}))
await server.connect(new StdioServerTransport())
