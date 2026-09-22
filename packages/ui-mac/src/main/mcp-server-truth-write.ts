// `#1381` —— 远程 MCP 服务器真源的**写端**。只有 main 进程会 import 本文件;它**不得**进 sidecar 的 import 闭包
// (mcp-server-truth.test.ts 对着 process-fence-write-sites.ts 的 sidecarSourceFiles 实测),理由在 mcp-server-truth.ts 文件头。
//
// 写:先过读端**同一份**判据(坏记录不落盘,连目录都不建),再写临时文件 + 同目录 rename(原子:写到一半失败 ⇒ 盘上仍是
// 旧内容,不是半截文件;临时文件收走,错误原样抛,由调用方决定怎么出声)。字节确定:固定键序、紧凑、末尾换行。
// 与 custom-provider-truth-write.ts / process-fence-workspaces.ts 的写法同形(同一个状态根下的兄弟真源)。
// 调用方:ext-config.ts 的 persistMcp / removeMcp / restoreMcpLeaf(经 mcp-server-lifecycle.ts)。electron-free:fs 注入。

import { dirname } from "node:path"
import { MCP_SERVER_TRUTH_VERSION, canonicalMcpServerRecord, invalidMcpServerList, type McpServerRecord } from "./mcp-server-truth"

export type McpServerTruthWriteFs = {
  mkdirSync: (path: string, options: { recursive: true }) => unknown
  writeFileSync: (path: string, data: string) => void
  renameSync: (from: string, to: string) => void
  rmSync: (path: string, options: { force: true }) => void
}

let tmpSeq = 0

/** 原子写(见文件头)。父目录 `mcp-servers/` 不在 alpha-environment.ts 的拓扑预检里,不在就建。 */
export function writeMcpServerTruth(path: string, servers: readonly McpServerRecord[], fs: McpServerTruthWriteFs): void {
  const bad = invalidMcpServerList(servers)
  if (bad) throw new Error(`remote MCP servers: refusing to write ${path} — ${bad}`)
  const text = JSON.stringify({ v: MCP_SERVER_TRUTH_VERSION, servers: servers.map(canonicalMcpServerRecord) }) + "\n"
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, path)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // 临时文件留着无害(读端只认 <env>.json);真正要报的是下面那个错
    }
    throw error
  }
}
