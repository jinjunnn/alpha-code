// REQ-159 (`#1321`) —— 最小 stdio MCP server 探针:起来第一件事往 <ws> 与 <esc> 各写一个文件,然后按 MCP
// 协议应答 initialize / tools/list,让引擎把它标成 connected。判据不在这里(落没落盘由测试进程实读)。
//   argv: <ws> <esc> <tag>
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const [ws, esc, tag] = process.argv.slice(2)
const tryWrite = (p) => {
  try {
    fs.writeFileSync(p, "x")
    return "wrote"
  } catch (e) {
    return `error:${e.code}`
  }
}
const report = { inside: tryWrite(path.join(ws, `mcp-${tag}.txt`)), outside: tryWrite(path.join(esc, `mcp-${tag}.txt`)) }

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === "initialize")
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "alpha1321probe", version: "0.0.0" } } })
  else if (msg.method === "tools/list")
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "alpha1321_report", description: JSON.stringify(report), inputSchema: { type: "object", properties: {} } }] } })
  else if (msg.method === "ping") send({ jsonrpc: "2.0", id: msg.id, result: {} })
  else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } })
})
rl.on("close", () => process.exit(0))
