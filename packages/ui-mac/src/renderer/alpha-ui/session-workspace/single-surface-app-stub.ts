// @opencode-ai/app 在单一审批面运行时闸门 bundle 里的**录音**替身(#619 R1 Blocker 复审)。
//
// 关键设计:dock/composer 链路能拿到的每一个 SDK client 都是同一个 recording proxy ——
// 任何属性路径的**运行时**调用都会记入 dockClientCalls,包括
// `client.v2.session["permission"]["reply"]` 这类方括号等义改写(属性访问在 proxy 上
// 没有拼写豁免)。「决定只到达 Permission surface client」因此是行为级判据,不再依赖
// 源码文本匹配。
//
// 端点策略:
// - v2.session.permission.list 成功返回空快照 —— 让 dock 的 PermissionV2 feed 进入
//   ready,审批挂起提示可被事件驱动;
// - 其余端点一律返回永不 settle 的 promise —— 模型链/用量环等消费方停在 loading 态,
//   两次 DOM 快照之间零无关状态翻转,也不会产生未处理拒绝。

// #668:dock 的审批读面来自 `@opencode-ai/app` 的双通道适配器。这里**按相对路径再导出真身**
// (而不是重写一个替身)—— 否则 harness 测的就不是生产适配逻辑了。alias 只替换 barrel 的
// 那些 context hook,适配器本体照旧被打进 bundle。
export { createPermissionChannelSource } from "../../../../../app/src/context/permission-v1-adapter"

export type RecordedClientCall = { path: string; args: unknown[] }

/** dock/composer 侧全部 SDK 出口的运行时调用记录(路径按属性访问链拼接)。 */
export const dockClientCalls: RecordedClientCall[] = []

const askedHandlers = new Set<(event: unknown) => void>()
const repliedHandlers = new Set<(event: unknown) => void>()
const askedV1Handlers = new Set<(event: unknown) => void>()
const repliedV1Handlers = new Set<(event: unknown) => void>()

export function resetSingleSurfaceStub() {
  dockClientCalls.splice(0)
  askedHandlers.clear()
  repliedHandlers.clear()
  askedV1Handlers.clear()
  repliedV1Handlers.clear()
}

function makeRecorder(path: string[]): unknown {
  const callable: (...args: unknown[]) => unknown = () => undefined
  return new Proxy(callable, {
    get(_target, property) {
      if (typeof property === "symbol" || property === "then") return undefined
      return makeRecorder([...path, String(property)])
    },
    apply(_target, _thisValue, args) {
      const joined = path.join(".")
      dockClientCalls.push({ path: joined, args })
      if (joined === "v2.session.permission.list") return Promise.resolve({ data: { data: [] } })
      // #668:dock 的读面变成 v1+v2 合并快照,两条 list 都必须成功 feed 才 ready(fail-closed)。
      if (joined === "permission.list") return Promise.resolve({ data: [] })
      return new Promise(() => {})
    },
  })
}

/** dock 顶层 client 与 dir 作用域 client 同源:一切出口都被记录。 */
export const recordingClient = makeRecorder([])

/** 生产相位注入:dir 事件通道(SSE typed 分发)向 dock 投递审批事件。 */
export function emitDockPermissionAsked(properties: unknown) {
  for (const handler of [...askedHandlers]) handler({ properties })
}

export function emitDockPermissionReplied(properties: unknown) {
  for (const handler of [...repliedHandlers]) handler({ properties })
}

/** #668:v1 通道的生产相位注入(dock 现在同时订阅 `permission.asked`)。 */
export function emitDockPermissionV1Asked(properties: unknown) {
  for (const handler of [...askedV1Handlers]) handler({ properties })
}

export function emitDockPermissionV1Replied(properties: unknown) {
  for (const handler of [...repliedV1Handlers]) handler({ properties })
}

const dirSdkContext = {
  client: recordingClient,
  event: {
    on(type: string, handler: unknown) {
      const listener = handler as (event: unknown) => void
      if (type === "permission.v2.asked") {
        askedHandlers.add(listener)
        return () => askedHandlers.delete(listener)
      }
      if (type === "permission.v2.replied") {
        repliedHandlers.add(listener)
        return () => repliedHandlers.delete(listener)
      }
      if (type === "permission.asked") {
        askedV1Handlers.add(listener)
        return () => askedV1Handlers.delete(listener)
      }
      if (type === "permission.replied") {
        repliedV1Handlers.add(listener)
        return () => repliedV1Handlers.delete(listener)
      }
      return () => {}
    },
  },
}

const serverSdk = {
  client: recordingClient,
  ensureDirSdkContext: () => dirSdkContext,
}

const serverSyncState = {
  session: { data: { todo: {}, question: {}, info: {}, message: {} } },
}

export function useServerSDK() {
  return () => serverSdk
}

export function useServerSync() {
  return () => serverSyncState
}

export function useCommand() {
  return { options: [], trigger() {} }
}
