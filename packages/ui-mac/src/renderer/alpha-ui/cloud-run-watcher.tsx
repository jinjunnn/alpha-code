// B3 云任务终态自动回流 watcher — headless AppInterface child(仿 AlphaOnboarding:
// 无 UI、app 启动即活、与路由无关)。agent 经 MCP facade 调 cloud_* 时 app 不知道 jobId,唯一发现
// 通道是 opencode firehose 的 tool part(解析核 cloud-run-core.ts);发现终态 → main 侧
// window.api.cloud.saveRun 把 status/artifacts 落 <worktree>/.code-puppy/runs/<runId>/(ADR-019)→ toast。
// 订阅范式照抄 use-extensions.ts(client + AbortController + generation + onCleanup)。

import { createEffect, onCleanup, type Accessor } from "solid-js"
// CLIENT subpath only — the v2 barrel pulls Node-only deps that break the renderer (see ADR-008).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { AlphaProjectsApi, ServerInfo } from "../sidebar/use-projects"
import { extractCloudRunHit, type CloudRunHit } from "./cloud-run-core"
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
  // message.part.updated 对同一 part 反复触发(流式);runId 首见终态才回流,其余帧拦掉。
  // saveCloudRun 本身按路径幂等,漏拦只是多一次网络拉取,不产生脏写。
  const flushed = new Set<string>()

  // saveRun 要项目根:信封 directory 可能是 sandbox 目录,映射回所属项目的 worktree,找不到则原样用。
  const worktreeFor = (directory: string): string => {
    const p = props.projects.store.projects.find((proj) => proj.directories.includes(directory))
    return p?.worktree ?? directory
  }

  async function persist(hit: CloudRunHit) {
    const target = worktreeFor(hit.directory)
    const r = await window.api.cloud.saveRun(target, hit.runId)
    if (r.ok) {
      // 发现不抢焦点 —— 只 toast,绝不自动切换视图。REQ-126 AC3(#654)下线产物工作台入口后,
      // 这里不再喂任何 badge:侧栏已没有能归零它的入口,留着就是永不归零的计数。
      pushToast({
        kind: hit.terminal === "completed" ? "success" : "info",
        title: t(hit.terminal === "completed" ? "alpha.cloud.runSaved" : "alpha.cloud.runEnded"),
        detail: `${hit.runId} → .code-puppy/runs`,
      })
    } else {
      pushToast({ kind: "error", title: t("alpha.cloud.runSaveFailed"), detail: r.reason })
    }
  }

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
        if (!hit || flushed.has(hit.runId)) continue
        flushed.add(hit.runId)
        void persist(hit).catch(() => flushed.delete(hit.runId))
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
