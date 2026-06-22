// Data layer for the Extension Hub (定制中心). Mirrors use-projects.ts: one read client + one
// global SSE subscription, patching a Solid store in place. The "installed" truth comes from the
// SDK (mcp.status) — alpha keeps NO separate persisted install store (ADR-014 §4). The browsable
// catalog comes from the bundled resources/alpha-catalog.json.
//
// MCP install = persist to the user's opencode.jsonc via the main process (window.api.ext.persistMcp,
// durable) THEN sdk.mcp.add + connect (live, no restart). Both are needed: opencode reads config
// once and caches it (core/config.ts), so writing the file alone won't apply live; mcp.add applies
// live but is in-memory only.

import { createStore } from "solid-js/store"
import { createEffect, onCleanup, type Accessor } from "solid-js"
// CLIENT subpath only — the v2 barrel pulls Node-only deps that break the renderer (see ADR-008).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerInfo } from "../sidebar/use-projects"
import type { CatalogEntry, InstalledState, McpConfig, McpInstallSpec, RuntimeCheck } from "./catalog-types"

type Client = ReturnType<typeof createOpencodeClient>

export interface ExtensionsStore {
  /** MCP servers known to the running opencode server, keyed by name (the SDK truth). */
  mcp: Record<string, InstalledState>
  ready: boolean
  error: boolean
}

export interface ActionResult {
  ok: boolean
  reason?: string
}

export interface ExtensionsApi {
  store: ExtensionsStore
  refresh(): Promise<void>
  /** Persist (durable) + live add + connect an MCP catalog entry. env fills requiredEnvVars. */
  addMcp(entry: CatalogEntry, env?: Record<string, string>): Promise<ActionResult>
  /** Toggle a known MCP server: connect when shouldConnect, else disconnect. */
  setMcpConnected(name: string, shouldConnect: boolean): Promise<void>
  /** Remove an MCP server from the user config + disconnect. */
  removeMcp(name: string): Promise<ActionResult>
  /** True if this catalog entry is already present on the server (MCP only for now). */
  isInstalled(entry: CatalogEntry): boolean
  /** which-check the entry's runtime deps; { ok:false, missing } if a binary is absent. */
  checkRuntime(tools: string[] | undefined): Promise<RuntimeCheck>
  /** Write a user-authored skill (SKILL.md) into the globally-scanned config dir. */
  createSkill(name: string, description: string, body: string): Promise<ActionResult>
  /** Write a user-authored agent (.md) into the globally-scanned config dir. */
  createAgent(name: string, opts: { description?: string; model?: string; system: string }): Promise<ActionResult>
  /** Install a catalog skill entry by writing its SKILL.md. */
  installSkill(entry: CatalogEntry): Promise<ActionResult>
  /** Append a plugin to config `plugins` (opencode auto-installs on next launch; needs restart). */
  installPlugin(entry: CatalogEntry): Promise<ActionResult>
}

function authHeaders(info: ServerInfo): Record<string, string> | undefined {
  if (!info.username && !info.password) return undefined
  const token = btoa(`${info.username ?? ""}:${info.password ?? ""}`)
  return { Authorization: `Basic ${token}` }
}

// MCP status is a discriminated union (connected/disabled/failed/needs_auth/…). We don't hard-code
// the exact discriminant field name — derive a tag defensively so a schema tweak can't crash us.
function statusTag(info: unknown): string {
  if (!info || typeof info !== "object") return ""
  const o = info as Record<string, unknown>
  const raw = (o.status ?? o._tag ?? o.type ?? "") as string
  return String(raw).toLowerCase()
}
function isConnected(info: unknown): boolean {
  return statusTag(info).includes("connected")
}
function isDisabled(info: unknown): boolean {
  return statusTag(info).includes("disabled")
}
function statusError(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined
  const o = info as Record<string, unknown>
  const e = o.error ?? o.message
  return typeof e === "string" ? e : undefined
}

function renderHeaders(
  template: Record<string, string> | undefined,
  env: Record<string, string>,
): Record<string, string> | undefined {
  if (!template) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(template)) {
    out[k] = v.replace(/\{(\w+)\}/g, (_, name) => env[name] ?? "")
  }
  return out
}

function toMcpConfig(spec: McpInstallSpec, env: Record<string, string>): McpConfig {
  if (spec.mcpType === "remote") {
    const headers = renderHeaders(spec.headersTemplate, env)
    return { type: "remote", url: spec.url ?? "", ...(headers ? { headers } : {}) }
  }
  return {
    type: "local",
    command: spec.command ?? [],
    ...(Object.keys(env).length ? { environment: env } : {}),
  }
}

export function useExtensions(server: Accessor<ServerInfo | undefined>): ExtensionsApi {
  const [store, setStore] = createStore<ExtensionsStore>({ mcp: {}, ready: false, error: false })

  let client: Client | undefined
  let generation = 0
  let abortRef = new AbortController()

  async function loadStatus() {
    const c = client
    if (!c) return
    const gen = generation
    try {
      const { data, error } = await c.mcp.status({} as any)
      if (gen !== generation) return
      if (error || !data) {
        setStore("error", true)
        return
      }
      const next: Record<string, InstalledState> = {}
      for (const [name, info] of Object.entries(data as Record<string, unknown>)) {
        next[name] = {
          name,
          type: "mcp",
          connected: isConnected(info),
          enabled: !isDisabled(info),
          error: statusError(info),
        }
      }
      setStore("mcp", next)
      setStore("ready", true)
      setStore("error", false)
    } catch {
      /* transient — keep previous status */
    }
  }

  async function addMcp(entry: CatalogEntry, env?: Record<string, string>): Promise<ActionResult> {
    const c = client
    if (!c) return { ok: false, reason: "no server" }
    const spec = entry.installSpec
    if (!spec || spec.kind !== "mcp") return { ok: false, reason: "not an MCP entry" }
    const config = toMcpConfig(spec, env ?? {})
    // 1. Durable: write the user's opencode.jsonc first. If this fails, never touch the live server
    //    — avoids a "live but not persisted" state that vanishes on restart.
    const persisted = await window.api.ext.persistMcp(entry.name, config as unknown as Record<string, unknown>)
    if (!persisted.ok) return { ok: false, reason: persisted.reason }
    // 2. Live: add + connect (no restart). mcp.add registers in-memory and spawns; connect is a
    //    belt-and-braces no-op if already connected.
    const added = await c.mcp.add({ name: entry.name, config } as any)
    if (added.error) return { ok: false, reason: "mcp.add failed" }
    await c.mcp.connect({ name: entry.name } as any).catch(() => {})
    await loadStatus()
    return { ok: true }
  }

  async function setMcpConnected(name: string, shouldConnect: boolean) {
    const c = client
    if (!c) return
    try {
      if (shouldConnect) await c.mcp.connect({ name } as any)
      else await c.mcp.disconnect({ name } as any)
    } catch {
      /* surfaced via the refreshed status */
    }
    await loadStatus()
  }

  async function removeMcp(name: string): Promise<ActionResult> {
    const c = client
    const res = await window.api.ext.removeMcp(name)
    if (c) await c.mcp.disconnect({ name } as any).catch(() => {})
    await loadStatus()
    return res
  }

  function isInstalled(entry: CatalogEntry): boolean {
    if (entry.type !== "mcp") return false
    return entry.name in store.mcp
  }

  async function checkRuntime(tools: string[] | undefined): Promise<RuntimeCheck> {
    if (!tools || tools.length === 0) return { ok: true }
    for (const tool of tools) {
      const r = await window.api.ext.checkRuntime(tool)
      if (!r.ok) return { ok: false, missing: tool }
    }
    return { ok: true }
  }

  async function subscribe() {
    const c = client
    if (!c) return
    const gen = generation
    const abort = abortRef
    try {
      const { stream } = await c.global.event({ signal: abort.signal } as any)
      for await (const event of stream as AsyncIterable<any>) {
        if (gen !== generation) break
        const type: string = event?.payload?.type ?? ""
        if (type.startsWith("mcp")) void loadStatus()
      }
    } catch {
      /* aborted on cleanup / transient; SDK auto-reconnects */
    }
  }

  createEffect(() => {
    const info = server()
    if (!info) return
    const gen = ++generation
    abortRef = new AbortController()
    client = createOpencodeClient({ baseUrl: info.baseUrl, headers: authHeaders(info) })
    void loadStatus()
    void subscribe()
    onCleanup(() => {
      if (gen === generation) client = undefined
      abortRef.abort()
    })
  })

  async function createSkill(name: string, description: string, body: string): Promise<ActionResult> {
    return window.api.ext.writeSkill(name, description, body)
  }

  async function createAgent(
    name: string,
    opts: { description?: string; model?: string; system: string },
  ): Promise<ActionResult> {
    const lines = ["---", `description: ${(opts.description ?? name).replace(/\r?\n/g, " ")}`]
    if (opts.model) lines.push(`model: ${opts.model}`)
    lines.push("---", "", opts.system, "")
    return window.api.ext.writeAgent(name, lines.join("\n"))
  }

  async function installSkill(entry: CatalogEntry): Promise<ActionResult> {
    const body = `${entry.description}\n\n> 本技能条目来自${entry.source}(${entry.id})。如需完整脚本/正文,请补充上游内容。`
    return window.api.ext.writeSkill(entry.name, entry.description, body)
  }

  async function installPlugin(entry: CatalogEntry): Promise<ActionResult> {
    const spec = entry.installSpec
    if (!spec || spec.kind !== "plugin") return { ok: false, reason: "not a plugin entry" }
    return window.api.ext.installPlugin(spec.package)
  }

  return {
    store,
    refresh: loadStatus,
    addMcp,
    setMcpConnected,
    removeMcp,
    isInstalled,
    checkRuntime,
    createSkill,
    createAgent,
    installSkill,
    installPlugin,
  }
}
