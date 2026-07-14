// Data layer for the Extension Hub (定制中心). Mirrors use-projects.ts: one read client + one
// global SSE subscription, patching a Solid store in place. The "installed" truth comes from the
// SDK (mcp.status) — alpha keeps NO separate persisted install store (ADR-014 §4). The browsable
// catalog comes from the bundled resources/alpha-catalog.json.
//
// MCP install = persist to the user's opencode.jsonc via the main process (window.api.ext.persistMcp,
// durable) THEN sdk.mcp.add + connect (live, no restart). Both are needed: opencode reads config
// once and caches it (core/config.ts), so writing the file alone won't apply live; mcp.add applies
// live but is in-memory only.

// C14③ 契约锚(sync 时 `grep -n "as any"` 复核本文件):本文件全部 `as any` 都是同一类——
// SDK v2 生成类型与 server 实际接受/返回形状的已知偏斜(directory/scope/roots 扩展参数、data
// 数组元素形状、event 信封)。上游 codegen 修齐后应成批删除,不新增其它用途的 as any。
import { createStore } from "solid-js/store"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
// CLIENT subpath only — the v2 barrel pulls Node-only deps that break the renderer (see ADR-008).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerInfo } from "../sidebar/use-projects"
import type { CatalogEntry, InstalledState, McpConfig, McpInstallSpec, RuntimeCheck } from "./catalog-types"
import type { InstallReceipt } from "../../preload/types"

// Receipt provenance (REQ-018): catalog snapshot version recorded per install → update checks.

type Client = ReturnType<typeof createOpencodeClient>

/** An agent the engine knows about (SDK app.agents) — built-in (native) or alpha-created.
 *  REQ-019 T3:补详情页所需字段(model/variant/prompt/permission),形状 = SDK v2 Agent。 */
export interface HubAgent {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  model?: { modelID: string; providerID: string }
  variant?: string
  prompt?: string
  permission?: { permission: string; pattern: string; action: string }[]
}

export interface ExtensionsStore {
  /** MCP servers known to the running opencode server, keyed by name (the SDK truth). */
  mcp: Record<string, InstalledState>
  /** Install receipts (REQ-018): alpha's record of what we installed — the "installed" truth for
   *  skill/agent/plugin, which the SDK MCP status can't cover. Global scope for the hub list. */
  receipts: InstallReceipt[]
  /** Agents the engine knows (REQ-018 T7 Agent tab): built-in + alpha-created (via SDK app.agents). */
  agents: HubAgent[]
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
  /**
   * Persist (durable) + live add + connect an MCP catalog entry. `secrets` fills requiredEnvVars and
   * is routed to the {file:} channel on disk (never plaintext); `env` is non-secret substitution
   * (headers/workspace). Live add uses the real secret values (in-memory, just typed).
   */
  addMcp(
    entry: CatalogEntry,
    env?: Record<string, string>,
    workspace?: string,
    secrets?: Record<string, string>,
  ): Promise<ActionResult>
  /** REQ-033:catalog 外任意 MCP(local command / remote url + env/密钥);白名单校验在 main 不放宽。 */
  addCustomMcp(
    name: string,
    input: { mcpType: "local" | "remote"; command?: string[]; url?: string },
    env: Record<string, string>,
    secrets: Record<string, string>,
  ): Promise<ActionResult>
  /** Toggle a known MCP server: connect when shouldConnect, else disconnect. */
  setMcpConnected(name: string, shouldConnect: boolean): Promise<void>
  /** Remove an MCP server from the user config + disconnect. */
  removeMcp(name: string): Promise<ActionResult>
  /** Uninstall any installed item by its receipt (fs/plugin/mcp) — files/config/secrets + receipt. */
  uninstall(receipt: InstallReceipt): Promise<ActionResult>
  /** True if this catalog entry is already installed (MCP via SDK truth; others via receipts). */
  isInstalled(entry: CatalogEntry): boolean
  /** which-check the entry's runtime deps; { ok:false, missing } if a binary is absent. */
  checkRuntime(tools: string[] | undefined): Promise<RuntimeCheck>
  /** REQ-036 出厂技能名单(skills.paths 注入;逃生开关关闭时为空)——hub 据此把对应 catalog
   *  条目呈现为「出厂内置」而非可安装(S18 X1)。创建类操作已技能化,不再有表单写入方法。 */
  factorySkills(): string[]
  /** Install a catalog skill entry by writing its SKILL.md. */
  installSkill(entry: CatalogEntry): Promise<ActionResult>
  /** REQ-018 T4:释放全部引擎实例(POST /global/dispose)→ 下一请求惰性重建重扫,免重启生效。 */
  refreshEngine(): Promise<boolean>
  /** REQ-018 T7:刷新引擎已知的 agents(内置 + 自建)供 Agent tab 呈现。 */
  reloadAgents(): Promise<void>
  /** Append a plugin to config `plugins` (opencode auto-installs on next launch; needs restart). */
  installPlugin(entry: CatalogEntry): Promise<ActionResult>
  /**
   * REQ-019 T5:按 catalog 当前钉版更新已装条目。skill = 覆盖重装(同名 dest,receipt 版本翻新);
   * plugin = 卸旧配置项再写新钉版(persistPlugin 只会追加,直接重装会留旧版残留)。
   * MCP 不走此方法 —— persistMcp 是覆盖写,静默重装会丢 {file:} 密钥引用;hub 层用确认框重装
   * (密钥可重填),见 extension-hub.runUpdate。
   */
  updateEntry(entry: CatalogEntry): Promise<ActionResult>
  /** REQ-019 T6 / REQ-098 #255:导入本地技能文件夹(main 自弹选择器,renderer 不传 srcDir)。 */
  importSkillFolder(): Promise<ActionResult & { name?: string; canceled?: boolean }>
  /** REQ-019 T6:导入 Git 仓库技能(https-only 浅克隆临时目录 → 同校验)。 */
  importSkillGit(url: string): Promise<ActionResult & { name?: string }>
  /** REQ-019 T6:npm 插件导入 = 复用 persistPlugin 通道(主进程包名白名单)。 */
  importNpmPlugin(pkg: string): Promise<ActionResult>
  /** REQ-023:安装 catalog 官方 agent(vendored md 资产 → writeAgent 同管线)。 */
  installAgentEntry(entry: CatalogEntry): Promise<ActionResult>
  /** REQ-020 T4:启用云 pipeline = receipts-only(进本机可用列表;不落文件、不写引擎 config)。
   *  停用走 uninstall(cloud receipt → 去账)。 */
  enableCloud(entry: CatalogEntry): Promise<ActionResult>
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

// China mirrors for first-run package downloads (uvx→PyPI, npx→npm). Applied only for zh locales.
// Unknown vars are ignored by the other tool, and a wrong mirror merely falls back to the default —
// never fatal (unlike a bad config key). Users can override in opencode.jsonc.
const IS_CN = typeof navigator !== "undefined" && /^zh\b/i.test(navigator.language ?? "")
const CN_MIRROR_ENV: Record<string, string> = IS_CN
  ? {
      UV_DEFAULT_INDEX: "https://pypi.tuna.tsinghua.edu.cn/simple",
      PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple",
      npm_config_registry: "https://registry.npmmirror.com",
    }
  : {}

function toMcpConfig(spec: McpInstallSpec, env: Record<string, string>, workspace?: string): McpConfig {
  if (spec.mcpType === "remote") {
    const headers = renderHeaders(spec.headersTemplate, env)
    return { type: "remote", url: spec.url ?? "", ...(headers ? { headers } : {}) }
  }
  // Substitute the {workspace} placeholder — filesystem/git need a real directory the user picked.
  const command = (spec.command ?? []).map((arg) => (workspace ? arg.split("{workspace}").join(workspace) : arg))
  const environment = { ...CN_MIRROR_ENV, ...env }
  return {
    type: "local",
    command,
    ...(Object.keys(environment).length ? { environment } : {}),
  }
}

// Cap how long we wait on the live add/connect. opencode spawns the server synchronously, and a
// first-run `uvx`/`npx` can download from PyPI/npm (slow, or stalls on a blocked registry). The
// config is already persisted by then, so on timeout we stop waiting and report "slow" rather than
// hang the UI forever — the server keeps connecting in the background / on next launch.
const TIMED_OUT = Symbol("timeout")
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([p, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))])
}

export function useExtensions(server: Accessor<ServerInfo | undefined>, active?: Accessor<boolean>): ExtensionsApi {
  const [store, setStore] = createStore<ExtensionsStore>({ mcp: {}, receipts: [], agents: [], ready: false, error: false })

  let client: Client | undefined
  let generation = 0
  let abortRef = new AbortController()

  // REQ-018:安装账本(global ~/.alpha)。receipts 覆盖 skill/agent/plugin 的「已安装」真相
  // (SDK 的 mcp.status 只认 MCP);每次安装/卸载后刷新。
  async function loadInstalls() {
    try {
      const view = await window.api.ext.listInstalls()
      setStore("receipts", view.global)
    } catch {
      /* transient — keep previous */
    }
  }

  // REQ-018 T7:引擎已知的 agents(内置 + alpha 自建)。SDK 真相源(app.agents);hidden 的过滤掉。
  async function loadAgents() {
    const c = client
    if (!c) return
    const gen = generation
    try {
      const { data, error } = await c.app.agents({} as any)
      if (gen !== generation || error || !data) return
      const list = (data as HubAgent[]).filter((a) => !a.hidden)
      setStore("agents", list)
    } catch {
      /* transient — keep previous */
    }
  }

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

  async function addMcp(
    entry: CatalogEntry,
    env?: Record<string, string>,
    workspace?: string,
    secrets?: Record<string, string>,
  ): Promise<ActionResult> {
    const c = client
    if (!c) return { ok: false, reason: "no server" }
    const spec = entry.installSpec
    if (!spec || spec.kind !== "mcp") return { ok: false, reason: "not an MCP entry" }
    // REQ-099 #305:catalog MCP 切 main-owned installCatalog —— name/config 由 main 从已验签 catalog
    // 派生,renderer 只交 grants(secrets/env/workspace)+ cnMirror 偏好(镜像 env 值为 main 侧常量,
    // 顶替此前 renderer 侧的 CN_MIRROR_ENV 注入)。durable 落盘含 {file:} 引用与 main 策略(如 Excel
    // 受管根);live 配置由 main 回传(策略后 + 密钥真值)再 mcp.add 免重启连接。
    const secretsClean = secrets ? Object.fromEntries(Object.entries(secrets).filter(([, v]) => (v ?? "").length > 0)) : {}
    const grants = {
      ...(Object.keys(secretsClean).length ? { secrets: secretsClean } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
      ...(workspace ? { workspace } : {}),
      ...(IS_CN ? { cnMirror: true } : {}),
    }
    const r = await window.api.ext.installCatalog({
      catalogId: entry.id,
      scope: { scope: "global" },
      ...(Object.keys(grants).length ? { grants } : {}),
    })
    if (!r.ok) return r
    // Codex review #350:MCP 成功结果必须带 liveMcp —— 缺失 = main 已按其它 kind 落盘(catalog
    // 漂移),静默 ok 会装错类型还报成功;显式失败并如实说明已落盘事实。
    if (!r.liveMcp) {
      await Promise.all([loadStatus(), loadInstalls()])
      return { ok: false, reason: `catalog kind mismatch: expected mcp, got "${r.kind}"(条目已按实际类型落盘,未激活连接)` }
    }
    return liveAddAndConnect(r.liveMcp.name, r.liveMcp.config)
  }

  // mcp.add + connect 的共享 live 段(config 已持久化在先;catalog 与自定义连接器同路径)。
  async function liveAddAndConnect(name: string, config: unknown): Promise<ActionResult> {
    const c = client
    if (!c) return { ok: false, reason: "no server" }
    const added = await withTimeout(c.mcp.add({ name, config } as any), 15000)
    if (added === TIMED_OUT) {
      void loadStatus()
      return { ok: true, reason: "slow" } // persisted; connecting in background / on next launch
    }
    if ((added as { error?: unknown }).error) return { ok: false, reason: "mcp.add failed" }
    await withTimeout((c.mcp.connect({ name } as any) as Promise<unknown>).catch(() => {}), 10000)
    await Promise.all([loadStatus(), loadInstalls()])
    return { ok: true }
  }

  // 未策展自定义连接器:persist(先写盘防「live 未持久」,不带 meta —— 无 catalog 身份)→ live 段。
  async function persistAndConnectMcp(name: string, config: McpConfig, secretVars?: string[]): Promise<ActionResult> {
    const c = client
    if (!c) return { ok: false, reason: "no server" }
    // Durable first: write the alpha-owned config. If this fails, never touch the live server —
    // avoids a "live but not persisted" state that vanishes on restart. Main file-ifies the
    // secretVars → opencode.jsonc gets {file:} refs, never the plaintext secret.
    const persisted = await window.api.ext.persistMcp(name, config as unknown as Record<string, unknown>, secretVars)
    if (!persisted.ok) return { ok: false, reason: persisted.reason }
    return liveAddAndConnect(name, config)
  }

  // REQ-033:任意 MCP 手动添加(catalog 外;跨生态主通道)。校验主体在 main(persistMcp 的 C2
  // 命令/URL/env 白名单**不因自定义入口放宽**);meta 无 catalogId → 账本 origin "created"。
  async function addCustomMcp(
    name: string,
    input: { mcpType: "local" | "remote"; command?: string[]; url?: string },
    env: Record<string, string>,
    secrets: Record<string, string>,
  ): Promise<ActionResult> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) return { ok: false, reason: "名称只能含字母数字 . _ -(1-64 位)" }
    const spec: McpInstallSpec =
      input.mcpType === "remote"
        ? { kind: "mcp", mcpType: "remote", url: input.url ?? "", requiredEnvVars: [] }
        : { kind: "mcp", mcpType: "local", command: input.command ?? [], requiredEnvVars: [] }
    if (input.mcpType === "remote" && !spec.url) return { ok: false, reason: "URL 必填" }
    if (input.mcpType === "local" && !(spec.command ?? []).length) return { ok: false, reason: "命令必填" }
    const config = toMcpConfig(spec, { ...env, ...secrets })
    const secretVars = Object.keys(secrets).filter((k) => (secrets[k] ?? "").length > 0)
    return persistAndConnectMcp(name, config, secretVars.length ? secretVars : undefined)
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
    // MCP: live SDK truth (also covers pre-receipt installs). skill/agent/plugin/bundle: receipts,
    // matched by catalog id (bundle = all its required items present).
    if (entry.type === "mcp") return entry.name in store.mcp || store.receipts.some((r) => r.id === entry.id)
    if (entry.type === "bundle") {
      const required = (entry.bundleItems ?? []).filter((it) => !it.optional).map((it) => it.catalogEntryId)
      return required.length > 0 && required.every((id) => store.receipts.some((r) => r.id === id) || mcpNameForId(id))
    }
    return store.receipts.some((r) => r.id === entry.id)
  }

  // A catalog id that resolves to a live MCP server name (for bundle completeness against SDK truth).
  function mcpNameForId(id: string): boolean {
    return store.receipts.some((r) => r.id === id && r.name in store.mcp)
  }

  /** REQ-100 #313:卸载切 key-based v2 —— renderer 只提供 type/name/scope(新构普通对象,顺带消掉
   *  REQ-016 的 store-Proxy 过桥问题),receipt 事实由 main 账本自查;generation skill 在 main 走
   *  锁内 journaled teardown。hub 列表 = global 账本视图(loadInstalls 只取 view.global)→ 恒 global。 */
  async function uninstall(receipt: InstallReceipt): Promise<ActionResult> {
    // 账本外的 live MCP(手工/迁移前,hub 合成 receipt 行):v2 按账本自查会诚实拒「not installed」,
    // 这类走既有 name-based removeMcp(config 名单键移除 + live disconnect),与旧行为一致。
    if (receipt.type === "mcp" && !store.receipts.some((r) => r.type === "mcp" && r.name === receipt.name))
      return removeMcp(receipt.name)
    const res = await window.api.ext.uninstallV2({ type: receipt.type, name: receipt.name, scope: "global" })
    if (receipt.type === "mcp") await client?.mcp.disconnect({ name: receipt.name } as any).catch(() => {})
    await Promise.all([loadStatus(), loadInstalls()])
    // fs/plugin removal needs a rescan;cloud 只动账本(引擎无状态)无需 dispose。
    if (res.ok && receipt.type !== "mcp" && receipt.type !== "cloud") await refreshEngine()
    if (receipt.type === "agent") void loadAgents()
    return res
  }

  // REQ-018 T4(免重启生效):fs 类安装(skill/agent/plugin)写盘后,引擎按目录缓存的实例不会
  // 重扫(上游 InstanceState 无文件监听)——不触发重建就是 placebo 安装。S12 spike 实测:
  // POST /global/dispose 8ms 返回,下一请求 ~100-300ms 惰性重建并重扫,经 symlink 桥的
  // skill/agent 立即可见;系统提示与工具集每条消息重组 → 当前会话下一条消息即可用。残余风险
  // (dispose 打断活跃流)在 T8 真机批验证;失败兜底 =「待重载」态(receipts ⨝ SDK,T6)。
  async function refreshEngine(): Promise<boolean> {
    const c = client
    if (!c) return false
    try {
      const r = await withTimeout((c as any).global.dispose() as Promise<unknown>, 5000)
      return r !== TIMED_OUT
    } catch {
      return false
    }
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

  // A2 (lazy): stay dormant until the hub is first opened — no mcp.status fetch / 3rd SSE at startup.
  // `active` (the hub's open accessor) is tracked, so the first open re-runs this effect and connects;
  // once activated we latch so later closes don't tear down the live connection. Eager if omitted.
  let activated = false
  createEffect(() => {
    const info = server()
    if (!info) return
    if (active && !active() && !activated) return
    activated = true
    const gen = ++generation
    abortRef = new AbortController()
    client = createOpencodeClient({ baseUrl: info.baseUrl, headers: authHeaders(info) })
    void loadStatus()
    void loadInstalls()
    void loadAgents()
    void subscribe()
    onCleanup(() => {
      if (gen === generation) client = undefined
      abortRef.abort()
    })
  })

  // REQ-036:出厂技能名单(一次取回缓存;失败诚实为空 = 不显「出厂内置」徽标,条目退回可安装态)。
  const [factoryIds, setFactoryIds] = createSignal<string[]>([])
  void window.api.ext
    .factorySkillIds()
    .then((ids) => setFactoryIds(Array.isArray(ids) ? ids : []))
    .catch(() => {})

  async function installSkill(entry: CatalogEntry): Promise<ActionResult> {
    const spec = entry.installSpec
    if (spec?.kind !== "skill") return { ok: false, reason: "not a skill entry" }
    // REQ-100 #313(补 #310):单装与 bundle 同入口 —— main-owned installCatalog。renderer 仍只传
    // catalogId(codex H1 信任边界:main 从已验签 catalog 派生 name/清单/版本,remote sha256 钉死、
    // builtin 同源校验都在 main);skill 落不可变 generation 事务 → 可列代/离线回滚,不再走旧 flat
    // 通道。「内容未随版本打包」的诚实失败由 planner 原样上抛。
    const r = await window.api.ext.installCatalog({ catalogId: entry.id, scope: { scope: "global" } })
    if (!r.ok) return r
    await loadInstalls()
    if (!(await refreshEngine())) return { ok: true, reason: "reload-pending" }
    return r
  }

  async function installPlugin(entry: CatalogEntry): Promise<ActionResult> {
    const spec = entry.installSpec
    if (!spec || spec.kind !== "plugin") return { ok: false, reason: "not a plugin entry" }
    // REQ-099 #305:catalog 插件切 installCatalog(vendored/npm 分支由 planner 从已验签条目裁决)。
    // dispose 触发实例重建 → 引擎立刻装载(vendored=本地即读;npm=后台下载);失败不降级为错误,
    // config 已落盘、下次重建自然装载。
    const r = await window.api.ext.installCatalog({ catalogId: entry.id, scope: { scope: "global" } })
    if (r.ok) {
      await loadInstalls()
      await refreshEngine()
    }
    return r
  }

  /** 安装 catalog 官方 agent(REQ-099 #305:切 installCatalog —— remote/builtin 分支与「内容未打包」
   *  诚实失败均由 planner 从已验签条目裁决;写盘/桥/账本走 writeAgent 同管线)。 */
  async function installAgentEntry(entry: CatalogEntry): Promise<ActionResult> {
    const spec = entry.installSpec
    if (!spec || spec.kind !== "agent") return { ok: false, reason: "not an agent entry" }
    const r = await window.api.ext.installCatalog({ catalogId: entry.id, scope: { scope: "global" } })
    if (!r.ok) return r
    await loadInstalls()
    const refreshed = await refreshEngine()
    void loadAgents()
    if (!refreshed) return { ok: true, reason: "reload-pending" }
    return r
  }

  // REQ-019 T6:导入。成功后刷新账本 + dispose 重载(与 createSkill 同节奏);失败原因原样上抛,
  // 由 hub 行内呈现(B11)。npm 导入 = 复用 persistPlugin 通道(白名单校验在主进程)。
  async function importSkillFolder(): Promise<ActionResult & { name?: string; canceled?: boolean }> {
    // REQ-098 #255:main 自弹目录选择器,renderer 不再传 srcDir。
    const r = await window.api.ext.importSkillFolder()
    if (!r.ok) return r
    await loadInstalls()
    if (!(await refreshEngine())) return { ok: true, name: r.name, reason: "reload-pending" }
    return { ok: true, name: r.name }
  }
  async function importSkillGit(url: string): Promise<ActionResult & { name?: string }> {
    const r = await window.api.ext.importSkillGit(url)
    if (!r.ok) return r
    await loadInstalls()
    if (!(await refreshEngine())) return { ok: true, name: r.name, reason: "reload-pending" }
    return { ok: true, name: r.name }
  }
  async function importNpmPlugin(pkg: string): Promise<ActionResult> {
    const r = await window.api.ext.installPlugin(pkg)
    if (!r.ok) return r
    await loadInstalls()
    await refreshEngine()
    return r
  }

  /** REQ-020 T4 / REQ-099 #305:云 pipeline「启用」= receipts-only,切 installCatalog(planner cloud
   *  分支同语义:不触达引擎/文件系统,只落账)。 */
  async function enableCloud(entry: CatalogEntry): Promise<ActionResult> {
    if (entry.type !== "cloud") return { ok: false, reason: "not a cloud entry" }
    const r = await window.api.ext.installCatalog({ catalogId: entry.id, scope: { scope: "global" } })
    if (!r.ok) return { ok: false, reason: r.reason }
    await loadInstalls()
    return { ok: true }
  }

  async function updateEntry(entry: CatalogEntry): Promise<ActionResult> {
    if (entry.type === "skill") return installSkill(entry)
    if (entry.type === "plugin") {
      const old = store.receipts.find((r) => r.id === entry.id && r.type === "plugin")
      if (old) {
        const removed = await window.api.ext.uninstallV2({ type: "plugin", name: old.name, scope: "global" })
        if (!removed.ok) return removed
      }
      return installPlugin(entry)
    }
    return { ok: false, reason: "unsupported type for update" }
  }

  return {
    store,
    refresh: loadStatus,
    addMcp,
    addCustomMcp,
    setMcpConnected,
    removeMcp,
    uninstall,
    isInstalled,
    checkRuntime,
    factorySkills: () => factoryIds(),
    installSkill,
    refreshEngine,
    reloadAgents: loadAgents,
    installPlugin,
    updateEntry,
    importSkillFolder,
    importSkillGit,
    importNpmPlugin,
    installAgentEntry,
    enableCloud,
  }
}
