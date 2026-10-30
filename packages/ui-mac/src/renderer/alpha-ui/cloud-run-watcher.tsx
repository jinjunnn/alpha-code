// B3 云任务自动回流 watcher — headless AppInterface child(仿 AlphaOnboarding:
// 无 UI、app 启动即活、与路由无关)。agent 经 MCP facade 调 cloud_* 时 app 不知道 jobId,唯一发现
// 通道是 opencode firehose 的 tool part(解析核 cloud-run-core.ts)。REQ-236 #1551:发现已受理的
// dispatch(或终态查询)→ window.api.cloud.trackRun 交给 main 的 tracker 跟到产物落盘并核验;
// 去重、重试、单飞都在 main。toast 只由 main 广播的 `cloud-run-state` 驱动(交付失败不说「已回流」)。
// 订阅范式照抄 use-extensions.ts(client + AbortController + generation + onCleanup)。

import { createEffect, onCleanup, type Accessor } from "solid-js"
// CLIENT subpath only — the v2 barrel pulls Node-only deps that break the renderer (see ADR-008).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { AlphaProjectsApi, ServerInfo } from "../sidebar/use-projects"
import { extractCloudRunHit, runStateToast } from "./cloud-run-core"
import { pushToast } from "./Toast"
import { t } from "../i18n"

type Client = ReturnType<typeof createOpencodeClient>

function authHeaders(info: ServerInfo): Record<string, string> | undefined {
  if (!info.username && !info.password) return undefined
  const token = btoa(`${info.username ?? ""}:${info.password ?? ""}`)
  return { Authorization: `Basic ${token}` }
}

export function CloudRunWatcher(props: { server: Accessor<ServerInfo | undefined>; projects: AlphaProjectsApi }) {
  let generation = 0
  let abortRef = new AbortController()
  let client: Client | undefined
  // message.part.updated 对同一 part 反复触发(流式):每个 part 只交给 main 一次。不按 runId 去重 ——
  // 失败后模型再查一次状态(新 part)就是一次新的交付机会;在途与否由 main 的单飞判断。
  const seenParts = new Set<string>()
  // 本窗口交给 tracker 的 run → 上次弹过的交付结论(同一结论不重复弹;手动补下等别处触发的不弹)。
  const watched = new Map<string, string | undefined>()

  // tracker 要项目根:信封 directory 可能是 sandbox 目录,映射回所属项目的 worktree,找不到则原样用。
  const worktreeFor = (directory: string): string => {
    const p = props.projects.store.projects.find((proj) => proj.directories.includes(directory))
    return p?.worktree ?? directory
  }

  // 发现不抢焦点 —— 只 toast,绝不自动切换视图。REQ-126 AC3(#654)下线产物工作台入口后,
  // 这里不再喂任何 badge:侧栏已没有能归零它的入口,留着就是永不归零的计数。
  onCleanup(
    window.api.cloud.onRunState((state) => {
      const key = `${state.directory}\0${state.runId}`
      if (!watched.has(key)) return
      const toast = runStateToast(state)
      if (!toast || watched.get(key) === state.delivery.status) return
      watched.set(key, state.delivery.status)
      pushToast({ kind: toast.kind, title: t(toast.key), detail: toast.detail })
    }),
  )

  async function subscribe() {
    const c = client
    if (!c) return
    const gen = generation
    const abort = abortRef
    try {
      const { stream } = await c.global.event({ signal: abort.signal } as never)
      for await (const event of stream as AsyncIterable<unknown>) {
        if (gen !== generation) break
        const hit = extractCloudRunHit(event)
        if (!hit) continue
        const partKey = hit.partID ?? `${hit.directory}\0${hit.runId}\0${hit.source}`
        if (seenParts.has(partKey)) continue
        seenParts.add(partKey)
        const target = worktreeFor(hit.directory)
        const key = `${target}\0${hit.runId}`
        if (!watched.has(key)) watched.set(key, undefined)
        // 归属只由已受理的 dispatch 建立;终态查询命中只触发交付(#1551 AC4)。
        const origin =
          hit.source === "dispatch" && hit.sessionID
            ? { sessionID: hit.sessionID, messageID: hit.messageID, partID: hit.partID }
            : undefined
        void window.api.cloud.trackRun(target, hit.runId, origin)
      }
    } catch {
      /* aborted on cleanup / transient; SDK auto-reconnects */
    }
  }

  createEffect(() => {
    const info = props.server()
    if (!info) return
    const gen = ++generation
    abortRef = new AbortController()
    client = createOpencodeClient({ baseUrl: info.baseUrl, headers: authHeaders(info) })
    void subscribe()
    onCleanup(() => {
      if (gen === generation) client = undefined
      abortRef.abort()
    })
  })

  return null
}
