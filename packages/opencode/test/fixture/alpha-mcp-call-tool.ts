// alpha-owned rig helper (basename `alpha-*`, ADR-043). #1563: Code Mode child calls now go through
// `MCP.Service.callTool`, which picks the server's current connection. Rigs that hand out hand-built `McpTool`
// entries have no MCP layer behind them, so this stand-in dispatches each call to the entry's own client — the
// client those rigs already instrument. The real entry (current connection, generation/definition check) is
// measured by test/mcp/alpha-mcp-independent-startup.test.ts.
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import type { MCP } from "../../src/mcp"

export const callToolVia =
  (tools: Record<string, MCP.McpTool>): NonNullable<MCP.Interface["callTool"]> =>
  (origin, name, args, options) =>
    Effect.tryPromise({
      try: () => {
        const entry = Object.values(tools).find(
          (tool) => tool.identity?.origin === origin && tool.identity.name === name,
        )
        if (!entry) throw new Error(`no MCP tool ${origin}/${name} in this rig`)
        return entry.client.callTool({ name, arguments: args }, CallToolResultSchema, {
          signal: options.signal,
          timeout: options.timeout,
        })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
