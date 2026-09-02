// #1214 AC1 事件到达闸门的宿主上下文替身。
//
// 与 permission-dual-channel-stub 同一条纪律:**被测的传输/分发/订阅链路一行不替**
// (server-sdk.tsx、utils/refcount.ts、utils/server.ts、permission-v1-adapter.ts、
// session-permission-feed.ts 全部真身)。这里只顶替 server-sdk.tsx 顶部 import 的三个
// 宿主上下文模块(./language ./server ./global)—— 它们只被 `useServerSDK` 的 provider
// init 消费,而本闸门直接调 `createServerSdkContext`,不经过那个 provider。
// 任何用例真的走到这些函数即抛错,替身不可能静默顶替判据。

export function useLanguage(): never {
  throw new Error("arrival harness must not touch useLanguage")
}

export function useServer(): never {
  throw new Error("arrival harness must not touch useServer")
}

export function useGlobal(): never {
  throw new Error("arrival harness must not touch useGlobal")
}

// server-sdk.tsx / platform.tsx 以值形式 import `ServerConnection`,但运行期只作类型
// 命名空间使用;给一个空对象satisfy绑定即可(若被当值消费,属性访问会当场 undefined 报错)。
export const ServerConnection = {} as never

export const createServerProjects = (() => {
  throw new Error("arrival harness must not touch createServerProjects")
}) as never

export const RECENTLY_CLOSED_DISPLAY_LIMIT = 0 as never
