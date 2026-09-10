// REQ-159 `#1322`(AC2)—— 「这个目录成为当前工作区」的**单一咽喉**:三个入口(chip 选目录 / 侧栏 draft
// 目标解析 / deep link)最终都落在两个宿主的目录访问器上 —— 新对话页与首页的 chip(`activeWs`)、会话页的
// `live.current().identity.directory`。宿主各调一次 `useWorkspaceWritable(dir)`,探针的触发、缓存、分代
// 都只在这里(核在 workspace-writable-core.ts,零 Solid 可测)。
//
// 探针执行方 = preload 桥背后**被围栏的 sidecar**(main/workspace-write-probe.ts)。桥缺席(组件测试 harness
// / 非 Electron 宿主)⇒ unknown ⇒ 无标记,不猜。

import { createEffect, createSignal, type Accessor } from "solid-js"
import type { WorkspaceWriteProbeResult } from "../../preload/types"
import { sandboxApplied, sandboxGeneration } from "./sandbox-state"
import { createWorkspaceWritableTracker, type WorkspaceWritableTracker } from "./workspace-writable-core"

const [version, setVersion] = createSignal(0)

function bridgeProbe(directory: string): Promise<WorkspaceWriteProbeResult> {
  const probe = typeof window !== "undefined" ? window.api?.workspaceWriteProbe : undefined
  if (typeof probe !== "function") return Promise.resolve({ outcome: "unknown", detail: "preload bridge absent" })
  return probe(directory)
}

let tracker: WorkspaceWritableTracker = createWorkspaceWritableTracker(bridgeProbe, () => setVersion((v) => v + 1))

const observationOf = (directory: string | undefined) => ({
  generation: sandboxGeneration(),
  directory,
  sandbox: sandboxApplied(),
})

/**
 * 宿主挂上当前工作区的目录访问器;返回「只读」访问器(只有引擎明确回报 denied 才为 true)。
 * 目录变、引擎换代、围栏状态变 —— 任一变化都重新观察(同代同目录不重复探)。
 */
export function useWorkspaceWritable(directory: Accessor<string | undefined>): Accessor<boolean> {
  createEffect(() => tracker.observe(observationOf(directory())))
  return () => {
    version()
    return tracker.readonly(observationOf(directory()))
  }
}

/** 测试用:换一个探针实现并清空缓存。 */
export function resetWorkspaceWritableForTests(probe?: (directory: string) => Promise<WorkspaceWriteProbeResult>) {
  tracker = createWorkspaceWritableTracker(probe ?? bridgeProbe, () => setVersion((v) => v + 1))
  setVersion((v) => v + 1)
}
