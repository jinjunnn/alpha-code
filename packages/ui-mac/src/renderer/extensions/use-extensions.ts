// Data layer for the Extension Hub (定制中心). Mirrors use-projects.ts: one read client + one
// global SSE subscription, patching a Solid store in place. The "installed" truth comes from the
// SDK (mcp.status) — alpha keeps NO separate persisted install store (ADR-014 §4). The browsable
// catalog comes from the bundled resources/alpha-catalog.json.
//
// Catalog MCP install persists through main, then main reloads the authenticated engine so its
// `{file:}` references resolve without returning secret plaintext to renderer. The uncatalogued
// custom-MCP path still uses renderer SDK add/connect with the values the user just entered.

// C14③ 契约锚(sync 时 `grep -n "as any"` 复核本文件):本文件全部 `as any` 都是同一类——
// SDK v2 生成类型与 server 实际接受/返回形状的已知偏斜(directory/scope/roots 扩展参数、data
// 数组元素形状、event 信封)。上游 codegen 修齐后应成批删除,不新增其它用途的 as any。
import { createStore } from "solid-js/store"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
// CLIENT subpath only — the v2 barrel pulls Node-only deps that break the renderer (see ADR-008).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerInfo } from "../sidebar/use-projects"
import type { CatalogEntry, InstalledState, McpConfig, McpInstallSpec, RuntimeCheck } from "./catalog-types"
import type { InstallReceipt, SetStateRefusalCodeWire, UninstallKeyIntent } from "../../preload/types"
import { isExtensionName } from "../../shared/extension-name"
import type { AuthorizationConfirmationWire, CapabilityDiffWire, TxStageNonAuthorizeWire } from "../../shared/ext-capability-authorization"
import type { SessionGrantRefusalCode, SessionGrantWire } from "../../shared/ext-session-grant-wire"
import { connectOutcome, grantsToReassert, sessionGrantKeyOf } from "./ext-session-toggle"

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
  /** REQ-099(#307)项目账本视图:当前打开项目的 scope=project 收据(导入/收编产物;ADR-030 下
   *  无受管 project 安装)。无项目上下文时恒空。catalog「已安装」判定仍只看 global receipts。 */
  projectReceipts: InstallReceipt[]
  /** Agents the engine knows (REQ-018 T7 Agent tab): built-in + alpha-created (via SDK app.agents). */
  agents: HubAgent[]
  /** #408:当前会话的 session-grant 全集(main 内存真源;会话结束事件即清空)。 */
  sessionGrants: SessionGrantWire[]
  /** #408:逐 (catalogId, directory) 的最近连接结果 —— grant ok ≠ 已连接,连接真伪单独如实呈现。 */
  sessionLink: Record<string, "connected" | "failed">
  ready: boolean
  error: boolean
}

/** #408:会话级授予的结果(connected = 引擎热连真伪;拒绝码按 #397 纪律机器可判别)。 */
export type SessionGrantAction =
  | { ok: true; connected: boolean }
  | { ok: false; reason?: string; code?: SessionGrantRefusalCode }

/** #348:真判别联合(Codex 裁决 D1 + review minor)—— authorize 分支强制携带 diff,
 *  非 authorize 分支的 stage 类型排除 "authorize":中间包装层折叠丢数据过不了类型检查。 */
export type ActionResult =
  /** warning = 安装成功但携带 loud 诊断信号(CAS 自愈、授权账写失败等,#361 review r1)——
   *  调用方必须呈现,不得静默吞掉。projectionLag(#336 r1)= 账本已 durable 但 skills 允许集
   *  发布失败(本次未注入,重启自愈)—— UI 据此给「重启后生效」级用户提示。 */
  | { ok: true; reason?: string; warning?: string; projectionLag?: string }
  | { ok: false; stage: "authorize"; authorization: CapabilityDiffWire[]; reason?: string }
  | { ok: false; reason?: string; stage?: TxStageNonAuthorizeWire; code?: SetStateRefusalCodeWire }

/** stage="authorize" 拦截守卫:diff 在场才算(引擎契约保证成对出现)。 */
export function isAuthzRequired(res: ActionResult): res is { ok: false; stage: "authorize"; authorization: CapabilityDiffWire[]; reason?: string } {
  return !res.ok && res.stage === "authorize" && Array.isArray(res.authorization) && res.authorization.length > 0
}

export interface ExtensionsApi {
  store: ExtensionsStore
  refresh(): Promise<void>
  /**
   * Persist and activate an MCP catalog entry through main. `secrets` fills requiredEnvVars and is
   * routed to the {file:} channel on disk (never plaintext); `env` is non-secret substitution
   * (headers/workspace). Renderer receives only activation status.
   */
  addMcp(
    entry: CatalogEntry,
    env?: Record<string, string>,
    workspace?: string,
    secrets?: Record<string, string>,
    authorization?: AuthorizationConfirmationWire,
  ): Promise<ActionResult>
  /** REQ-033:catalog 外任意 MCP(local command / remote url + env/密钥);白名单校验在 main 不放宽。 */
  addCustomMcp(
    name: string,
    input: { mcpType: "local" | "remote"; command?: string[]; url?: string },
    env: Record<string, string>,
    secrets: Record<string, string>,
  ): Promise<ActionResult>
  /** Toggle a known MCP server: connect when shouldConnect, else disconnect.
   *  #395(Codex r8 M5):disconnect 失败(无 client / 抛错)= 旧连接可能仍在跑 → 返回 reload-pending,
   *  调用方据此如实提示「运行面待重载」,不谎报已断连。 */
  setMcpConnected(name: string, shouldConnect: boolean): Promise<ActionResult>
  /** Remove an MCP server from the user config + disconnect. */
  removeMcp(name: string): Promise<ActionResult>
  /** #408:实验室条目的会话级授予(main 校验 + 内存登记 → 同 directory 引擎热连)。
   *  connected = 连接真伪(grant ok ≠ 已连接,调用方如实呈现);拒绝按机器码路由。 */
  grantSession(catalogId: string, directory: string, opts?: { confirmExpiredReview?: boolean }): Promise<SessionGrantAction>
  /** #408:撤销会话授予(幂等;directory 维度)并断开该 instance 空间的连接(best-effort)。 */
  revokeSession(catalogId: string, directory: string, name: string): Promise<ActionResult>
  /** Uninstall any installed item by its receipt (fs/plugin/mcp) — files/config/secrets + receipt. */
  uninstall(receipt: InstallReceipt): Promise<ActionResult>
  /** REQ-104 #395:启停(global 收据;project 组只读无开关)。main 侧账本+投影原子翻转;
   *  fs 类翻转后 dispose 引擎使投影生效;mcp 的 live connect 由调用方按需衔接。 */
  setInstallState(receipt: InstallReceipt, state: "enabled" | "disabled", opts?: { confirmExpiredReview?: boolean }): Promise<ActionResult>
  /** True if this catalog entry is already installed (MCP via SDK truth; others via receipts). */
  isInstalled(entry: CatalogEntry): boolean
  /** which-check the entry's runtime deps; { ok:false, missing } if a binary is absent. */
  checkRuntime(tools: string[] | undefined): Promise<RuntimeCheck>
  /** REQ-036 出厂技能名单(skills.paths 注入;逃生开关关闭时为空)——hub 据此把对应 catalog
   *  条目呈现为「出厂内置」而非可安装(S18 X1)。创建类操作已技能化,不再有表单写入方法。 */
  factorySkills(): string[]
  /** Install a catalog skill entry by writing its SKILL.md. */
  installSkill(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult>
  /** REQ-018 T4:释放全部引擎实例(POST /global/dispose)→ 下一请求惰性重建重扫,免重启生效。 */
  refreshEngine(): Promise<boolean>
  /** REQ-018 T7:刷新引擎已知的 agents(内置 + 自建)供 Agent tab 呈现。 */
  reloadAgents(): Promise<void>
  /** Append a plugin to config `plugins` (opencode auto-installs on next launch; needs restart). */
  installPlugin(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult>
  /**
   * REQ-019 T5:按 catalog 当前钉版更新已装条目。skill = 覆盖重装(同名 dest,receipt 版本翻新);
   * plugin = 卸旧配置项再写新钉版(persistPlugin 只会追加,直接重装会留旧版残留)。
   * MCP 不走此方法 —— persistMcp 是覆盖写,静默重装会丢 {file:} 密钥引用;hub 层用确认框重装
   * (密钥可重填),见 extension-hub.runUpdate。
   */
  updateEntry(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult>
  /** REQ-019 T6 / REQ-098 #255:导入本地技能文件夹(main 自弹选择器,renderer 不传 srcDir)。 */
  importSkillFolder(): Promise<ActionResult & { name?: string; canceled?: boolean }>
  /** REQ-019 T6:导入 Git 仓库技能(https-only 浅克隆临时目录 → 同校验)。 */
  importSkillGit(url: string): Promise<ActionResult & { name?: string }>
  /** REQ-019 T6:npm 插件导入 = 复用 persistPlugin 通道(主进程包名白名单)。 */
  importNpmPlugin(pkg: string): Promise<ActionResult>
  /** REQ-023:安装 catalog 官方 agent(vendored md 资产 → writeAgent 同管线)。 */
  installAgentEntry(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult>
  /** REQ-020 T4:启用云 pipeline = receipts-only(进本机可用列表;不落文件、不写引擎 config)。
   *  停用走 uninstall(cloud receipt → 去账)。 */
  enableCloud(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult>
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

/** REQ-099(#307)卸载意图构造(纯函数,use-extensions-ipc.test 锁契约):scope 取自 receipt 真源;
 *  project 收据必须带当前项目目录 —— 目录缺失(上下文丢失)如实拒绝,绝不降级成 global intent
 *  去删同名全局安装(AC5 同名并存下那是删错对象)。 */
export function uninstallIntentFor(
  receipt: Pick<InstallReceipt, "type" | "name" | "scope">,
  projectDir: string | undefined,
): { ok: true; intent: UninstallKeyIntent } | { ok: false; reason: string } {
  if (receipt.scope === "project") {
    if (!projectDir) return { ok: false, reason: "project uninstall requires an open project (context lost — reopen the project session)" }
    return { ok: true, intent: { type: receipt.type, name: receipt.name, scope: "project", projectDir } }
  }
  return { ok: true, intent: { type: receipt.type, name: receipt.name, scope: "global" } }
}

export function useExtensions(
  server: Accessor<ServerInfo | undefined>,
  active?: Accessor<boolean>,
  /** REQ-099(#307)当前项目目录(hub 从路由解析);在场时 listInstalls 连带读项目账本。 */
  projectDir?: Accessor<string | undefined>,
): ExtensionsApi {
  const [store, setStore] = createStore<ExtensionsStore>({ mcp: {}, receipts: [], projectReceipts: [], agents: [], sessionGrants: [], sessionLink: {}, ready: false, error: false })

  let client: Client | undefined
  let generation = 0
  let abortRef = new AbortController()

  // REQ-018:安装账本(current-environment global)。receipts 覆盖 skill/agent/plugin 的「已安装」真相
  // (SDK 的 mcp.status 只认 MCP);每次安装/卸载后刷新。
  // REQ-099(#307):有项目上下文时同一调用连带读项目账本(main 双账本读面早已就绪);
  // 无项目时 project 视图如实清空 —— 不残留上一个项目的行。
  // Codex r1 B2 + r2 修正:project 部分按发起时的目录判有效(迟到响应不把 A 的行摆进 B 的组头);
  // global 账本与目录无关,任何有效响应都应用 —— 整体丢弃会让"切换后替代请求失败"的场景把 global
  // 面冻在旧值上。切换瞬间的 project 清空由 projectDir effect 负责。
  async function loadInstalls() {
    const dir = projectDir?.()
    try {
      const view = await window.api.ext.listInstalls(dir)
      setStore("receipts", view.global)
      if ((projectDir?.() ?? undefined) === (dir ?? undefined)) setStore("projectReceipts", dir ? view.project : [])
    } catch {
      /* transient — keep previous(project 行与目录不符的窗口已被切换清空堵死) */
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
    authorization?: AuthorizationConfirmationWire,
  ): Promise<ActionResult> {
    const c = client
    if (!c) return { ok: false, reason: "no server" }
    const spec = entry.installSpec
    if (!spec || spec.kind !== "mcp") return { ok: false, reason: "not an MCP entry" }
    // REQ-099 #305:catalog MCP 切 main-owned installCatalog —— name/config 由 main 从已验签 catalog
    // 派生,renderer 只交 grants(secrets/env/workspace)+ cnMirror 偏好(镜像 env 值为 main 侧常量,
    // 顶替此前 renderer 侧的 CN_MIRROR_ENV 注入)。durable 落盘含 {file:} 引用与 main 策略(如 Excel
    // 受管根);durable commit 后由 main 经已认证 engine route 重载 `{file:}` 引用并返回状态。
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
      ...(authorization ? { authorization } : {}),
    })
    if (!r.ok) return r
    // #395(Codex r8 M4):第三方 MCP 默认关。这是成功的「装 ≠ 跑」,不是失败。
    if (r.installedDisabled) {
      await Promise.all([loadStatus(), loadInstalls()])
      return { ok: true, reason: "installed-disabled" }
    }
    if (r.kind !== "mcp") {
      await Promise.all([loadStatus(), loadInstalls()])
      return { ok: false, reason: `catalog kind mismatch: expected mcp, got "${r.kind}"(条目已按实际类型落盘,未激活连接)` }
    }
    await Promise.all([loadStatus(), loadInstalls()])
    if (r.mcpActivation?.status === "connected") return { ok: true }
    if (r.mcpActivation?.status === "disabled") return { ok: true, reason: "installed-disabled" }
    if (r.mcpActivation?.status === "reload-pending") return { ok: true, reason: "reload-pending" }
    // 返回稳定 reason code 而非文案:本 hook 不持有 i18n(全文件零 `t()`),
    // 文案由 extension-hub 映射,与 installed-disabled / slow / reload-pending 同形态。
    return { ok: false, reason: "connect-failed" }
  }

  // 未策展自定义连接器的 live 段;catalog 连接器由 main 重载 `{file:}` 引用。
  async function liveAddAndConnect(name: string, config: unknown): Promise<ActionResult> {
    const c = client
    if (!c) return { ok: false, reason: "no server" }
    // #395(Codex r10 B4/M5):连接前复查当前 activation —— 安装/持久化提交后返回 live 段,与用户并发
    // disable(post-commit)竞态,或本就是「重加已 disabled 的自定义 MCP」。引擎 mcp.connect 强制
    // enabled:true,会绕过账本/config 的 disabled 复活运行面。account 为 disabled 则不激活连接,如实
    // 回「已装未启用」。(inventoryView 读账本 desiredState 投影;global mcp 无 projectDir。)
    // #395 连接前复查 activation —— 与并发 disable 竞态、或重加已 disabled 的 MCP。引擎 mcp.add/connect
    // 强制 enabled:true,会绕账本复活运行面。**只有 activation 明确 === "enabled" 才连接**;读失败/行缺席/
    // activation unknown/disabled 一律 **fail-closed 不激活**(Codex 增量 r13 Major:此前只在 IPC 抛错才
    // fail-closed,查询成功但行缺席/unknown 时 activation=undefined 仍照连 → 已禁 MCP 被激活)。
    let activation: string | undefined
    try {
      const inv = await window.api.ext.inventoryView()
      // Codex r11 B7:选**已安装 global 行**(scope==="global"),不落未安装浏览行(scope=null)。
      activation = inv.rows.find((r) => r.kind === "mcp" && r.name === name && r.scope === "global")?.activation
    } catch {
      activation = undefined
    }
    if (activation !== "enabled") {
      // 非明确 enabled(disabled / undefined / unknown / 行缺席 / 读失败)→ 不激活,已落盘。
      await Promise.all([loadStatus(), loadInstalls()])
      return { ok: true, reason: activation === "disabled" ? "installed-disabled" : "reload-pending" }
    }
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
    // 消费共享谓词,不再手抄一份 —— 这一处是 R1 审计用 byte-aware 检索抓出的第 18 个成员,
    // 它与 main 侧 persistMcp 的判定必须同源:分叉后收紧则 renderer 放行 main 拒绝的名字
    // (用户点了才失败),放宽则 renderer 拒掉 main 接受的名字(功能静默丢失)。
    if (!isExtensionName(name)) return { ok: false, reason: "名称只能含字母数字 . _ -(1-64 位)" }
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

  async function setMcpConnected(name: string, shouldConnect: boolean): Promise<ActionResult> {
    const c = client
    // #395(Codex r8 M5):无 client / connect|disconnect 抛错 = 运行面未真正切换 —— 旧连接可能仍在
    // 跑该 MCP。账本/config 已是目标态(desiredState),但当前 sidecar 实例的连接未随之刷新,如实回
    // reload-pending,不谎报已生效。仅两侧都成功才回 ok。
    if (!c) {
      await loadStatus()
      return { ok: true, reason: "reload-pending" }
    }
    try {
      if (shouldConnect) await c.mcp.connect({ name } as any)
      else await c.mcp.disconnect({ name } as any)
      await loadStatus()
      return { ok: true }
    } catch {
      await loadStatus()
      return { ok: true, reason: "reload-pending" }
    }
  }

  // ── #408:session-grant(实验室扩展的会话级启用)────────────────────────────────────────────
  // grant 真源 = main 内存登记(sidecar 运行期边界,零持久面);生效 = 引擎原生 /mcp/:name/connect
  // 对**同 directory**(grant 的 enforcement 空间)热连。连接真伪单独记录(sessionLink)——
  // grant ok ≠ 已连接,不谎报。engine connect 强制 enabled:true 会绕账本,但本通道的权威即
  // main grant IPC ok(#408 契约;#395 的 activation==="enabled" 前置检查不适用 —— session-grant
  // 记录的账本 desiredState 恒 disabled 正是设计)。

  async function loadSessionGrants(): Promise<void> {
    try {
      const r = await window.api.ext.sessionGrants()
      setStore("sessionGrants", Array.isArray(r?.grants) ? r.grants : [])
    } catch {
      /* IPC 瞬断:保留现值,下一次事件/操作再同步 */
    }
  }

  /** 引擎热连(directory-scoped)。返回连接真伪;失败不抛(调用方如实呈现)。
   *  r1 Major:SDK 默认 throwOnError:false —— HTTP 错误(如实例重建后连接器配置缺失的 404)
   *  以 {error} 返回不进 catch;必须查返回结果再定连接态(connectOutcome),否则 grant 通过而
   *  连接失败会被记成 connected(假「本次会话已启用」,disposed re-assert 同染)。 */
  async function connectSessionMcp(name: string, directory: string, shouldConnect: boolean): Promise<boolean> {
    const c = client
    if (!c) return false
    try {
      const r = shouldConnect ? await c.mcp.connect({ name, directory }) : await c.mcp.disconnect({ name, directory })
      return connectOutcome(r as { error?: unknown })
    } catch {
      return false
    }
  }

  async function grantSession(
    catalogId: string,
    directory: string,
    opts?: { confirmExpiredReview?: boolean },
  ): Promise<SessionGrantAction> {
    const r = await window.api.ext.sessionGrant({
      catalogId,
      directory,
      ...(opts?.confirmExpiredReview ? { confirmExpiredReview: true } : {}),
    })
    if (!r.ok) {
      // main 的任何拒绝都会撤下同 key 旧 grant(fail-closed)—— 同步真源,开关随之回落。
      await loadSessionGrants()
      return { ok: false, reason: r.reason, code: r.code }
    }
    const connected = await connectSessionMcp(r.grant.name, directory, true)
    setStore("sessionLink", sessionGrantKeyOf(catalogId, directory), connected ? "connected" : "failed")
    await Promise.all([loadSessionGrants(), loadStatus()])
    return { ok: true, connected }
  }

  async function revokeSession(catalogId: string, directory: string, name: string): Promise<ActionResult> {
    const r = await window.api.ext.sessionGrantRevoke({ catalogId, directory })
    if (!r.ok) return { ok: false, reason: r.reason }
    // 撤销后断连(best-effort;grant 已撤,注入/重建面不会复活它 —— 断连失败只影响本实例余温)。
    await connectSessionMcp(name, directory, false)
    setStore("sessionLink", sessionGrantKeyOf(catalogId, directory), undefined!)
    await Promise.all([loadSessionGrants(), loadStatus()])
    return { ok: true }
  }

  /** 引擎 global.disposed 后的 re-assert(Codex 裁决):instance 重建会重放注入的 disabled 叶,
   *  热连的 grant mcp 掉线 —— 重走 grant 通道(main 重校验身份/advisory;失败 = main 已撤 grant,
   *  开关如实回落)后重连。幂等,可重入。 */
  async function reassertSessionGrants(disposedDirectory: string | undefined): Promise<void> {
    const plan = grantsToReassert(store.sessionGrants, disposedDirectory)
    for (const g of plan) {
      const r = await window.api.ext.sessionGrant({ catalogId: g.id, directory: g.directory }).catch(() => null)
      const connected = r?.ok ? await connectSessionMcp(g.name, g.directory, true) : false
      setStore("sessionLink", sessionGrantKeyOf(g.id, g.directory), r?.ok ? (connected ? "connected" : "failed") : undefined!)
    }
    await Promise.all([loadSessionGrants(), loadStatus()])
  }

  async function removeMcp(name: string): Promise<ActionResult> {
    const c = client
    const res = await window.api.ext.removeMcp(name)
    // Codex review #351:失败(含事务在途 busy)不 disconnect —— 否则留下「已装但被断连」的半拆态。
    if (res.ok && c) await c.mcp.disconnect({ name } as any).catch(() => {})
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
   *  锁内 journaled teardown。REQ-099(#307):scope 取自 receipt 真源 —— project 行带当前项目目录
   *  (行只在有项目上下文时存在;目录缺失如实拒绝,绝不静默降级去删同名 global 安装)。 */
  async function uninstall(receipt: InstallReceipt): Promise<ActionResult> {
    // 账本外的 live MCP(手工/迁移前,hub 合成 receipt 行):v2 按账本自查会诚实拒「not installed」,
    // 这类走既有 name-based removeMcp(config 名单键移除 + live disconnect),与旧行为一致。
    // Codex r1 M2:仅限 global —— project MCP 收据(legacy 账本可能存在)必须走 v2 project 通道
    // 由 main 按项目账本自查,绝不落进按名字操作全局 config 的旧路。
    if (receipt.type === "mcp" && receipt.scope !== "project" && !store.receipts.some((r) => r.type === "mcp" && r.name === receipt.name))
      return removeMcp(receipt.name)
    const built = uninstallIntentFor(receipt, projectDir?.())
    if (!built.ok) return { ok: false, reason: built.reason }
    const res = await window.api.ext.uninstallV2(built.intent)
    if (res.ok && receipt.type === "mcp") await client?.mcp.disconnect({ name: receipt.name } as any).catch(() => {})
    await Promise.all([loadStatus(), loadInstalls()])
    // fs/plugin removal needs a rescan;cloud 只动账本(引擎无状态)无需 dispose。
    if (res.ok && receipt.type !== "mcp" && receipt.type !== "cloud") await refreshEngine()
    if (receipt.type === "agent") void loadAgents()
    return res
  }

  /** REQ-104 #395:启停(仅 global 收据;project 组只读)。main 侧原子翻转(mcp/agent/plugin =
   *  journaled config 事务 + 账本;skill = 账本,投影由引擎侧注入门消费);fs 类随后 dispose 引擎
   *  使投影立即生效;mcp 的 live connect/disconnect 由调用方(hub 开关)按语义衔接。 */
  async function setInstallState(
    receipt: InstallReceipt,
    state: "enabled" | "disabled",
    opts?: { confirmExpiredReview?: boolean },
  ): Promise<ActionResult> {
    if (receipt.scope === "project") return { ok: false, reason: "project-scoped records have no enable switch (read-only group)" }
    const res = await window.api.ext.setInstallState({
      type: receipt.type,
      name: receipt.name,
      scope: "global",
      state,
      ...(opts?.confirmExpiredReview ? { confirmExpiredReview: true } : {}),
    })
    if (!res.ok) return res
    await loadInstalls()
    // Codex r1 Blocker 3:账本已翻(committed),但 fs 类的运行面靠 dispose→惰性重建生效 —— dispose
    // 失败(无 client/超时/异常)时旧引擎实例仍在跑该扩展,不得谎报已生效。透传 reload-pending,
    // 调用方据此提示「已记录,待重载」而非直接宣称已启用/禁用。
    if (receipt.type !== "mcp" && receipt.type !== "cloud" && !(await refreshEngine())) return { ok: true, reason: "reload-pending" }
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
        // #408(Codex 裁决):re-assert 消费引擎权威 disposal 信号(覆盖 PATCH /global/config 等一切
        // 内部 dispose 路径,不猜调用点)。事件携带被释放 instance 的 directory。
        if (type === "server.instance.disposed") void reassertSessionGrants(event?.directory)
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
    void loadSessionGrants()
    void subscribe()
    onCleanup(() => {
      if (gen === generation) client = undefined
      abortRef.abort()
    })
  })

  // REQ-099(#307):项目上下文切换(换项目会话 / 回 home)→ 重读账本,project 视图跟随当前目录。
  // Codex r1 B2:切换瞬间先清空 project 行 —— 绝不把上一项目的行显示在新目录组头下(那扇窗口里
  // 点卸载会用新目录构造意图,同 key 时删错对象);新目录的行等它自己的账本响应到达再出现。
  createEffect(() => {
    projectDir?.()
    if (!activated) return
    setStore("projectReceipts", [])
    void loadInstalls()
  })

  // #408:会话结束事件(main:sidecar exit/respawn)—— grant 已整体失效,清空本地视图使全部
  // 会话开关归位(respawn 后 renderer reload 会重查到空集 = 双保险);toast 提示由 hub 订阅同
  // 一事件自行呈现(多监听允许)。
  onCleanup(
    window.api.ext.onSessionGrantsEnded(() => {
      setStore("sessionGrants", [])
      setStore("sessionLink", {})
    }),
  )

  // REQ-036:出厂技能名单(一次取回缓存;失败诚实为空 = 不显「出厂内置」徽标,条目退回可安装态)。
  const [factoryIds, setFactoryIds] = createSignal<string[]>([])
  void window.api.ext
    .factorySkillIds()
    .then((ids) => setFactoryIds(Array.isArray(ids) ? ids : []))
    .catch(() => {})

  async function installSkill(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult> {
    const spec = entry.installSpec
    if (spec?.kind !== "skill") return { ok: false, reason: "not a skill entry" }
    // REQ-100 #313(补 #310):单装与 bundle 同入口 —— main-owned installCatalog。renderer 仍只传
    // catalogId(codex H1 信任边界:main 从已验签 catalog 派生 name/清单/版本,remote sha256 钉死、
    // builtin 同源校验都在 main);skill 落不可变 generation 事务 → 可列代/离线回滚,不再走旧 flat
    // 通道。「内容未随版本打包」的诚实失败由 planner 原样上抛。
    // #348:首驱可返回 stage="authorize" + diff(原样透传给 hub 弹授权框);确认后带 authorization
    // 重驱同一意图 —— 引擎按整集覆盖判定,decidedAt 由 main 打戳。
    const r = await window.api.ext.installCatalog({
      catalogId: entry.id,
      scope: { scope: "global" },
      ...(authorization ? { authorization } : {}),
    })
    if (!r.ok) return r
    await loadInstalls()
    if (!(await refreshEngine())) return { ok: true, reason: "reload-pending" }
    return r
  }

  async function installPlugin(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult> {
    const spec = entry.installSpec
    if (!spec || spec.kind !== "plugin") return { ok: false, reason: "not a plugin entry" }
    // REQ-099 #305:catalog 插件切 installCatalog(vendored/npm 分支由 planner 从已验签条目裁决)。
    // dispose 触发实例重建 → 引擎立刻装载(vendored=本地即读;npm=后台下载);失败不降级为错误,
    // config 已落盘、下次重建自然装载。
    const r = await window.api.ext.installCatalog({ catalogId: entry.id, scope: { scope: "global" }, ...(authorization ? { authorization } : {}) })
    if (r.ok) {
      await loadInstalls()
      await refreshEngine()
    }
    return r
  }

  /** 安装 catalog 官方 agent(REQ-099 #305:切 installCatalog —— remote/builtin 分支与「内容未打包」
   *  诚实失败均由 planner 从已验签条目裁决;写盘/桥/账本走 writeAgent 同管线)。 */
  async function installAgentEntry(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult> {
    const spec = entry.installSpec
    if (!spec || spec.kind !== "agent") return { ok: false, reason: "not an agent entry" }
    const r = await window.api.ext.installCatalog({ catalogId: entry.id, scope: { scope: "global" }, ...(authorization ? { authorization } : {}) })
    if (!r.ok) return r
    await loadInstalls()
    const refreshed = await refreshEngine()
    void loadAgents()
    // warning 随两条成功路径透传(#361 review r1:reload-pending 不得把 loud 信号一并吞掉)。
    if (!refreshed) return { ok: true, reason: "reload-pending", ...(r.warning ? { warning: r.warning } : {}) }
    return r
  }

  // REQ-019 T6:导入。成功后刷新账本 + dispose 重载(与 createSkill 同节奏);失败原因原样上抛,
  // 由 hub 行内呈现(B11)。npm 导入 = 复用 persistPlugin 通道(白名单校验在主进程)。
  async function importSkillFolder(): Promise<ActionResult & { name?: string; canceled?: boolean }> {
    // REQ-098 #255:main 自弹目录选择器,renderer 不再传 srcDir。
    const r = await window.api.ext.importSkillFolder()
    if (!r.ok) return r
    await loadInstalls()
    // #336 r1:warning/projectionLag 端到端透传(此前重建 {ok,name} 把降级信号吞掉)。
    const carry = { ...(r.warning ? { warning: r.warning } : {}), ...(r.projectionLag ? { projectionLag: r.projectionLag } : {}) }
    if (!(await refreshEngine())) return { ok: true, name: r.name, reason: "reload-pending", ...carry }
    return { ok: true, name: r.name, ...carry }
  }
  async function importSkillGit(url: string): Promise<ActionResult & { name?: string }> {
    const r = await window.api.ext.importSkillGit(url)
    if (!r.ok) return r
    await loadInstalls()
    const carry = { ...(r.warning ? { warning: r.warning } : {}), ...(r.projectionLag ? { projectionLag: r.projectionLag } : {}) }
    if (!(await refreshEngine())) return { ok: true, name: r.name, reason: "reload-pending", ...carry }
    return { ok: true, name: r.name, ...carry }
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
  async function enableCloud(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult> {
    if (entry.type !== "cloud") return { ok: false, reason: "not a cloud entry" }
    const r = await window.api.ext.installCatalog({ catalogId: entry.id, scope: { scope: "global" }, ...(authorization ? { authorization } : {}) })
    if (!r.ok) return r // #348:不折叠 —— stage/authorization 原样透传(cloud 未来入事务时自然接上)
    await loadInstalls()
    return { ok: true }
  }

  async function updateEntry(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult> {
    // #348:skill 更新 = 同一事务入口,扩权时同样被 authorize 闸拦下(确认后带 authorization 重入)。
    if (entry.type === "skill") return installSkill(entry, authorization)
    if (entry.type === "plugin") {
      // #352:插件更新收敛为**单次** installCatalog —— main 从自己账本判 fresh/replace,
      // 替换在 journaled 事务内(config 精确换元 + receipt 同锁落账,失败引擎回滚,崩溃恢复
      // 前滚幂等)。旧「先卸后装」两步链(旧已删、新未装的失败窗口)就此下线。
      return installPlugin(entry, authorization)
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
    grantSession,
    revokeSession,
    uninstall,
    setInstallState,
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
