// The platform cloud MCP's real `tools/list` names: alpha-platform packages/gateway/test/fixtures/mcp-legacy-tools-list.json
// (recorded from the production buildMcpServer + Client.listTools()), vendored byte-for-byte at the commit pinned in
// packages/alpha-contracts-consumer/alpha-platform-cloud-mcp.lock.json. Never copy names here by hand: bump the pin
// (`bun run vendor`) and every consumer follows (alpha-code#1568 AC4).
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function platformCloudMcpTools(json: string): string[] {
  const listed = JSON.parse(json) as Array<{ name?: unknown }>
  if (!Array.isArray(listed) || listed.length === 0 || !listed.every((tool) => typeof tool?.name === "string"))
    throw new Error("vendored tools/list payload is not a non-empty array of named tools")
  return listed.map((tool) => tool.name as string)
}
const VENDORED = fileURLToPath(new URL("../../../../alpha-contracts-consumer/vendor/alpha-platform-cloud-mcp/mcp-legacy-tools-list.json", import.meta.url))
export const CLOUD_MCP_TOOLS: readonly string[] = platformCloudMcpTools(readFileSync(VENDORED, "utf8"))
