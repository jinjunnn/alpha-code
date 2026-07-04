// Extension detail page (REQ-019 T2) — the hub's second-level page, rendered in place of the list
// when a card is clicked. Back button + Escape pop back to the list (the hub owns the Esc chain:
// detail → list → close). Generic skeleton per docs/designs/2026-07-04-extension-hub-v3-universal §5.3:
// header (icon/name/source/license/version/「待核实」) → 简介 → type-specific slot → 数据边界 →
// 运行时依赖 → 所需密钥 → 操作区. T3 fills the type-specific blocks (tools[]/SKILL.md/hooks…);
// T4 upgrades 数据边界/依赖 to live which-checks.

import { createMemo, createResource, For, Show, type Accessor, type JSX } from "solid-js"
import { t } from "../i18n"
import type { CatalogEntry, McpInstallSpec, PluginInstallSpec, SkillInstallSpec } from "./catalog-types"
import type { InstallReceipt } from "../../preload/types"
import type { ExtensionsApi, HubAgent } from "./use-extensions"
import { iconFor, iconForRow, sourceLabel, typeLabel, Svg, LockIc } from "./ext-presentation"

/** What the detail page shows: a catalog entry, or an engine agent (no catalog identity). */
export type DetailTarget = { kind: "entry"; entry: CatalogEntry } | { kind: "agent"; agent: HubAgent }

function mcpSpec(e: CatalogEntry): McpInstallSpec | undefined {
  return e.installSpec?.kind === "mcp" ? e.installSpec : undefined
}
function skillSpec(e: CatalogEntry): SkillInstallSpec | undefined {
  return e.installSpec?.kind === "skill" ? e.installSpec : undefined
}
function pluginSpec(e: CatalogEntry): PluginInstallSpec | undefined {
  return e.installSpec?.kind === "plugin" ? e.installSpec : undefined
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
  onBack: () => void
  /** Stage the entry in the hub's install-confirm dialog (same flow as the card 添加). */
  onInstall: (e: CatalogEntry) => void
  onUninstall: (receipt: InstallReceipt) => void
  /** Navigate the detail page to another entry (bundle item click). */
  onOpenEntry: (e: CatalogEntry) => void
}) {
  const entry = () => (props.target.kind === "entry" ? props.target.entry : undefined)
  const agent = () => (props.target.kind === "agent" ? props.target.agent : undefined)

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
    () => (entry() && skillSpec(entry()!)?.builtinAssetKey) || undefined,
    (key) => window.api.ext.readBuiltinSkill(key),
  )

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
                    disabled={props.busy() === e().id}
                    onClick={() => props.onInstall(e())}
                  >
                    {props.busy() === e().id
                      ? t("alpha.ext.adding")
                      : e().type === "plugin"
                        ? t("alpha.ext.installPluginBtn")
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
                {a().native ? t("alpha.ext.agentBuiltinNote") : t("alpha.ext.sourceAlpha")}
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
      </Section>

      {/* ── 数据边界(T2 基线:remote=目的 host,local=仅本机;T4 补齐 ADR-021 云条目) ── */}
      <Section title={t("alpha.ext.detailBoundary")}>
        <p class="alpha-ext-dboundary">
          <Show when={entry()} fallback={t("alpha.ext.boundaryLocalOnly")}>
            {(e) => {
              const spec = mcpSpec(e())
              if (spec?.mcpType === "remote") return t("alpha.ext.boundaryRemote", { host: hostOf(spec.url) })
              // 本地命令型 MCP 不等于「不出网」——进程在本机跑,但可能按其功能访问外部服务
              // (如 GitHub 连接器访问 github.com)。逐条目的地列举归 T4;这里只做诚实概述。
              if (spec) return t("alpha.ext.boundaryLocalCmd")
              if (e().type === "plugin") return t("alpha.ext.boundaryPluginProc")
              if (e().type === "bundle") return t("alpha.ext.boundaryBundle")
              return t("alpha.ext.boundaryLocalOnly")
            }}
          </Show>
        </p>
      </Section>

      {/* ── 运行时依赖(T2 静态清单;T4 变实时 which 检测) ── */}
      <Show when={entry()}>
        <Section title={t("alpha.ext.detailRuntime")}>
          <Show
            when={(mcpSpec(entry()!)?.runtimeDep ?? []).length > 0}
            fallback={<p class="alpha-ext-dnote">{t("alpha.ext.noRuntimeDeps")}</p>}
          >
            <div class="alpha-ext-dpills">
              <For each={mcpSpec(entry()!)!.runtimeDep}>
                {(dep) => <span class="alpha-ext-meta">{dep}</span>}
              </For>
            </div>
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
