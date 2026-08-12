// #934 — 第一方 cloud facade 的 identity 判定,时间线产物行(timeline-model)与
// run-watcher 解析核(cloud-run-core)共用**同一枚铸币**,不各自手写。
//
// 准入 = 持久化 ToolDisplaySnapshotV1 的 identity(source="mcp", origin="cloud")。
// origin 是宿主注入的第一方 facade 配置键(cloud-web-search.ts CLOUD_MCP_SERVER_NAME
// = "cloud",引擎 mcp/index.ts 以 clientName 为 origin);第三方铸不出这个组合:
// plugin 命名空间 `cloud`(工具 id `cloud_x`,tool/registry.ts)的 identity 是
// (plugin, "cloud"),sanitize 撞前缀的 MCP 配置键(`cloud.x` → 别名 `cloud_x_*`,
// mcp/catalog.ts toolName)的 identity 是 (mcp, "cloud.x")。
// **不比对 authority**:#879 审计终轮裁定 category==="alpha-cloud"(依赖
// governedMcpEvidence 运行时铸造)会误杀现网真实云产物行,准入只看 identity。
// 别名(part.tool)不参与判定;快照缺失(历史行)/形状非法 一律 false(fail-closed)。
export function isCloudFacadeToolPart(part: unknown): boolean {
  if (typeof part !== "object" || part === null) return false
  const display = (part as { display?: unknown }).display
  if (typeof display !== "object" || display === null) return false
  const identity = (display as { identity?: unknown }).identity
  if (typeof identity !== "object" || identity === null) return false
  const record = identity as { source?: unknown; origin?: unknown }
  return record.source === "mcp" && record.origin === "cloud"
}
