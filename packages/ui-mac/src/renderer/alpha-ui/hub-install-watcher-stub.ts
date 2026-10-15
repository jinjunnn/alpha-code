// REQ-234 `#1531`:hub-install-watcher.test.ts 的宿主替身 —— 只替换 @solidjs/router(读路由)与 @opencode-ai/sdk(造引擎 client),
// 被测的 PermissionWatcher / HubInstallWatcher / install-confirm / use-extensions 全是生产源码。
// 引擎 client 对任何调用都答一个「读不到」的结果(use-extensions 的状态加载按瞬断处理),不打真网络。

export let pathname = "/"
export function setPathname(next: string) {
  pathname = next
}
export function useLocation() {
  return { get pathname() {
    return pathname
  } }
}

const unreadable = (): unknown =>
  new Proxy(() => Promise.resolve({ data: undefined, error: { name: "stub" } }), { get: () => unreadable() })

export function createOpencodeClient(_config?: unknown): unknown {
  return unreadable()
}
