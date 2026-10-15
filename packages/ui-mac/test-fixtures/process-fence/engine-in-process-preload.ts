// REQ-234 `#1531`:在 bun 跑的引擎里做出货 sidecar.ts 那一步交接 —— 把引擎**进程内**的 app.fetch 挂到交接点上
// (生产交接点 packages/ui-mac/src/main/in-process-engine.ts)。引擎模块按需 import(与 `opencode serve` import 的是同一个
// 文件 URL ⇒ 同一个模块、同一个 Server.Default()),所以本 preload 不提前装载引擎,围栏仍先于引擎生效。
import { resolve } from "node:path"
import { publishInProcessEngine } from "../../src/main/in-process-engine"

const serverModule = resolve(import.meta.dir, "../../../opencode/src/server/server.ts")
publishInProcessEngine(async (request) => {
  const { Server } = (await import(serverModule)) as { Server: { Default(): { app: { fetch(request: Request): Response | Promise<Response> } } } }
  return Server.Default().app.fetch(request)
})
