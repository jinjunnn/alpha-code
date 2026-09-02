// #1214 AC1 —— 「事件到达 / 状态就绪」层闸门的运行时。
//
// 既有 permission-dual-channel 闸门把 `@/context/sdk` 整个替身掉,证明的是**对话框契约**
// (事件已经送到订阅回调之后的世界)。它 12 例全绿而真机 4/4 复现零呈现,说明缺的判据在
// 它上游:SSE wire → server-sdk 的 directory 路由分发 → dir emitter → adapter 订阅回调 →
// feed 就绪态。本运行时把这一段**全部用生产真身**接起来:
//   · `createServerSdkContext`(server-sdk.tsx 真身:SSE 消费循环、16ms 合帧、
//     `emitter.emit(directory, payload)` 分发、`createRefCountMap` 的 dir ctx 生命周期);
//   · `createPermissionChannelSource`(permission-v1-adapter.ts 真身:v1+v2 订阅 + 合并 list);
//   · `createPermissionV2Feed`(session-permission-feed.ts 真身:fail-closed 就绪态)。
// 替身只有两样:宿主上下文(见 permission-event-arrival-stub.ts)与传输(测试脚本化的
// fetch,充当引擎;SSE 帧格式与 handlers/global.ts 的 Sse.encode 输出逐字段一致)。
//
// adapter→feed 的接线逐行镜像 PermissionWatcher(permission-watcher.tsx:22-28)——
// watcher 本体(<Show> + PermissionDialog)由 dual-channel 闸门覆盖,不在这里重复挂载。

import { createRoot } from "solid-js"
import { render } from "solid-js/web"
import { PlatformProvider, type Platform } from "../../../../app/src/context/platform"
import { createServerSdkContext, type ServerSDK } from "../../../../app/src/context/server-sdk"
import type { DirectorySDK } from "../../../../app/src/context/sdk"
import { ServerScope } from "../../../../app/src/utils/server-scope"
import { createPermissionChannelSource } from "../../../../app/src/context/permission-v1-adapter"
import { createPermissionV2Feed, type PermissionV2Feed } from "./session-workspace/session-permission-feed"

export type DirHandle = { sdk: DirectorySDK; dispose: () => void }

export type AdapterProbe = {
  recorded: { asked: unknown[]; replied: unknown[]; connected: number }
  feed: PermissionV2Feed
  unsubscribe: () => void
  dispose: () => void
}

export type ArrivalHarness = {
  ctx: ServerSDK
  /** 启动生产 SSE 消费循环(server-sdk.tsx 的 start())。 */
  start: () => void
  /** 在一个独立可销毁的 reactive root 里取 dir ctx —— 模拟一个页面/组件消费者的生命周期。 */
  acquireDir: (directory: string) => DirHandle
  /** 按 PermissionWatcher 的真实接线挂 adapter + feed。 */
  attachAdapter: (dir: DirHandle, sessionID: string) => AdapterProbe
  dispose: () => void
}

export function bootArrivalHarness(opts: { url: string; fetchImpl: typeof fetch }): ArrivalHarness {
  const container = document.createElement("div")
  document.body.appendChild(container)

  const platform = { platform: "desktop", os: "macos", fetch: opts.fetchImpl } as unknown as Platform
  const server = { type: "http", http: { url: opts.url } } as Parameters<typeof createServerSdkContext>[0]

  let ctx!: ServerSDK
  const disposeRender = render(
    () => (
      <PlatformProvider value={platform}>
        {(() => {
          ctx = createServerSdkContext(server, ServerScope.local)
          return null
        })()}
      </PlatformProvider>
    ),
    container,
  )

  const probes: AdapterProbe[] = []
  const handles: DirHandle[] = []

  return {
    ctx,
    start: () => void ctx.event.start(),
    acquireDir(directory: string) {
      const handle = createRoot((dispose) => ({ sdk: ctx.ensureDirSdkContext(directory), dispose }))
      handles.push(handle)
      return handle
    },
    attachAdapter(dir: DirHandle, sessionID: string) {
      const recorded: AdapterProbe["recorded"] = { asked: [], replied: [], connected: 0 }
      const channels = createPermissionChannelSource({
        sessionID: () => sessionID,
        sdk: () => dir.sdk,
        // agent 还原的最小真实来源:一条带 agent 的 assistant 消息(同 dual-channel 闸门)。
        messages: () => [{ id: "msg_arrival_1", role: "assistant", agent: "build" }],
      })
      const feed = createPermissionV2Feed({
        list: () => channels.list(),
        reply: () => Promise.reject(new Error("arrival harness has no reply path")),
      })
      // 逐行镜像 permission-watcher.tsx 的订阅接线。
      const unsubscribe = channels.subscribe({
        asked: (request) => {
          recorded.asked.push(request)
          feed.apply({ type: "asked", request })
        },
        replied: (receipt) => {
          recorded.replied.push(receipt)
          feed.apply({ type: "replied", receipt })
        },
        connected: () => {
          recorded.connected++
          feed.load()
        },
      })
      feed.load()
      const probe: AdapterProbe = {
        recorded,
        feed,
        unsubscribe,
        dispose: () => {
          unsubscribe()
          feed.dispose()
        },
      }
      probes.push(probe)
      return probe
    },
    dispose() {
      probes.forEach((probe) => probe.dispose())
      handles.forEach((handle) => handle.dispose())
      disposeRender()
      container.remove()
    },
  }
}
