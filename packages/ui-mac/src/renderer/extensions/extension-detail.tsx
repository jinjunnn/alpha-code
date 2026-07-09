// Extension detail page (REQ-019 T2) — the hub's second-level page, rendered in place of the list
// when a card is clicked. Back button + Escape pop back to the list (the hub owns the Esc chain:
// detail → list → close). Generic skeleton per docs/designs/2026-07-04-extension-hub-v3-universal §5.3:
// header (icon/name/source/license/version/「待核实」) → 简介 → type-specific slot → 数据边界 →
// 运行时依赖 → 所需密钥 → 操作区. T3 fills the type-specific blocks (tools[]/SKILL.md/hooks…);
// T4 upgrades 数据边界/依赖 to live which-checks.

import { createMemo, createResource, For, Show, type Accessor, type JSX } from "solid-js"
import { t } from "../i18n"
import type { CatalogEntry, CloudPipelineSpec, McpInstallSpec, PluginInstallSpec, SkillInstallSpec } from "./catalog-types"
import type { InstallReceipt } from "../../preload/types"
import type { ExtensionsApi, HubAgent } from "./use-extensions"
import { CloudDispatchBox } from "./cloud-dispatch-box"
import { iconFor, iconForRow, sourceLabel, typeLabel, Svg, LockIc } from "./ext-presentation"

/** What the detail page shows: a catalog entry, an engine agent (no catalog identity), or the
 *  injected platform cloud connector (REQ-020 T3 — not a catalog entry, not installable). */
export type DetailTarget =
  | { kind: "entry"; entry: CatalogEntry }
  | { kind: "agent"; agent: HubAgent }
  | { kind: "cloud-connector" }

// mcp.cloud 的 4 个工具(B 侧 MCP facade;alpha-platform docs/alpha-code-cloud-integration.md)。
// 引擎无 tools 查询路由 → 与 MCP 条目一样用精选元数据展示(REQ-019 T3 同约束)。
const CLOUD_TOOLS = [
  { name: "cloud_dispatch", key: "alpha.ext.cloudToolDispatch" },
  { name: "cloud_status", key: "alpha.ext.cloudToolStatus" },
  { name: "cloud_await", key: "alpha.ext.cloudToolAwait" },
  { name: "cloud_artifacts", key: "alpha.ext.cloudToolArtifacts" },
] as const

function mcpSpec(e: CatalogEntry): McpInstallSpec | undefined {
  return e.installSpec?.kind === "mcp" ? e.installSpec : undefined
}
function skillSpec(e: CatalogEntry): SkillInstallSpec | undefined {
  return e.installSpec?.kind === "skill" ? e.installSpec : undefined
}
function pluginSpec(e: CatalogEntry): PluginInstallSpec | undefined {
  return e.installSpec?.kind === "plugin" ? e.installSpec : undefined
}
function cloudSpec(e: CatalogEntry): CloudPipelineSpec | undefined {
  return e.installSpec?.kind === "cloud" ? e.installSpec : undefined
}
function verifyText(e: CatalogEntry): string | undefined {
  return e._verify ?? e.installSpec?._verify
}
function hostOf(url: string | undefined): string {
  if (!url) return ""
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const Section = (p: { title: string; children: JSX.Element }) => (
  <section class="alpha-ext-dsec">
    <h3 class="alpha-ext-dsec-t">{p.title}</h3>
    {p.children}
  </section>
)

const FactRow = (p: { label: string; children: JSX.Element }) => (
  <div class="alpha-ext-dfact">
    <span class="alpha-ext-dfact-l">{p.label}</span>
    <span class="alpha-ext-dfact-v">{p.children}</span>
  </div>
)

export function ExtensionDetail(props: {
  target: DetailTarget
  ext: ExtensionsApi
  catalogVersion: string
  byId: (id: string) => CatalogEntry | undefined
  busy: Accessor<string | null>
  /** Breadcrumb root = the section (tab) this detail was opened from; clicking it goes back. */
  crumb: string
  /** B11:安装失败的行内错误(hub 持有,与卡片同源)。 */
  errorFor?: (id: string) => string | undefined
  onBack: () => void
  /** Stage the entry in the hub's install-confirm dialog (same flow as the card 添加). */
  onInstall: (e: CatalogEntry) => void
  onUninstall: (receipt: InstallReceipt) => void
  /** Navigate the detail page to another entry (bundle item click). */
  onOpenEntry: (e: CatalogEntry) => void
  /** REQ-020 T2:云门控(登录且 platform 模式)。cloud 条目「启用」与 dispatch 入口据此禁用。 */
  cloudReady?: Accessor<boolean>
  /** 未登录时云页的登录 CTA(window.api.auth.start,hub 持有)。 */
  onLogin?: () => void
}) {
  const entry = () => (props.target.kind === "entry" ? props.target.entry : undefined)
  const agent = () => (props.target.kind === "agent" ? props.target.agent : undefined)
  const isCloudConnector = () => props.target.kind === "cloud-connector"
  const cloudReady = () => props.cloudReady?.() ?? false
  // 注入的 mcp.cloud 的 SDK 实时态(platform 模式下 sidecar 注入后才存在)。
  const cloudLive = () => props.ext.store.mcp["cloud"]

  // Receipt truth for the shown entry — receipts ⨝ SDK (mirror of the manage list, ADR-014 v3).
  // Live-but-unreceipted MCP gets a synthetic receipt so uninstall still works.
  const receipt = createMemo((): InstallReceipt | undefined => {
    const e = entry()
    if (e) {
      const byIdMatch = props.ext.store.receipts.find((r) => r.id === e.id)
      if (byIdMatch) return byIdMatch
      if (e.type === "mcp" && e.name in props.ext.store.mcp)
        return { id: e.id, name: e.name, type: "mcp", scope: "global", installedAt: "", origin: "created" }
      return undefined
    }
    const a = agent()
    if (a) return props.ext.store.receipts.find((r) => r.type === "agent" && r.name === a.name)
    return undefined
  })
  const installed = createMemo(() => {
    const e = entry()
    if (e) return props.ext.isInstalled(e)
    return !!receipt()
  })
  const mcpLive = () => {
    const e = entry()
    return e?.type === "mcp" ? props.ext.store.mcp[e.name] : undefined
  }

  // REQ-019 T3:技能详情渲染 SKILL.md 全文。只有 builtin 资产可读(主进程只读 IPC,键校验 +
  // 256KB 帽);未打包的诚实显示原因,不占位。
  const [skillDoc] = createResource(
    () => {
      const e = entry()
      if (!e) return undefined
      const spec = e.installSpec
      // skill 的 SKILL.md 与 agent 的 md 资产共用只读预览通道(REQ-023)。
      if (spec?.kind === "skill") return spec.builtinAssetKey || undefined
      if (spec?.kind === "agent") return spec.builtinAssetKey || undefined
      return undefined
    },
    (key) => window.api.ext.readBuiltinSkill(key),
  )

  // REQ-019 T4:进详情页即实时 which 检测运行时依赖(复用 ext.checkRuntime),不再等点「添加」
  // 才发现缺依赖;缺失的给安装指引。source 串上 entry id,切换条目即重测。
  const [depCheck] = createResource(
    () => {
      const e = entry()
      const deps = e && mcpSpec(e)?.runtimeDep
      return deps?.length ? { id: e!.id, deps } : undefined
    },
    async (src) => {
      const results: { dep: string; ok: boolean }[] = []
      for (const dep of src.deps) {
        const r = await window.api.ext.checkRuntime(dep)
        results.push({ dep, ok: r.ok })
      }
      return results
    },
  )
  // 缺失依赖的安装指引(mac,homebrew 优先;uv 官方脚本备选)。
  const DEP_GUIDE: Record<string, string> = {
    uv: "brew install uv",
    node: "brew install node",
    git: "xcode-select --install",
    python: "brew install python",
    bun: "brew install oven-sh/bun/bun",
  }

  const header = createMemo(() => {
    const e = entry()
    if (e) {
      const ic = iconFor(e)
      return {
        ic,
        title: e.displayName,
        name: e.name,
        source: e.source,
        type: e.type as string,
        license: e.license,
        desc: e.description,
      }
    }
    if (isCloudConnector()) {
      return {
        ic: iconForRow(undefined, "cloud", "云"),
        title: t("alpha.ext.cloudConnectorTitle"),
        name: "cloud",
        source: "alpha" as const,
        type: "mcp",
        license: undefined,
        desc: t("alpha.ext.cloudConnectorDesc"),
      }
    }
    const a = agent()!
    return {
      ic: iconForRow(undefined, "agent", a.name),
      title: a.name,
      name: a.name,
      source: undefined,
      type: "agent",
      license: undefined,
      desc: a.description ?? t("alpha.ext.agentNoDesc"),
    }
  })

  return (
    <div class="alpha-ext-detail">
      {/* 面包屑(横向层级,用户拍板取代返回键/左栏):类目 / 条目名;首级可点 = 返回列表 */}
      <nav class="alpha-ext-crumbs" aria-label={t("alpha.ext.back")}>
        <button class="alpha-ext-crumb-link" onClick={() => props.onBack()}>
          <Svg class="alpha-ic alpha-ic-sm" d="M14 6l-6 6 6 6" />
          {props.crumb}
        </button>
        <span class="alpha-ext-crumb-sep">/</span>
        <span class="alpha-ext-crumb-cur">{header().title}</span>
      </nav>

      {/* ── generic header:icon · 名称 · 来源 · 类型 · 许可证 · 版本 · 待核实 ── */}
      <header class="alpha-ext-dhead">
        <span class="alpha-ext-dhead-ic" style={{ background: header().ic.color }}>
          {header().ic.glyph}
        </span>
        <div class="alpha-ext-dhead-body">
          <div class="alpha-ext-dhead-t">
            <h2>{header().title}</h2>
            <Show when={header().source}>
              <span class="alpha-ext-chip" data-source={header().source}>
                {sourceLabel(header().source!)}
              </span>
            </Show>
            <span class="alpha-ext-type-pill">{typeLabel(header().type as CatalogEntry["type"])}</span>
            <Show when={entry() && verifyText(entry()!)}>
              <span class="alpha-ext-verify-chip">{t("alpha.ext.verifyPending")}</span>
            </Show>
          </div>
          <div class="alpha-ext-dhead-meta">
            <code class="alpha-ext-dhead-id">{header().name}</code>
            <Show when={header().license}>
              <span>
                {t("alpha.ext.detailLicense")} {header().license}
              </span>
            </Show>
            <Show when={entry()}>
              <span>
                {t("alpha.ext.detailVersion")} {receipt()?.version ?? props.catalogVersion}
              </span>
            </Show>
            <Show when={installed()}>
              <span class="alpha-ext-dhead-installed">✓ {t("alpha.ext.installed")}</span>
            </Show>
          </div>
        </div>
        {/* 主操作在头部右侧(2026-07-04 定稿,参照 ChatGPT 插件详情页模式);
            plugin 的安装从这里过风险确认框(Q2),skill 直装(Q1),其余确认框。 */}
        <div class="alpha-ext-dhead-act">
          <Show when={entry()}>
            {(e) => (
              <>
                <Show when={!installed()}>
                  <button
                    class="alpha-ext-add"
                    data-variant="primary"
                    data-size="lg"
                    disabled={props.busy() === e().id || (e().type === "cloud" && !cloudReady())}
                    onClick={() => props.onInstall(e())}
                  >
                    {props.busy() === e().id
                      ? t("alpha.ext.adding")
                      : e().type === "plugin"
                        ? t("alpha.ext.installPluginBtn")
                        : e().type === "cloud"
                          ? t("alpha.ext.enableCloud")
                          : t("alpha.ext.add")}
                  </button>
                </Show>
                <Show when={e().type === "mcp" && installed()}>
                  <button
                    class="alpha-ext-sw"
                    data-on={mcpLive()?.connected ? "" : undefined}
                    aria-label={mcpLive()?.connected ? t("alpha.ext.enabled") : t("alpha.ext.disabled")}
                    onClick={() => void props.ext.setMcpConnected(e().name, !mcpLive()?.connected)}
                  />
                </Show>
              </>
            )}
          </Show>
          <Show when={installed() && receipt()}>
            <button class="alpha-ext-add" data-variant="danger" onClick={() => props.onUninstall(receipt()!)}>
              {t("alpha.ext.remove")}
            </button>
          </Show>
        </div>
      </header>

      {/* B11:安装失败行内(与卡片错误同源),不裸 toast */}
      <Show when={entry() && props.errorFor?.(entry()!.id)}>
        <p class="alpha-ext-card-err">{props.errorFor!(entry()!.id)}</p>
      </Show>

      {/* ── 简介 ── */}
      <Section title={t("alpha.ext.detailAbout")}>
        <p class="alpha-ext-dabout">{header().desc}</p>
        <Show when={entry() && verifyText(entry()!)}>
          <div class="alpha-ext-verify-note">
            <b>{t("alpha.ext.verifyNoteTitle")}</b>
            <p>{verifyText(entry()!)}</p>
          </div>
        </Show>
      </Section>

      {/* ── 类型专属槽(T2 骨架:已有事实;T3 填 tools[]/SKILL.md/hooks/权限档) ── */}
      <Section title={typeLabel(header().type as CatalogEntry["type"])}>
        <Show when={entry()}>
          {(e) => (
            <>
              {/* MCP:transport/命令/范围 + 精选工具列表(T3,catalog tools[];引擎无查询路由) */}
              <Show when={mcpSpec(e())}>
                {(spec) => (
                  <>
                    <FactRow label={t("alpha.ext.detailTransport")}>
                      {spec().mcpType === "remote" ? t("alpha.ext.transportRemote") : t("alpha.ext.transportLocal")}
                    </FactRow>
                    <Show when={spec().command?.length}>
                      <FactRow label={t("alpha.ext.detailCommand")}>
                        <code class="alpha-ext-dcode">{spec().command!.join(" ")}</code>
                      </FactRow>
                    </Show>
                    <Show when={spec().url}>
                      <FactRow label={t("alpha.ext.detailEndpoint")}>
                        <code class="alpha-ext-dcode">{spec().url}</code>
                      </FactRow>
                    </Show>
                    <FactRow label={t("alpha.ext.detailScope")}>{t("alpha.ext.scopeGlobal")}</FactRow>
                    <Show when={(e().tools ?? []).length > 0}>
                      <div class="alpha-ext-dsub">
                        <div class="alpha-ext-dsub-t">{t("alpha.ext.detailTools")}</div>
                        <div class="alpha-ext-dtools">
                          <For each={e().tools}>
                            {(tool) => (
                              <div class="alpha-ext-dtool">
                                <code>{tool.name}</code>
                                <span>{tool.description}</span>
                              </div>
                            )}
                          </For>
                        </div>
                        <p class="alpha-ext-dnote">{t("alpha.ext.toolsHint")}</p>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
              {/* Skill:安装位置 + SKILL.md 全文(T3,builtin 资产只读预览) */}
              <Show when={skillSpec(e())}>
                {(spec) => (
                  <>
                    <FactRow label={t("alpha.ext.detailInstallDir")}>{t("alpha.ext.scopeGlobal")}</FactRow>
                    <FactRow label={t("alpha.ext.detailTrigger")}>{e().description}</FactRow>
                    <Show when={spec().builtinAssetKey} fallback={<p class="alpha-ext-dnote">{t("alpha.ext.skillNoAsset")}</p>}>
                      <div class="alpha-ext-dsub">
                        <div class="alpha-ext-dsub-t">{t("alpha.ext.detailSkillDoc")}</div>
                        <Show when={!skillDoc.loading} fallback={<p class="alpha-ext-dnote">{t("alpha.ext.loading")}</p>}>
                          <Show
                            when={skillDoc()?.ok && skillDoc()}
                            fallback={
                              <p class="alpha-ext-dnote" data-err="">
                                {(skillDoc() as { reason?: string } | undefined)?.reason ?? t("alpha.ext.skillNoAsset")}
                              </p>
                            }
                          >
                            {(doc) => <pre class="alpha-ext-ddoc">{(doc() as { content: string }).content}</pre>}
                          </Show>
                        </Show>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
              {/* Plugin:npm 包 + hooks 清单 + D4 澄清 + 风险与生效方式(T3) */}
              <Show when={pluginSpec(e())}>
                {(spec) => (
                  <>
                    <FactRow label={t("alpha.ext.detailPackage")}>
                      <code class="alpha-ext-dcode">
                        {spec().package}
                        {spec().version ? `@${spec().version}` : ""}
                      </code>
                    </FactRow>
                    <Show when={(e().hooks ?? []).length > 0}>
                      <div class="alpha-ext-dsub">
                        <div class="alpha-ext-dsub-t">{t("alpha.ext.detailHooks")}</div>
                        <div class="alpha-ext-dtools">
                          <For each={e().hooks}>
                            {(h) => (
                              <div class="alpha-ext-dtool">
                                <code>{h.name}</code>
                                <span>{h.description}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                    <div class="alpha-ext-dsub">
                      <div class="alpha-ext-dsub-t">{t("alpha.ext.detailRisk")}</div>
                      <p class="alpha-ext-dboundary">{t("alpha.ext.pluginRisk")}</p>
                      <p class="alpha-ext-dnote">{t("alpha.ext.pluginEffect")}</p>
                    </div>
                    {/* D4 拍板:「插件 ≠ 套件」澄清 */}
                    <div class="alpha-ext-verify-note" data-info="">
                      <b>{t("alpha.ext.pluginVsBundleTitle")}</b>
                      <p>{t("alpha.ext.pluginVsBundle")}</p>
                    </div>
                  </>
                )}
              </Show>
              {/* Agent 条目(REQ-023):安装位置 + md 资产预览(含权限档 frontmatter,详情页先行档) */}
              <Show when={e().installSpec?.kind === "agent"}>
                <FactRow label={t("alpha.ext.detailInstallDir")}>{t("alpha.ext.scopeGlobal")}</FactRow>
                <div class="alpha-ext-dsub">
                  <div class="alpha-ext-dsub-t">{t("alpha.ext.detailAgentDoc")}</div>
                  <Show when={!skillDoc.loading} fallback={<p class="alpha-ext-dnote">{t("alpha.ext.loading")}</p>}>
                    <Show
                      when={skillDoc()?.ok && skillDoc()}
                      fallback={
                        <p class="alpha-ext-dnote" data-err="">
                          {(skillDoc() as { reason?: string } | undefined)?.reason ?? t("alpha.ext.skillNoAsset")}
                        </p>
                      }
                    >
                      {(doc) => <pre class="alpha-ext-ddoc">{(doc() as { content: string }).content}</pre>}
                    </Show>
                  </Show>
                </div>
              </Show>
              {/* 云 pipeline(REQ-020 T4):输入契约 / 预算默认与上限 / 执行层 / 上行数据明细 /
                  receipts-only 启用语义;code-review 另带 diff-only dispatch 入口 */}
              <Show when={cloudSpec(e())}>
                {(spec) => {
                  const fmtBudget = (b: { max_iter: number; max_tokens: number; max_wall_clock_sec: number }) =>
                    `${b.max_iter} iter · ${b.max_tokens.toLocaleString()} tokens · ${b.max_wall_clock_sec}s`
                  return (
                    <>
                      <FactRow label={t("alpha.ext.cloudPipelineKind")}>
                        <code class="alpha-ext-dcode">{spec().pipelineKind}</code>
                      </FactRow>
                      <FactRow label={t("alpha.ext.cloudTier")}>{spec().tier}</FactRow>
                      <FactRow label={t("alpha.ext.cloudBudget")}>{fmtBudget(spec().budgetDefaults)}</FactRow>
                      <FactRow label={t("alpha.ext.cloudBudgetLimits")}>{fmtBudget(spec().budgetLimits)}</FactRow>
                      <div class="alpha-ext-dsub">
                        <div class="alpha-ext-dsub-t">{t("alpha.ext.cloudInputContract")}</div>
                        <div class="alpha-ext-dtools">
                          <For each={spec().inputContract}>
                            {(f) => (
                              <div class="alpha-ext-dtool">
                                <code>
                                  {f.field}
                                  {f.required ? " *" : ""}
                                </code>
                                <span>{f.description}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                      <div class="alpha-ext-dsub">
                        <div class="alpha-ext-dsub-t">{t("alpha.ext.cloudUpstream")}</div>
                        <ul class="alpha-ext-dlist">
                          <For each={spec().upstreamData}>{(line) => <li>{line}</li>}</For>
                        </ul>
                      </div>
                      <p class="alpha-ext-dnote">{t("alpha.ext.cloudEnableNote")}</p>
                      <Show when={!cloudReady()}>
                        <p class="alpha-ext-dnote" data-err="">
                          {t("alpha.ext.cloudNeedPlatformNote")}
                        </p>
                      </Show>
                      <Show when={spec().pipelineKind === "code-review"}>
                        <CloudDispatchBox spec={spec()} ready={cloudReady()} />
                      </Show>
                    </>
                  )
                }}
              </Show>
              {/* 套件:组合清单(序号 + 逐项状态 + 未装项行内安装 = 逐项重试,T3) */}
              <Show when={e().type === "bundle"}>
                <div class="alpha-ext-dbundle">
                  <For each={(e().bundleItems ?? []).slice().sort((a, b) => a.installOrder - b.installOrder)}>
                    {(it, idx) => {
                      const sub = props.byId(it.catalogEntryId)
                      if (!sub) return null
                      const ic = iconFor(sub)
                      const subInstalled = () => props.ext.isInstalled(sub)
                      return (
                        <div
                          class="alpha-ext-dbundle-row"
                          role="button"
                          tabindex="0"
                          onClick={() => props.onOpenEntry(sub)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault()
                              props.onOpenEntry(sub)
                            }
                          }}
                        >
                          <span class="alpha-ext-dbundle-n">{idx() + 1}</span>
                          <span class="alpha-ext-install-ic" style={{ background: ic.color }}>
                            {ic.glyph}
                          </span>
                          <span class="alpha-ext-install-nm">{sub.displayName}</span>
                          <Show when={it.optional}>
                            <span class="alpha-ext-install-opt">{t("alpha.ext.optional")}</span>
                          </Show>
                          <span class="alpha-ext-install-k">{typeLabel(sub.type)}</span>
                          <Show
                            when={subInstalled()}
                            fallback={
                              <button
                                class="alpha-ext-add"
                                disabled={props.busy() === sub.id}
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  props.onInstall(sub)
                                }}
                              >
                                {props.busy() === sub.id ? t("alpha.ext.adding") : t("alpha.ext.add")}
                              </button>
                            }
                          >
                            <span class="alpha-ext-dhead-installed">✓</span>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
        {/* Agent:mode/来源/model/variant + 系统提示预览(折叠)+ 权限档摘要(T3) */}
        <Show when={agent()}>
          {(a) => (
            <>
              <FactRow label={t("alpha.ext.detailMode")}>{a().mode}</FactRow>
              <FactRow label={t("alpha.ext.detailSource")}>
                {a().native ? t("alpha.ext.agentBuiltinNote") : t("alpha.ext.agentSelf")}
              </FactRow>
              <Show when={a().model}>
                <FactRow label={t("alpha.ext.detailModel")}>
                  <code class="alpha-ext-dcode">
                    {a().model!.providerID}/{a().model!.modelID}
                  </code>
                </FactRow>
              </Show>
              <Show when={a().variant}>
                <FactRow label={t("alpha.ext.detailVariant")}>{a().variant}</FactRow>
              </Show>
              <div class="alpha-ext-dsub">
                <div class="alpha-ext-dsub-t">{t("alpha.ext.detailPermission")}</div>
                {/* v2 SDK PermissionRuleset = Array<PermissionRule>(运行时已证);Array.isArray
                    防御 v1/未来形状漂移 —— 形状不符时诚实落到「随引擎默认」而非崩。 */}
                <Show
                  when={Array.isArray(a().permission) && (a().permission ?? []).length > 0}
                  fallback={<p class="alpha-ext-dnote">{t("alpha.ext.permissionDefault")}</p>}
                >
                  <div class="alpha-ext-dtools">
                    <For each={(a().permission ?? []).slice(0, 10)}>
                      {(rule) => (
                        <div class="alpha-ext-dtool">
                          <code>
                            {rule.permission}
                            {rule.pattern && rule.pattern !== "*" ? ` (${rule.pattern})` : ""}
                          </code>
                          <span data-action={rule.action}>{rule.action}</span>
                        </div>
                      )}
                    </For>
                  </div>
                  <Show when={(a().permission ?? []).length > 10}>
                    <p class="alpha-ext-dnote">+{(a().permission ?? []).length - 10}</p>
                  </Show>
                </Show>
              </div>
              <Show when={a().prompt}>
                <details class="alpha-ext-dprompt">
                  <summary>{t("alpha.ext.detailPrompt")}</summary>
                  <pre class="alpha-ext-ddoc">{a().prompt}</pre>
                </details>
              </Show>
            </>
          )}
        </Show>
        {/* 云连接器(REQ-020 T3):实时连接状态 + 4 工具 + 注入说明(非安装项,mcp.cloud 由
            sidecar 在 platform 登录态注入 —— 未点亮时不装「即将可用」,说清为什么灰) */}
        <Show when={isCloudConnector()}>
          <FactRow label={t("alpha.ext.cloudConnStatus")}>
            <Show
              when={cloudReady()}
              fallback={<span class="alpha-ext-cloudst" data-st="off">{t("alpha.ext.cloudConnNeedLogin")}</span>}
            >
              <span class="alpha-ext-cloudst" data-st={cloudLive()?.connected ? "on" : "idle"}>
                {cloudLive()?.connected ? t("alpha.ext.cloudConnConnected") : t("alpha.ext.cloudConnDisconnected")}
              </span>
            </Show>
          </FactRow>
          <FactRow label={t("alpha.ext.detailTransport")}>{t("alpha.ext.transportRemote")}</FactRow>
          <Show when={!cloudReady() && props.onLogin}>
            <div class="alpha-ext-dsub">
              <button class="alpha-ext-add" data-variant="primary" onClick={() => props.onLogin!()}>
                {t("alpha.ext.cloudLoginCta")}
              </button>
            </div>
          </Show>
          <div class="alpha-ext-dsub">
            <div class="alpha-ext-dsub-t">{t("alpha.ext.detailTools")}</div>
            <div class="alpha-ext-dtools">
              <For each={CLOUD_TOOLS}>
                {(tool) => (
                  <div class="alpha-ext-dtool">
                    <code>{tool.name}</code>
                    <span>{t(tool.key as never)}</span>
                  </div>
                )}
              </For>
            </div>
            <p class="alpha-ext-dnote">{t("alpha.ext.toolsHint")}</p>
          </div>
          <div class="alpha-ext-verify-note" data-info="">
            <b>{t("alpha.ext.cloudInjectTitle")}</b>
            <p>{t("alpha.ext.cloudInjectNote")}</p>
          </div>
        </Show>
      </Section>

      {/* ── 数据边界(T2 基线:remote=目的 host,local=仅本机;REQ-020:云条目/连接器引 ADR-021) ── */}
      <Section title={t("alpha.ext.detailBoundary")}>
        <p class="alpha-ext-dboundary">
          <Show
            when={entry()}
            fallback={isCloudConnector() ? t("alpha.ext.boundaryCloud") : t("alpha.ext.boundaryLocalOnly")}
          >
            {(e) => {
              const spec = mcpSpec(e())
              if (spec?.mcpType === "remote") return t("alpha.ext.boundaryRemote", { host: hostOf(spec.url) })
              // 本地命令型 MCP 不等于「不出网」——进程在本机跑,但可能按其功能访问外部服务
              // (如 GitHub 连接器访问 github.com)。逐条目的地列举归 T4;这里只做诚实概述。
              if (spec) return t("alpha.ext.boundaryLocalCmd")
              if (e().type === "plugin") return t("alpha.ext.boundaryPluginProc")
              if (e().type === "bundle") return t("alpha.ext.boundaryBundle")
              if (e().type === "cloud") return t("alpha.ext.boundaryCloud")
              return t("alpha.ext.boundaryLocalOnly")
            }}
          </Show>
        </p>
      </Section>

      {/* ── 运行时依赖(T4:进页即实时 which 检测;缺失给安装指引,不等点「添加」才发现) ── */}
      <Show when={entry()}>
        <Section title={t("alpha.ext.detailRuntime")}>
          <Show
            when={(mcpSpec(entry()!)?.runtimeDep ?? []).length > 0}
            fallback={<p class="alpha-ext-dnote">{t("alpha.ext.noRuntimeDeps")}</p>}
          >
            <div class="alpha-ext-dpills">
              <For each={mcpSpec(entry()!)!.runtimeDep}>
                {(dep) => {
                  const state = () => {
                    if (depCheck.loading || !depCheck()) return "checking"
                    const hit = depCheck()!.find((r) => r.dep === dep)
                    return hit ? (hit.ok ? "ok" : "missing") : "checking"
                  }
                  return (
                    <span class="alpha-ext-meta" data-dep={state()}>
                      {dep}
                      {state() === "checking" ? ` · ${t("alpha.ext.depChecking")}` : state() === "ok" ? " ✓" : ` ✗ ${t("alpha.ext.depMissing")}`}
                    </span>
                  )
                }}
              </For>
            </div>
            <Show when={!depCheck.loading && (depCheck() ?? []).some((r) => !r.ok)}>
              <div class="alpha-ext-verify-note">
                <b>{t("alpha.ext.depMissingTitle")}</b>
                <For each={(depCheck() ?? []).filter((r) => !r.ok)}>
                  {(r) => (
                    <p>
                      {t("alpha.ext.depGuide", { dep: r.dep })} <code class="alpha-ext-dcode">{DEP_GUIDE[r.dep] ?? `brew install ${r.dep}`}</code>
                    </p>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Section>

        {/* ── 所需密钥 ── */}
        <Section title={t("alpha.ext.detailSecrets")}>
          <Show
            when={(mcpSpec(entry()!)?.requiredEnvVars ?? []).length > 0}
            fallback={<p class="alpha-ext-dnote">{t("alpha.ext.noSecrets")}</p>}
          >
            <div class="alpha-ext-dpills">
              <For each={mcpSpec(entry()!)!.requiredEnvVars}>
                {(v) => (
                  <span class="alpha-ext-meta">
                    <LockIc />
                    {v}
                  </span>
                )}
              </For>
            </div>
            <p class="alpha-ext-dnote">{t("alpha.ext.keyHint")}</p>
          </Show>
        </Section>
      </Show>

    </div>
  )
}
