// Data layer for the alpha sidebar: the list of projects and, per project, its root
// conversations. We talk to the local opencode server through @opencode-ai/sdk/v2 only —
// opencode's own layout/session contexts are not exported (restrictive `exports` map), and
// the SDK is the blessed contract (ADR-002/003). We keep a single read client and a single
// SSE subscription, and patch a Solid store in place so the sidebar stays live.

// C14③ 契约锚(sync 时 `grep -n "as any"` 复核本文件):本文件全部 `as any` 都是同一类——
// SDK v2 生成类型与 server 实际接受/返回形状的已知偏斜(directory/scope/roots 扩展参数、data
// 数组元素形状、event 信封)。上游 codegen 修齐后应成批删除,不新增其它用途的 as any。
import { createStore, produce } from "solid-js/store"
import { createEffect, onCleanup, type Accessor } from "solid-js"
// Import from the CLIENT subpath, not "@opencode-ai/sdk/v2": the v2 barrel re-exports the
// server module too, which pulls in Node-only deps (process/which/child_process) that cannot
// bundle for the renderer. The client subpath is browser-safe (opencode's own app uses it).
import { createOpencodeClient, type ModelRef } from "@opencode-ai/sdk/v2/client"
import type { SidecarGenerationState } from "../../preload/types"
import { projectLabel } from "./route"
import { hiddenProjects } from "./sidebar-state"
import { isUnderSkippedWorktree, shouldSkipWorktree } from "./worktree-filter"
import {
  hasRuntimeRecoveryBridge,
  notifySseReconnected,
  subscribeRuntimeRecovery,
} from "../runtime-recovery"
import { nextEngineRetryDelay } from "../alpha-ui/model-picker-logic"

export interface ServerInfo {
  baseUrl: string
  username?: string
  password?: string
}

export interface AlphaSession {
  id: string
  title: string
  directory: string
  projectID: string
  updated: number
}

export interface AlphaProject {
  id: string
  worktree: string
  name: string
  /** Stored avatar color key (project.icon.color), if the server assigned one. */
  color?: string
  /** All directories whose sessions belong to this project: [worktree, ...sandboxes]. opencode
   *  scopes a project's sessions across these (see home.tsx `directories()`), so we must too. */
  directories: string[]
  sessions: AlphaSession[]
  /** Sessions have been fetched at least once. */
  loaded: boolean
}

export interface AlphaProjectsStore {
  projects: AlphaProject[]
  ready: boolean
  error: boolean
}

export interface AlphaProjectsApi {
  store: AlphaProjectsStore
  /** Re-fetch the project list + each project's sessions. Backs the sidebar's error-retry (B11). */
  reload(): Promise<void>
  /** Eagerly create a real session in a project directory and return its id (or undefined on
   *  failure). We create up front — rather than navigating to opencode's draft — because the
   *  draft is a *tab*, and the alpha redesign hides the tab strip, so a draft would have no
   *  representation in our sidebar. Creating means the new chat shows immediately. */
  createSession(worktree: string): Promise<string | undefined>
  /** Create a session AND send the first message (the home composer's submit). `extraParts` are
   *  additional prompt parts (agent/file mentions from the home @ menu, upstream
   *  build-request-parts shapes) appended after the text part (REQ-038). `opts`(REQ-055)是
   *  AlphaComposer 的显式提交参数(Model.Ref/agent),未选不传 = 引擎默认。 */
  startChat(
    worktree: string,
    text: string,
    extraParts?: unknown[],
    opts?: { model?: ModelRef; agent?: string },
  ): Promise<string | undefined>
  /** The live SDK v2 client (undefined until the server is ready). Exposed so alpha composer
   *  surfaces (home slash/@ menus, REQ-038) query command/agent/find with the SAME client + auth
   *  the store uses instead of instantiating a second one. */
  sdk(): ReturnType<typeof createOpencodeClient> | undefined
  /** Per-session actions via the SDK; the global event stream reconciles the store. Rename/delete
   *  resolve `false` on a transport failure so the caller can surface a toast (B11 row 13); a no-op
   *  (empty title) still resolves `true` — it is a cancel, not a failure to report. */
  renameSession(id: string, title: string): Promise<boolean>
  shareSession(id: string, directory: string): Promise<string | undefined>
  deleteSession(id: string): Promise<boolean>
  /** Fetch the session's messages and format them as markdown text for copy-to-clipboard. */
  copySession(id: string): Promise<string | undefined>
}

type Client = ReturnType<typeof createOpencodeClient>

function authHeaders(info: ServerInfo): Record<string, string> | undefined {
  if (!info.username && !info.password) return undefined
  const token = btoa(`${info.username ?? ""}:${info.password ?? ""}`)
  return { Authorization: `Basic ${token}` }
}

function toSession(raw: any): AlphaSession | undefined {
  if (!raw || typeof raw.id !== "string") return undefined
  // Only top-level conversations belong in the sidebar; sub-agent/child sessions are
  // rendered inside their parent's view, matching opencode's sortedRootSessions.
  if (raw.parentID) return undefined
  if (raw.time?.archived) return undefined
  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : "Untitled",
    directory: raw.directory,
    projectID: typeof raw.projectID === "string" ? raw.projectID : "",
    updated: raw.time?.updated ?? raw.time?.created ?? 0,
  }
}

function sortSessions(list: AlphaSession[]): AlphaSession[] {
  return [...list].sort((a, b) => b.updated - a.updated)
}

export function useAlphaProjects(
  server: Accessor<ServerInfo | undefined>,
  // #594 测试注入口:自探节奏与探测器。生产走默认(/global/health + 1s/2s/4s/8s 封顶退避)。
  probeOverrides?: {
    delayFor?: (attempt: number) => number
    probe?: (info: ServerInfo) => Promise<boolean>
  },
): AlphaProjectsApi {
  const [store, setStore] = createStore<AlphaProjectsStore>({ projects: [], ready: false, error: false })

  // The active read client + a generation token. Imperative actions (createSession) use the
  // current client; async store writes bail if a newer effect run has superseded them.
  let client: Client | undefined
  let generation = 0

  // --- store-level matching (no client needed) -----------------------------------------------
  // Prefer matching a session to its project by projectID (carried on every Session and every
  // session event) — it is exact. Directory is the fallback (a session's directory may be the
  // worktree OR any sandbox; the worktree itself always appears in `directories`).
  const indexByProjectID = (projectID?: string) =>
    projectID ? store.projects.findIndex((p) => p.id === projectID) : -1
  const indexByDirectory = (directory?: string) =>
    directory ? store.projects.findIndex((p) => p.directories.includes(directory)) : -1
  const worktreeIndex = (worktree: string) => store.projects.findIndex((p) => p.worktree === worktree)

  // --- data loads (need a client) ------------------------------------------------------------
  async function loadSessions(worktree: string) {
    const c = client
    if (!c) return
    const gen = generation
    try {
      // scope:"project" returns the project's sessions across all its directories (worktree +
      // sandboxes), so new chats created in any of them show up. throwOnError defaults false →
      // a non-2xx resolves with { error, data: undefined }; guard so a transient failure keeps
      // the prior sessions.
      // roots:true → server returns only top-level conversations (we discard children client-side
      // anyway), shrinking the payload for projects with many sub-agent sessions (A3).
      const { data, error } = await c.session.list({ directory: worktree, scope: "project", roots: true } as any)
      if (gen !== generation || error || !data) return
      const sessions = sortSessions((data as any[]).map(toSession).filter(Boolean) as AlphaSession[])
      const i = worktreeIndex(worktree)
      if (i < 0) return
      setStore(
        "projects",
        i,
        produce((p: AlphaProject) => {
          p.sessions = sessions
          p.loaded = true
        }),
      )
    } catch {
      /* leave previous sessions in place on transient failure */
    }
  }

  async function loadProjects() {
    const c = client
    if (!c) return
    const gen = generation
    try {
      // See loadSessions: a non-2xx response does NOT throw (throwOnError defaults false); it
      // resolves with { error, data: undefined }. Without this guard an HTTP error would reconcile
      // to an empty list and render the misleading "No projects" empty state.
      const { data, error } = await c.project.list()
      if (gen !== generation) return
      if (error || !data) {
        setStore("error", true)
        return
      }
      // B4(S17 T5)数据层过滤:垃圾("/"、macOS home 根)与用户归档(hidden)的 worktree 不进
      // store —— 渲染与 per-project session.list 双零请求,引擎侧也少建对应 Instance(watcher/git/
      // skills 扫描随之消失)。谓词与语义见 worktree-filter.ts。
      const incoming = (data as any[]).filter(
        (p) => typeof p?.worktree === "string" && !shouldSkipWorktree(p.worktree, hiddenProjects()),
      )
      // Reconcile: keep existing session lists for projects that persist, add new ones.
      setStore("projects", (prev) => {
        const byID = new Map(prev.map((p) => [p.id, p]))
        return incoming.map((raw): AlphaProject => {
          const existing = byID.get(raw.id)
          return {
            id: raw.id,
            worktree: raw.worktree,
            name: raw.name && raw.name.length > 0 ? raw.name : projectLabel(raw.worktree),
            color: raw.icon?.color,
            directories: [raw.worktree, ...(Array.isArray(raw.sandboxes) ? raw.sandboxes : [])],
            sessions: existing?.sessions ?? [],
            loaded: existing?.loaded ?? false,
          }
        })
      })
      setStore("ready", true)
      setStore("error", false)
      // "/" 及其它垃圾/hidden worktree 已在 incoming 层剔除(B4)——这里对留下的全量取会话。
      await Promise.all(incoming.map((raw) => loadSessions(raw.worktree)))
    } catch {
      if (gen === generation) setStore("error", true)
    }
  }

  // A session changed for some project — reload the owning project's sessions (robust: re-fetches
  // reality rather than trusting one event). If we don't know the project yet (a brand-new project,
  // e.g. the user opened a fresh directory from home and sent the first message), refetch the
  // project list, which both surfaces the new project and reloads its sessions.
  async function reloadForSession(projectID?: string, directory?: string) {
    const i = indexByProjectID(projectID)
    if (i >= 0) return loadSessions(store.projects[i].worktree)
    const j = indexByDirectory(directory)
    if (j >= 0) return loadSessions(store.projects[j].worktree)
    // B4:被剔除(垃圾/hidden)项目的会话事件不得触发 loadProjects —— load 会再次剔除,否则每个
    // 事件都白打一次 project.list(循环)。
    if (isUnderSkippedWorktree(directory, hiddenProjects())) return
    return loadProjects()
  }

  function upsertSession(raw: any) {
    const session = toSession(raw)
    if (!session) {
      // Child/archived sessions are not shown; if a previously-shown session became one, drop it.
      if (raw?.id) removeSession(raw.id, raw?.projectID, raw?.directory)
      return
    }
    let i = indexByProjectID(session.projectID)
    if (i < 0) i = indexByDirectory(session.directory)
    if (i < 0) {
      // B4:同 reloadForSession —— 被剔除项目的会话事件直接忽略,防 loadProjects 循环。
      if (isUnderSkippedWorktree(session.directory, hiddenProjects())) return
      // Session for a project we don't know yet → refetch the project list (new project appears).
      void loadProjects()
      return
    }
    setStore(
      "projects",
      i,
      produce((p: AlphaProject) => {
        const idx = p.sessions.findIndex((s) => s.id === session.id)
        if (idx >= 0) p.sessions[idx] = session
        else p.sessions.push(session)
        p.sessions = sortSessions(p.sessions)
      }),
    )
  }

  function removeSession(id: string, projectID?: string, directory?: string) {
    const apply = (i: number) =>
      setStore(
        "projects",
        i,
        produce((p: AlphaProject) => {
          p.sessions = p.sessions.filter((s) => s.id !== id)
        }),
      )
    let i = indexByProjectID(projectID)
    if (i < 0) i = indexByDirectory(directory)
    if (i >= 0) {
      apply(i)
      return
    }
    store.projects.forEach((p, idx) => {
      if (p.sessions.some((s) => s.id === id)) apply(idx)
    })
  }

  // REQ-071/ADR-025 lazy 供给:目标是默认工作目录 ~/Alpha 时先建它(main 侧只对默认目录生效,
  // 其他路径 no-op)。失败不拦——session.create 会对不存在的目录如实报错。
  async function ensureDefaultWorkspace(worktree: string): Promise<void> {
    try {
      await window.api.workspaceEnsureDefault(worktree)
    } catch {
      /* 供给是 best-effort;引擎侧错误仍会 loud */
    }
  }

  async function createSession(worktree: string): Promise<string | undefined> {
    const c = client
    if (!c) return undefined
    try {
      await ensureDefaultWorkspace(worktree)
      const { data, error } = await c.session.create({ directory: worktree } as any)
      if (error || !data) return undefined
      // Make sure the project is expanded-able / present, then insert immediately (don't wait for
      // the SSE round-trip). The global event will arrive too; upsert dedupes by id.
      if (worktreeIndex(worktree) < 0) await loadProjects()
      upsertSession(data)
      return (data as any).id as string
    } catch {
      return undefined
    }
  }

  // Start a chat from the home composer: create a session AND fire the first message, so submitting
  // on home behaves like Codex/ChatGPT (type → enter → you're in the conversation). The model/agent
  // default to the server's (we don't have opencode's model context here); promptAsync is the same
  // call opencode's own composer makes (prompt-input/submit.ts). Returns the new session id.
  //
  // "/name args" parity (REQ-038): the session composer intercepts a leading /command that matches a
  // CUSTOM command and sends it via session.command (submit.ts:77-100) — plain promptAsync would
  // deliver the slash line as literal text. Mirror that here so the home slash menu's refilled
  // commands actually execute.
  async function startChat(
    worktree: string,
    text: string,
    extraParts?: unknown[],
    opts?: { model?: ModelRef; agent?: string },
  ): Promise<string | undefined> {
    const c = client
    if (!c) return undefined
    try {
      await ensureDefaultWorkspace(worktree)
      const { data, error } = await c.session.create({
        directory: worktree,
        ...(opts?.model ? { model: opts.model } : {}),
      } as any)
      if (error || !data) return undefined
      const id = (data as any).id as string
      if (worktreeIndex(worktree) < 0) await loadProjects()
      upsertSession(data)
      const body = text.trim()
      if (body) {
        let ranCommand = false
        const [head, ...tail] = body.split(" ")
        if (head?.startsWith("/")) {
          const name = head.slice(1)
          // a transport throw here must NOT abort the send — fall through to promptAsync (codex audit)
          const { data: cmds, error: cmdErr } = await c.command
            .list({ directory: worktree } as any)
            .catch(() => ({ data: undefined, error: true }) as const)
          if (!cmdErr && Array.isArray(cmds) && cmds.some((x: any) => x?.name === name)) {
            ranCommand = true
            const command = await c.session
              .command({ sessionID: id, command: name, arguments: tail.join(" ") } as any)
              .catch(() => null)
            if (!command || command.error) return undefined
          }
        }
        if (!ranCommand) {
          const prompted = await c.session
            .promptAsync({
              sessionID: id,
              ...(opts?.agent ? { agent: opts.agent } : {}),
              parts: [{ type: "text", text: body }, ...(extraParts ?? [])],
            } as any)
            .catch(() => null)
          // A sidecar generation boundary can sever admission before the request resolves. Returning
          // undefined keeps the user's draft in the home composer and surfaces its existing send
          // failure state instead of silently navigating as though the prompt were accepted.
          if (!prompted || prompted.error) return undefined
        }
      }
      return id
    } catch {
      return undefined
    }
  }

  // --- session actions (SDK; the global event stream reconciles the store) -------------------
  async function renameSession(id: string, title: string): Promise<boolean> {
    const c = client
    if (!c) return false
    if (!title.trim()) return true // empty = cancel, not a failure to surface
    try {
      await c.session.update({ sessionID: id, title: title.trim() } as any)
      return true
    } catch {
      // hard failure (transport): the caller toasts; the session.updated event won't fire
      return false
    }
  }
  async function shareSession(id: string, directory: string): Promise<string | undefined> {
    const c = client
    if (!c) return undefined
    try {
      const { data } = await c.session.share({ sessionID: id, directory } as any)
      return (data as any)?.share?.url ?? (data as any)?.url
    } catch {
      return undefined
    }
  }
  async function deleteSession(id: string): Promise<boolean> {
    const c = client
    if (!c) return false
    try {
      await c.session.delete({ sessionID: id } as any)
      return true
    } catch {
      // hard failure: nothing was deleted and no session.deleted event will reconcile → caller toasts
      return false
    }
  }
  async function copySession(id: string): Promise<string | undefined> {
    const c = client
    if (!c) return undefined
    try {
      const { data, error } = await c.session.messages({ sessionID: id } as any)
      if (error || !data) return undefined
      const blocks: string[] = []
      for (const m of data as any[]) {
        const role = m.info?.role ?? m.role
        const parts = m.parts ?? m.info?.parts ?? []
        const text = (parts as any[])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim()
        if (!text) continue
        blocks.push(`## ${role === "user" ? "用户" : "助手"}\n${text}`)
      }
      return blocks.length > 0 ? blocks.join("\n\n") : undefined
    } catch {
      return undefined
    }
  }

  // --- live updates via the GLOBAL (unfiltered) event stream ---------------------------------
  // The per-instance /api/event stream filters events by the subscribed directory
  // (server handlers/event.ts), so a single global subscription would only ever see events for
  // ONE directory — new sessions/projects in any other directory would never arrive. /global/event
  // is the cross-directory firehose: each item is { directory, project, workspace, payload } where
  // payload is a plain { type, properties } event. This is the only way one subscription can keep
  // every project's sessions live.
  async function subscribe() {
    const c = client
    if (!c) return
    const gen = generation
    const abort = abortRef
    let retry = 0
    let connected = false
    while (gen === generation && !abort.signal.aborted) {
      try {
        const { stream } = await c.global.event({ signal: abort.signal } as any)
        if (gen !== generation || abort.signal.aborted) return
        retry = 0
        if (connected) notifySseReconnected()
        connected = true
        for await (const event of stream as AsyncIterable<any>) {
          if (gen !== generation) return
          const payload = event?.payload
          const projectID: string | undefined = event?.project ?? payload?.properties?.info?.projectID
          const directory: string | undefined = event?.directory
          switch (payload?.type) {
            case "session.created":
            case "session.updated":
              upsertSession(payload.properties?.info)
              break
            case "session.deleted":
              removeSession(
                payload.properties?.sessionID ?? payload.properties?.info?.id,
                payload.properties?.info?.projectID ?? projectID,
                payload.properties?.info?.directory ?? directory,
              )
              break
            case "session.idle":
              void reloadForSession(projectID, directory)
              break
            case "project.updated":
            case "project.directories.updated":
              void loadProjects()
              break
          }
        }
      } catch {
        // The sidecar generation bridge normally rebuilds the client. This bounded loop also covers
        // an isolated SSE transport drop without requiring a page reload.
      }
      if (gen !== generation || abort.signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 250 * 2 ** retry++)))
    }
  }

  let abortRef = new AbortController()
  let serverInfo: ServerInfo | undefined
  let connectedSidecarGeneration = -1
  let bridgeFallbackTimer: ReturnType<typeof setTimeout> | undefined
  let runtimeStateReceived = false
  let runtimeState: SidecarGenerationState | undefined

  const connect = (info: ServerInfo, sidecarGeneration: number) => {
    const gen = ++generation
    abortRef.abort()
    abortRef = new AbortController()
    connectedSidecarGeneration = sidecarGeneration
    client = createOpencodeClient({
      baseUrl: info.baseUrl,
      headers: authHeaders(info),
    })

    void loadProjects()
    void subscribe()
    return gen
  }

  // #594 闩死点一:client 重建不能无限期押在「ready 事件必达」上 —— #577 一类 producer 事故
  // 会让 ready 永不到达(preload 回放的 recovering 又把 1s 兜底永久解除武装);failed 终态
  // (#577)则明确 ready 不会再来,而引擎可能随后活了。收到 recovering/failed 后武装有界自探:
  // 封顶退避轮询引擎 /global/health,可达即按 generation 现值乐观重建 client;ready 事件到达
  // 或 client 已重建则自探退役。自探只在健康探测真实通过后才重建 —— failed 绝不被当成 ready。
  const probeDelayFor = probeOverrides?.delayFor ?? nextEngineRetryDelay
  const probeEngine =
    probeOverrides?.probe ??
    (async (info: ServerInfo): Promise<boolean> => {
      try {
        const res = await fetch(new URL("/global/health", info.baseUrl), {
          headers: authHeaders(info),
          signal: AbortSignal.timeout(2_000),
        })
        return res.ok
      } catch {
        return false
      }
    })
  let selfProbeTimer: ReturnType<typeof setTimeout> | undefined
  let selfProbeAttempt = 0

  const stopSelfProbe = () => {
    clearTimeout(selfProbeTimer)
    selfProbeTimer = undefined
    selfProbeAttempt = 0
  }

  const scheduleSelfProbe = () => {
    clearTimeout(selfProbeTimer)
    selfProbeTimer = setTimeout(() => void runSelfProbe(), probeDelayFor(selfProbeAttempt++))
  }

  const runSelfProbe = async () => {
    if (client) return stopSelfProbe() // ready 已到、client 已重建 → 自探退役
    if (!serverInfo) return scheduleSelfProbe() // server info 未就绪(冷启动竞态)→ 稍后再探
    const reachable = await probeEngine(serverInfo)
    if (client) return stopSelfProbe() // 探测期间 ready 已重建
    if (!reachable || !serverInfo) return scheduleSelfProbe()
    stopSelfProbe()
    connect(serverInfo, runtimeState?.generation ?? connectedSidecarGeneration)
  }

  const unsubscribeRuntime = subscribeRuntimeRecovery((state) => {
    runtimeStateReceived = true
    runtimeState = state
    clearTimeout(bridgeFallbackTimer)
    if (state.status === "recovering") {
      generation++
      client = undefined
      abortRef.abort()
      stopSelfProbe()
      scheduleSelfProbe()
      return
    }
    if (state.status === "failed") {
      // #577 终态:本代 ready 不会再来。执行面保持关闭(不盲目重建 client),
      // 只靠自探自证 —— 引擎真实可达才重建。
      stopSelfProbe()
      scheduleSelfProbe()
      return
    }
    stopSelfProbe()
    if (!serverInfo || (state.generation === connectedSidecarGeneration && client)) return
    connect(serverInfo, state.generation)
  })

  createEffect(() => {
    serverInfo = server()
    if (!serverInfo) return
    if (!hasRuntimeRecoveryBridge()) {
      connect(serverInfo, 0)
      return
    }
    if (runtimeState?.status === "ready") {
      if (!client || runtimeState.generation !== connectedSidecarGeneration)
        connect(serverInfo, runtimeState.generation)
      return
    }
    // recovering/failed 由自探兜底(scheduleSelfProbe)接管重建,不在此处盲连;
    // 下面的 1s 兜底只覆盖「从未收到任何 generation 状态」。
    if (runtimeStateReceived) return
    clearTimeout(bridgeFallbackTimer)
    bridgeFallbackTimer = setTimeout(() => {
      if (serverInfo && !client) connect(serverInfo, connectedSidecarGeneration)
    }, 1_000)
  })

  onCleanup(() => {
    generation++
    client = undefined
    abortRef.abort()
    clearTimeout(bridgeFallbackTimer)
    stopSelfProbe()
    unsubscribeRuntime()
  })

  return {
    store,
    reload: () => loadProjects(),
    createSession,
    startChat,
    sdk: () => client,
    renameSession,
    shareSession,
    deleteSession,
    copySession,
  }
}
