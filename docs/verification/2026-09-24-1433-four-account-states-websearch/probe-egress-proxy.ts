#!/usr/bin/env bun
// alpha-code#1433 (REQ-1414 VERIFY-1) —— 出网策略代理对 websearch 两个端点的真实判决。
//
// 复现(模块解析要求它跑在 packages/ui-mac 之下):
//   cp docs/verification/2026-09-24-1433-four-account-states-websearch/probe-egress-proxy.ts \
//      packages/ui-mac/probe-1433-egress.ts
//   cd packages/ui-mac && bun run probe-1433-egress.ts < /dev/null
//
// 起的是**生产的那个**代理(`startEgressPolicyProxy`),`authorize` / `requestGrant` / `dial`
// 一个都不覆盖 ⇒ 判决来自 `isEgressAuthorizedForSidecar`(静态登记表 ∪ 动态半场 ∪ 用户批准)。
// 端口注入 env 也用生产的 `sidecarEgressProxyEnv`。
//
// 反向臂 = `example.com:443`(登记表里刻意没有它,见 network-egress-registry.ts:29)。
// 它必须 403 unregistered,否则本次测量作废 —— 「两个端点通了」本身不能证明代理在路径上。
//
// ⚠️ `Bun.spawnSync` 会阻塞 JS 线程 ⇒ http 服务器根本 accept 不到连接,四个目的地全部 20s 超时、
//    代理日志 0 条。第一版就是这么假红的;必须用异步 `Bun.spawn`。
import { startEgressPolicyProxy } from "./src/main/network-egress-proxy"
import { sidecarEgressProxyEnv } from "./src/main/sidecar-env"

const DESTS = [
  { url: "https://mcp.exa.ai/mcp", expect: "allow", why: "network-egress-registry.ts:116(本地 keyless websearch / Exa)" },
  { url: "https://search.parallel.ai/mcp", expect: "allow", why: "network-egress-registry.ts:117(本地 keyless websearch / Parallel)" },
  { url: "https://example.com/", expect: "deny", why: "反向臂:刻意未登记(registry.ts:29)" },
  { url: "https://alpha-cloud.tidelabs.click/mcp", expect: "allow", why: "云 MCP(登记的 app 端点)" },
  // kill-switch 那一格实测:模型会改用 `webfetch` 去打搜索引擎的结果页。这两条是那条绕行路的目的地。
  { url: "https://duckduckgo.com/html/?q=bun", expect: "deny", why: "kill-switch 绕行路:模型实际请求过的搜索引擎结果页" },
  { url: "https://www.bing.com/search?q=bun", expect: "deny", why: "同上" },
]

const log: any[] = []
const handle = await startEgressPolicyProxy({ log: (r) => log.push(r) })
const env = sidecarEgressProxyEnv(handle.port)

async function viaProxy(url: string) {
  const proc = Bun.spawn(
    ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "-m", "20", "-x", `http://127.0.0.1:${handle.port}`,
     "-X", "POST", "-H", "content-type: application/json", "-H", "accept: application/json, text/event-stream",
     "--data", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', url],
    { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } },
  )
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { httpCode: stdout.trim(), stderr: stderr.trim().slice(0, 200), exitCode: await proc.exited }
}

const rows = []
for (const d of DESTS) rows.push({ ...d, ...(await viaProxy(d.url)) })
await handle.close()

const verdicts = log.filter((r) => r.event === "egress.connect").map((r) => ({ authority: r.authority, verdict: r.verdict, reason: r.reason, status: r.status }))
console.log(JSON.stringify({
  ticket: "alpha-code#1433",
  at: new Date().toISOString(),
  bun: Bun.version,
  proxy: `${handle.host}:${handle.port}`,
  injectedEnv: env,
  rows,
  proxyVerdicts: verdicts,
  proxyLog: log,
  notMeasuredHere: ["seatbelt process fence(是否强制只能走代理)", "打包版 sidecar 的 setGlobalProxyFromEnv 是否真生效", "模型 tool_calls"],
}, null, 2))
