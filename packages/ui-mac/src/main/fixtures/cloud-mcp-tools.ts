// The platform's public cloud MCP tool names: §6 of alpha-platform docs/contracts/public-cloud-mcp.md, vendored
// byte-for-byte at the commit pinned in packages/alpha-contracts-consumer/alpha-platform-cloud-mcp.lock.json.
// Never copy names here by hand: bump the pin (`bun run vendor`) and every consumer follows (alpha-code#1568 AC4).
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function platformCloudMcpTools(markdown: string): string[] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith("6. ")) ?? ""
  const table = section.includes("\n| 工具 |") ? section.slice(section.indexOf("\n| 工具 |")).split(/\n(?!\|)/)[0] ?? "" : ""
  const names = [...table.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1]!)
  if (names.length === 0) throw new Error("public-cloud-mcp.md §6 tool table not found")
  return names
}
const VENDORED = fileURLToPath(new URL("../../../../alpha-contracts-consumer/vendor/alpha-platform-cloud-mcp/public-cloud-mcp.md", import.meta.url))
export const CLOUD_MCP_TOOLS: readonly string[] = platformCloudMcpTools(readFileSync(VENDORED, "utf8"))
