// REQ-234 `#1531`(审计 R1 Major 1)—— sidecar 进程里「进程内调用引擎」的交接点。
//
// 为什么要它:进程围栏的网络行只放行 loopback 上**出网策略代理**那一个端口(process-fence-profile.ts N4)。引擎一开始监听,
// 递给插件的 `input.client` 就改用 TCP 连 `Server.url`(上游 plugin/index.ts)—— 在出货形态下,这条 loopback 连接被 seatbelt
// 拒掉(实测判据在 process-fence-engine.test.ts 的 #1531 两臂)。ext 的重载调度器要问引擎「这个实例有没有会话在忙」并 dispose,
// 走那条 client 就永远「查不到 ⇒ 零 dispose」。
//
// sidecar 与 ext 是两个独立 bundle,互相 import 不到,也不能往插件模块上多挂导出(引擎把插件模块的每个导出都当插件调用)。
// 所以交接走进程级的全局 symbol:sidecar 在 import 引擎之后挂上进程内的 `app.fetch`(与本进程 prewarm 同一调用方式,
// 不经 TCP),ext 按需取用;没人挂(CLI / 测试宿主)就是 undefined,调用方自己决定退回什么。
// 本文件零依赖(ext 经相对路径 import,与 alpha-sidecar-messages.ts 同一先例)。

export type EngineFetch = (request: Request) => Response | Promise<Response>

const KEY = Symbol.for("alpha.engine.in-process-fetch")

export function publishInProcessEngine(fetch: EngineFetch): void {
  ;(globalThis as Record<symbol, unknown>)[KEY] = fetch
}

export function inProcessEngine(): EngineFetch | undefined {
  const fetch = (globalThis as Record<symbol, unknown>)[KEY]
  return typeof fetch === "function" ? (fetch as EngineFetch) : undefined
}
