// #1099(REQ-109):启动窗口的**第一段** —— 从 `renderer.root.mount` 到路由树真正开始渲染。
//
// 现场事实(`docs/verification/2026-08-24-req109-p95-post1083/` §4):`renderer.root.mount` 与
// `renderer.composer.mount` 之间一条事件都没有,而那段窗口在同一轮里取到过 2,612 / 4,257 /
// 12,089 ms —— 前后每一步的耗时逐项接近,**整个方差都在这段看不见的窗口里**。
//
// 这段窗口的第一道闸是 `index.tsx` 的 `ready()`:四个资源(windowCount / sidecar /
// defaultServer / locale)全部落定之前,壳只渲染 splash,路由树一行都不跑。本模块记录
// **每个资源各自落定的时刻**与**四个都落定的时刻**,于是"splash 等了多久、等的是谁"
// 从一个标量变成四条可归因的分项。
//
// 为什么是 `createComputed` 而不是 `createEffect`:solid 的 `createEffect` 是 user effect,
// 排在 render effect **之后** —— 而放行 `ready()` 的那一拍,render effect 正是"把整棵
// AppInterface 子树同步渲染出来"。用 `createEffect` 记 `renderer.shell.ready`,时间戳会落在
// 子树渲染**完成之后**,于是"等资源"与"挂树"两段耗时被压成一段,归因当场失效(这正是票面
// 第二条要防的"只知道总共慢了 4 秒")。`createComputed` 是 pure computation,整队排在所有
// render effect 之前,记下来的就是这一拍的**起点**。
//
// 纪律:只观测,不参与任何判断。本模块不导出任何被壳读回去的值,marks 打不出去(preload 桥
// 缺席)时 `markStartupTimeline` 自己就是 no-op。

import { createComputed } from "solid-js"
import { markStartupTimeline } from "../startup-timeline"

/** solid `Resource` 的观测面(只读 `loading` / `error`)。取窄接口是为了让 harness 与生产
 *  用同一个函数,而不是让本模块知道 `createResource` 的全部形状。 */
export type ShellBootResource = {
  readonly loading: boolean
  readonly error: unknown
}

export type ShellBootTimelineOptions = {
  now?: () => number
  mark?: (name: "renderer.shell.resource.settled" | "renderer.shell.ready", extra: Record<string, string | number>) => void
}

/** `index.tsx` 的 `App()` 里接一行(与 `installHomeDraftDiscardNotice` 同一形态:接线在原件,
 *  逻辑在这里)。必须在 `ready()` 的四个资源都建好之后调用。 */
export function installShellBootTimeline(
  resources: Record<string, ShellBootResource>,
  options: ShellBootTimelineOptions = {},
): void {
  const now = options.now ?? (() => performance.now())
  const mark = options.mark ?? ((name, extra) => markStartupTimeline(name, extra))
  const startedAt = now()
  const names = Object.keys(resources)
  const total = names.length
  let settled = 0
  for (const name of names) {
    const resource = resources[name]!
    let recorded = false
    createComputed(() => {
      // `loading` 与 `error` 都要读:两者都是本次落定的一部分,少读一个就少一条依赖。
      const loading = resource.loading
      const failed = resource.error !== undefined
      if (recorded || loading) return
      recorded = true
      settled += 1
      const at = now()
      mark("renderer.shell.resource.settled", {
        resource: name,
        durationMs: at - startedAt,
        outcome: failed ? "error" : "ok",
      })
      // 四个全部落定 = 壳门放行的那一拍。它与最后一条 `.settled` 同刻,分开记是因为
      // 「谁最后到」与「门什么时候开」在分析时是两个问题(前者按 resource 聚合,后者是相位边界)。
      if (settled === total) mark("renderer.shell.ready", { durationMs: at - startedAt, resources: total })
    })
  }
}
