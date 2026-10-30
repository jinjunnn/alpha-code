// #1563 fixture: a real stdio MCP server whose startup can hang, run slow, fork a descendant and log its startup
// window, so alpha-mcp-independent-startup.test.ts measures processes instead of assuming them. Driven by env:
//   ALPHA_MCP_PID_FILE          write {"parent":pid,"child":pid?} once the process (and its descendant) exist
//   ALPHA_MCP_CHILD=1           fork a long-lived descendant process
//   ALPHA_MCP_HANG=1            never read stdin, so `initialize` is never answered
//   ALPHA_MCP_INIT_DELAY_MS     wait before reading stdin (the handshake takes at least this long)
//   ALPHA_MCP_LIST_DELAY_MS     wait before answering tools/list
//   ALPHA_MCP_STARTUP_LOG       append "+" at launch and "-" when answering tools/list (end of startup)
//   ALPHA_MCP_DESCRIPTION_FILE  the `echo` tool's description, read at launch (a reconnect can change the definition)
//   ALPHA_MCP_CALL_LOG          append "<tool>\n" when a tools/call starts
//   ALPHA_MCP_TOOLS_FILE        serve this JSON array of tool definitions instead of echo/slow (#1565: stand in for
//                               a first-party Office server whose definitions come from its bundled manifest)
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const env = process.env
const mark = (value: string) => {
  if (env.ALPHA_MCP_STARTUP_LOG) appendFileSync(env.ALPHA_MCP_STARTUP_LOG, value)
}

mark("+")
const child = env.ALPHA_MCP_CHILD ? Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"]) : undefined
if (env.ALPHA_MCP_PID_FILE)
  writeFileSync(env.ALPHA_MCP_PID_FILE, JSON.stringify({ parent: process.pid, child: child?.pid }))
if (env.ALPHA_MCP_HANG) {
  setInterval(() => {}, 1 << 30)
  await new Promise(() => {})
}
if (env.ALPHA_MCP_INIT_DELAY_MS) await Bun.sleep(Number(env.ALPHA_MCP_INIT_DELAY_MS))

const description = env.ALPHA_MCP_DESCRIPTION_FILE ? readFileSync(env.ALPHA_MCP_DESCRIPTION_FILE, "utf8") : "echo"
const server = new Server({ name: "alpha-mcp-startup", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (env.ALPHA_MCP_LIST_DELAY_MS) await Bun.sleep(Number(env.ALPHA_MCP_LIST_DELAY_MS))
  mark("-")
  if (env.ALPHA_MCP_TOOLS_FILE) return { tools: JSON.parse(readFileSync(env.ALPHA_MCP_TOOLS_FILE, "utf8")) }
  return {
    tools: [
      { name: "echo", description, inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "slow", description: "sleeps", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {}
  if (env.ALPHA_MCP_CALL_LOG) appendFileSync(env.ALPHA_MCP_CALL_LOG, `${request.params.name}\n`)
  if (request.params.name === "slow") await Bun.sleep(Number(args.ms ?? 0))
  return { content: [{ type: "text", text: String(args.text ?? request.params.name) }] }
})

await server.connect(new StdioServerTransport())
