// The Extension Hub (定制中心) — a full PAGE (not a modal) covering the content area, rendered as a
// sibling of <AlphaSidebar> inside AppInterface (renderer/index.tsx) via a dedicated Portal host on
// #root. Only mounted while open, so it can never intercept background clicks. Browsable items come
// from the bundled catalog; install status + actions go through useExtensions (receipts ⨝ SDK truth
// + thin persist IPC).
//
// IA(`#1594`,REQ-236 批准稿 `docs/design/2026-10-30-req236-ux-config-pages/frame.html#hub`):横向三页
// 连接器 / 技能 / 助手。每页 = 标题 + 一行副标题 + 本页搜索 +「添加 ▾」;每页顶部「已安装」一组,
// 下面是可添加的条目(连接器按类别分组,另有扩展包 / Code Puppy 云 / 套件三组;技能与助手分「推荐 / 系统」)。
// 列表行 = 图标 + 名称 + 一行描述 + 一个动作。Clicking a row body opens the in-hub detail page
// (extension-detail.tsx) as a drill-down WITHIN the current tab (tab stays highlighted); Esc pops
// one level at a time (confirm dialog → detail → list → close).
//
// 「添加」三档分流 (Q1/Q2 approved): skill = direct install (no dialog); MCP/bundle = confirm
// dialog (key capture / fan-out list); plugin = detail-page-first (install from the page, with a
// risk line in its confirm dialog).

import { createEffect, createMemo, createResource, createSignal, For, Show, onCleanup, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation } from "@solidjs/router"
import { t } from "../i18n"
import { parseRoute } from "../../shared/route-manifest"
import { initialDesiredState } from "../../shared/ext-install-policy"
import { projectLabel } from "../sidebar/route"
import { subscribeAuthState } from "../auth-recovery"
import { BuiltinControlsPanel } from "./builtin-controls-panel"
import { catalog, catalogSource, entryVersion, refreshCatalog } from "./catalog-source"
import { installableCatalogEntries, installableCatalogPackages } from "./catalog-installable-view"
import { Dialog } from "../alpha-ui/Dialog"
import { Button } from "../alpha-ui/Button"
import { pushToast } from "../alpha-ui/Toast"
import { Banner } from "../alpha-ui/Banner"
import type { ServerInfo } from "../sidebar/use-projects"
import {
  DEFAULT_CATALOG_INSTALL_SCOPE,
  sdkMcpStatusForReceipt,
  nameOnlyLiveMcpIsUnambiguousGlobal,
  projectMcpStatusView,
  hubRowFor,
  hubStateView,
  useExtensions,
  isAuthzRequired,
  isLocalPluginRoute,
  type ActionResult,
  type CatalogInstallScopeChoice,
  type HubAgent,
  type LocalPackagePreviewV1,
} from "./use-extensions"
import { ExtStandaloneAuthzDialog } from "./ext-authz"
import { createInstallConfirm, InstallConfirmBody, InstallConfirmFooter } from "./install-confirm"
import type { ProviderAddressRejection } from "../../shared/alpha-model-types"

/** `#1381`:远程连接器地址被拒的类别 → 文案键(类别本身来自 main,与出网围栏同一个函数)。 */
const MCP_ADDRESS_REJECTION_KEY = {
  "invalid-url": "alpha.ext.customMcpAddress.invalidUrl",
  "not-https": "alpha.ext.customMcpAddress.notHttps",
  loopback: "alpha.ext.customMcpAddress.loopback",
  "host-shape": "alpha.ext.customMcpAddress.hostShape",
  port: "alpha.ext.customMcpAddress.port",
} as const satisfies Record<ProviderAddressRejection, string>
import type { AuthorizationConfirmationWire, CapabilityDiffWire } from "../../shared/ext-capability-authorization"
import type { Catalog, CatalogEntry, InstalledState } from "./catalog-types"
import type { AuthState, InstallReceipt, InstallReceiptType, ProvenanceRequest } from "../../preload/types"
import { hubSection, setHubSection, type HubSection } from "./ext-hub-state"
import { extensionError, catalogDescription, iconFor, iconForRow, MoreMenu, PackageLogo, typeLabel, Svg, SearchIc, type MoreMenuItem } from "./ext-presentation"
import { inventoryInstallRow, healthPresentation } from "./ext-inventory-present"
import { ExtensionDetail, type DetailTarget } from "./extension-detail"
import { officeAdvisoryFor, retiredCommunityOfficeFor } from "../../shared/office-advisories"
// #397 PR-B:四级货架与策展呈现(纯派生层;解码真源 = shared/catalog-curation,fail-closed)。
import { curatedOf, curationMapOf, curationOf, isArchived, isSessionGrant, splitBrowse } from "./ext-curation-view"
// #408 PR-C:会话开关纯派生层(状态机 / 拒绝码路由;真源 = main grant 登记 + 本地连接结果)。
import { findSessionGrant, sessionGrantKeyOf, sessionRefusalRoute, sessionToggleView } from "./ext-session-toggle"
import { curationActivationFacts, type Curation, type CurationStatus } from "../../shared/catalog-curation"
import type { CatalogPackageViewV1 } from "../../shared/catalog-package-view"
import { packageRetainedReasonKey } from "./ext-package-presentation"
import { packageListingTextV1 } from "../../shared/host-extension-package-contract/decoder"
import { extIpc } from "./ext-ipc"
import "./extension-hub.css"


// A unified row in the 已安装 manage list (REQ-018 T6): any installed item, whatever its type.
type ManageRow = {
  key: string
  type: InstallReceiptType
  name: string
  displayName: string
  source?: CatalogEntry["source"]
  version?: string
  receipt: InstallReceipt
  entry?: CatalogEntry
  mcp?: InstalledState // MCP only — live connect/error status from the SDK
}

// `#1594`:三个页签(批准稿 `#hub-tabs`)。每页的副标题、搜索占位,以及「已安装」组收哪几类安装物。
const TABS: { key: HubSection; labelKey: string; subKey: string; searchKey: string }[] = [
  { key: "connectors", labelKey: "alpha.ext.tabConnectors", subKey: "alpha.ext.connectorsSub", searchKey: "alpha.ext.searchConnectors" },
  { key: "skills", labelKey: "alpha.ext.tabSkills", subKey: "alpha.ext.skillsSub", searchKey: "alpha.ext.searchSkills" },
  { key: "agents", labelKey: "alpha.ext.tabAgents", subKey: "alpha.ext.agentsSub", searchKey: "alpha.ext.searchAgents" },
]
/** 一条安装物在哪一页的「已安装」组里:技能与命令进技能页,助手进助手页,其余(连接器、插件、套件、云)进连接器页。 */
function pageOfType(type: InstallReceiptType): HubSection {
  if (type === "skill" || type === "command") return "skills"
  if (type === "agent") return "agents"
  return "connectors"
}

// Connector grouping order (catalog `category`). "other" catches anything unmapped.
const CAT_ORDER = ["dev", "office", "research", "china-office", "design", "other"] as const
function catLabel(cat: string): string {
  switch (cat) {
    case "dev":
      return t("alpha.ext.cat.dev")
    case "office":
      return t("alpha.ext.cat.office")
    case "research":
      return t("alpha.ext.cat.research")
    case "china-office":
      return t("alpha.ext.cat.china-office")
    case "design":
      return t("alpha.ext.cat.design")
    default:
      return t("alpha.ext.cat.other")
  }
}

// Numeric-aware version compare for catalog snapshot versions ("2026-07-03.1"): true if a < b.
function versionLess(a: string, b: string): boolean {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

// `#1594` AC6:需要令牌或本机文件的扩展包,行上直接写缺什么。官方两条按前置项的 id 说人话
// (id 由 `shared/package-secret-prerequisite.ts` 以「组件 id#变量名」生成,安装确认框按同一 id 给填写说明);
// 其余前置项的 label 就是确认框里那一格的名字,照它说。
const PREREQUISITE_NEED_KEYS: Record<string, string> = {
  "mcp:github-official#GITHUB_PERSONAL_ACCESS_TOKEN": "alpha.ext.needGithubToken",
  "mcp:dbhub-readonly#DSN": "alpha.ext.needDatabaseFile",
}
function prerequisiteNeedText(view: CatalogPackageViewV1): string {
  return view.prerequisites.items
    .map((item) => {
      const key = PREREQUISITE_NEED_KEYS[item.prerequisiteId]
      return key ? t(key as never) : t("alpha.ext.needItem", { item: item.label })
    })
    .join(" · ")
}

export function ExtensionHub(props: {
  server: Accessor<ServerInfo | undefined>
  open: Accessor<boolean>
  onClose: () => void
}) {
  let hubCloseButton: HTMLButtonElement | undefined
  // REQ-099(#307)项目上下文 = 当前路由的项目目录(route-manifest parseRoute 先例;
  // 设计稿 Q1 采 A 案)。home/new-session 路由 = 无上下文 →「本项目」组不渲染。
  const loc = useLocation()
  const projectDir = createMemo((): string | undefined => {
    const r = parseRoute(loc.pathname)
    return r.kind === "session" || r.kind === "directory" ? r.directory : undefined
  })
  const ext = useExtensions(props.server, props.open, projectDir)
  const section = hubSection
  // REQ-103(#195):governance 只读视图(逐扩展五维所有权 + availability/activation/health 三态)。
  // 唯一只读通道,零写面;keyed on open + 账本内容指纹 + 项目上下文(#307:传 projectDir 即出项目行)。
  // Codex r1 M1:指纹取逐收据 id/scope/version/installedAt 而非 length —— 扩权更新原地改写收据与
  // grants(数量不变),length key 会让详情页的「已授权能力」段停在旧授权集。详情页消费 ownership/
  // 来源签名/已授权能力,已安装 pane 消费 health 三态(按 (id,scope) join,AC5 同名并存各取各)。
  const receiptFingerprint = (rs: readonly InstallReceipt[]) =>
    rs.map((r) => `${r.id}@${r.scope}@${r.version ?? ""}@${r.installedAt}`).join("|")
  const [governance, { refetch: refetchGovernance }] = createResource(
    () =>
      props.open()
        ? `${receiptFingerprint(ext.store.receipts)}:${receiptFingerprint(ext.store.projectReceipts)}:${projectDir() ?? ""}`
        : null,
    () => extIpc.inventoryView(projectDir()),
  )
  // ── REQ-128 Phase 3 `#784` 第 6 跳:本机已装扩展包 ────────────────────────────────────────
  //
  // 在这条 resource 之前,已安装页对「包」是**结构上**看不见的:唯一能看到包的地方是目录条目
  // 详情页的 `kind === "package"` 分支,而它只能从远程目录进得去。本地导入的包没有目录条目
  // ⇒ 装完就再也找不到它,也没有任何地方能把它整个拿掉。
  //
  // key 里带账本指纹:装完/卸完 receipts 变了就自动重取。启停**不**改指纹(desiredState 不在
  // 指纹里),所以 `runStateToggle` 末尾显式 `refetchPackages()` —— 少这一行的后果是开关拨完
  // 包卡上的「未启用」不消失,用户以为没生效又去拨一次。
  // key 里也带 tab:进连接器页(已装扩展包在它的「已安装」组,`#1594`)就重读一次。这不只是省一次 IPC ——
  // 账本在别处坏掉时,「回到这一页会重新读」是用户唯一能自己走到「读不出」那条如实呈现上的路。
  const [installedPackages, { refetch: refetchPackages }] = createResource(
    () => (props.open() && section() === "connectors" ? `${receiptFingerprint(ext.store.receipts)}` : null),
    () => ext.listInstalledPackages(),
  )
  /** 这个包在界面上叫什么。**`#784` owner 裁决**:显示插件作者自己声明的名字;
   *  存量图没有这个字段时才回退到 root 组件名(那是包里某个技能的名字,不是包名)。
   *  空白 / 只有空格一律当缺席 —— 用户绝不该看到一张没有名字的卡。 */
  const packLabel = (pack: { displayName: string | null; rootComponentName: string }): string =>
    (pack.displayName ?? "").trim() || pack.rootComponentName
  /** 已装扩展包清单**读不出来**(与「一个都没装」是两件事)。 */
  const packagesUnreadable = () => {
    const state = installedPackages()
    return !!state && !state.ok
  }
  /** 一个 `kind:name` 属不属于某个已装扩展包 —— 属于就不能被单独移除(第 8 跳)。
   *  真源是 main 的包图投影,**不是**从名字或 id 前缀猜的。 */
  const packageOwnerOf = createMemo(() => {
    const state = installedPackages()
    const owners = new Map<string, { packageId: string; label: string }>()
    if (!state || !state.ok) return owners
    for (const pack of state.packages)
      for (const component of pack.components)
        owners.set(`${component.kind}:${component.name}`, { packageId: pack.packageId, label: packLabel(pack) })
    return owners
  })
  // REQ-020 T2:云门控。subscribe 会立即回放当前态(preload 内置 getState),再跟增量推送。
  // 云可用 ⟺ 已登录且 platform 模式(mcp.cloud 由 sidecar 在该态注入,ADR-013/ADR-016)。
  const [authState, setAuthState] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  onCleanup(subscribeAuthState(setAuthState))
  // 「人在平台上」——**身份轴**,不含凭证是否可用。只驱动**文案分支**,绝不单独放行能力。
  const onPlatform = () => authState().status === "logged-in" && authState().mode === "platform"
  // `#624`:平台凭证正在恢复。`platformStatus` 只在登录态出现(main/alpha-auth.ts deriveState),
  // 故 `?? "ready"` 的缺席分支恒被 `onPlatform()` 先挡掉,与 alpha-composer.tsx:1110 同约定。
  const cloudRecovering = () => onPlatform() && (authState().platformStatus ?? "ready") === "recovering"
  // `#624`:**能力放行**判据 —— 恢复中 fail-close。此前只看 status+mode,recovering 照样放行。
  //
  // 为什么 fail-close(判断依据,退出条件 1 要求写下来而不是默默改掉):
  //  ① `platformStatus:"recovering"` 的定义(preload/types.ts)就是「平台代理凭证**尚未**验证
  //     可用」——app 自己已经不信这份凭证了。
  //  ② 这个谓词放行的不是展示,是本渲染进程**权限最高**的两个动作:云派发(ADR-021 的代码
  //     出境 + 平台计费)与 enableCloud。
  //  ③ main **不会**替我们兜底:`getAccessToken`(alpha-auth.ts)只校验 token 的 purpose 声明、
  //     不看有效期,`alpha-cloud-jobs.ts` 的 `authed()` 只判 token **在不在**。所以过期那一支里,
  //     本谓词是「把 diff 发给平台」与用户之间的**唯一**一道闸 —— 放行的结果是代码先出境、
  //     再收 401,而不是拦下来。
  //  ④ 同一信号的其余**放行型**消费者早已 fail-close(alpha-composer.tsx:911/1110,以及同目录
  //     下 composer 的模型链姊妹件里 loadSummary 的 recovering 短路 —— 那个模块名不写全,
  //     REQ-090 的纯文本棘轮(takeover-adapter-coexistence.test.ts)按 token 计命中,
  //     一句引用会被它记成「又一个挂载点」)。本谓词 2026-07-06 写成,`platformStatus` 2026-07-24 才
  //     随 REQ-109/110 落地 —— 这是**契约落地前写的旧判据**漏了跟进,不是刻意豁免。
  //  ⑤ fail-close 有界自证,不是死锁:auth-recovery.ts 不变量 A/B 保证 owner 持续重读到 ready。
  //
  // 接受的代价:`recovering` 有两支成因(凭证过期 / 续期未换血),后者 main 手上其实握着新
  // token、派发本会成功,被一并拦下。renderer 收到的是**同一个** `recovering`,分辨不出来;
  // 一对分辨不出的成因,安全方向是 fail-close。
  //
  // ⚠️ fail-close **不等于**复用未登录/BYOK 那套文案:此时用户确实已登录、确实在 platform 模式,
  // 说「切换到平台模式」既是假话,按钮点下去还是 no-op。恢复中因此走自己的一支(见云 tab 门控条)。
  const cloudReady = () => onPlatform() && !cloudRecovering()
  const cloudLive = () => ext.store.mcp["cloud"]
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  // #395(Codex r9 B3):启停唯一处理器 —— 行内开关(row)与详情页开关共用,保证详情页不再绕过
  // desired-state/advisory 通道直连 MCP。入参已由调用方按各自数据源解出(receipt/当前启用态/是否
  // live-unreceipted/mcp 连接态)。account:has-receipt → setInstallState(过 advisory + 账本 + config)
  // 后再切 live;live-unreceipted → 纯 live connect/disconnect。两路 disconnect/dispose 失败均如实
  // 提示待重载,advisory 拒(R14)走 error toast。
  // #397:复审过期的 enable 显式确认(main 闸 code=expired-review-confirmation-required 驱动;
  // 确认后携 confirmExpiredReview 重发 —— 覆盖一切 enable 路径,不只已装行 toggle)。
  // #408:会话启用同属 enable 路径 —— 同一对话框第二形态(mode 判别;确认后携标记重走 grant 通道)。
  const [expiredConfirm, setExpiredConfirm] = createSignal<
    | { mode: "persistent"; receipt: InstallReceipt; type: string; name: string }
    | { mode: "session"; catalogId: string; directory: string }
    | null
  >(null)
  const expiredConfirmDate = createMemo(() => {
    const pending = expiredConfirm()
    if (!pending) return ""
    const c = curatedOf(statusOf(pending.mode === "persistent" ? pending.receipt.id : pending.catalogId))
    return c ? c.review.reviewBefore.slice(0, 10) : ""
  })
  const finishEnable = async (args: { receipt: InstallReceipt; type: string; name: string }, r: ActionResult): Promise<void> => {
    if (!r.ok) {
      pushToast({ kind: "error", title: extensionError(r.reason, "alpha.ext.error.enable") })
      return
    }
    let mcPending = false
    if (args.type === "mcp") {
      const mc = await ext.setMcpConnected(args.name, true)
      mcPending = mc.reason === "reload-pending"
    }
    if (r.reason === "reload-pending" || mcPending) pushToast({ kind: "info", title: t("alpha.ext.statePendingReload") })
    await refetchGovernance()
  }
  const proceedExpiredEnable = async (): Promise<void> => {
    const pending = expiredConfirm()
    if (!pending) return
    setExpiredConfirm(null)
    if (pending.mode === "session") {
      await finishSessionGrant(pending.catalogId, pending.directory, { confirmExpiredReview: true })
      return
    }
    await finishEnable(pending, await ext.setInstallState(pending.receipt, "enabled", { confirmExpiredReview: true }))
  }
  // ── #408:会话开关(实验室条目;行内与详情页共用一条通道,同 runStateToggle 纪律)────────────
  // directory = 当前路由的项目目录(引擎 instance 的 enforcement 空间);home/new-session 无
  // instance 上下文 → 开关禁用 + 如实提示(main 要求绝对路径,fail-closed)。
  const sessionDirectory = () => projectDir()
  const [sessionBusy, setSessionBusy] = createSignal<string | null>(null)
  const sessionViewFor = (catalogId: string) =>
    sessionToggleView(
      findSessionGrant(ext.store.sessionGrants, catalogId, sessionDirectory()),
      sessionDirectory() ? ext.store.sessionLink[sessionGrantKeyOf(catalogId, sessionDirectory()!)] : undefined,
    )
  const finishSessionGrant = async (catalogId: string, directory: string, opts?: { confirmExpiredReview?: boolean }): Promise<void> => {
    const r = await ext.grantSession(catalogId, directory, opts)
    if (!r.ok) {
      const route = sessionRefusalRoute(r.code)
      if (route.kind === "expired-confirm") {
        setExpiredConfirm({ mode: "session", catalogId, directory })
        return
      }
      pushToast({ kind: route.tone === "info" ? "info" : "error", title: t(route.textKey) })
      return
    }
    // grant ok ≠ 已连接:连接未成功如实提示(状态行同步 warn 态,可关闭后重试)。
    if (!r.connected) pushToast({ kind: "info", title: t("alpha.ext.sessionOnNoLink") })
  }
  const runSessionToggle = async (args: { catalogId: string; name: string; on: boolean }): Promise<void> => {
    const dir = sessionDirectory()
    if (!dir) {
      pushToast({ kind: "info", title: t("alpha.ext.sessionNeedsProject") })
      return
    }
    if (sessionBusy()) return
    setSessionBusy(args.catalogId)
    try {
      if (args.on) await finishSessionGrant(args.catalogId, dir)
      else await ext.revokeSession(args.catalogId, dir, args.name)
    } finally {
      setSessionBusy(null)
    }
  }
  // #408:会话结束事件(sidecar 停止/崩溃)→ 开关已由数据层归位,此处如实提示(v6:行保留、开关归位)。
  onCleanup(extIpc.onSessionGrantsEnded(() => pushToast({ kind: "info", title: t("alpha.ext.sessionEndedToast") })))
  const runStateToggle = async (args: {
    receipt: InstallReceipt
    type: string
    name: string
    currentlyOn: boolean
    liveUnreceipted: boolean
    mcpConnected: boolean
  }): Promise<void> => {
    if (args.liveUnreceipted && args.type === "mcp") {
      const mc = await ext.setMcpConnected(args.name, !args.mcpConnected)
      if (mc.reason === "reload-pending") pushToast({ kind: "info", title: t("alpha.ext.statePendingReload") })
      return
    }
    const next = args.currentlyOn ? "disabled" : "enabled"
    const r = await ext.setInstallState(args.receipt, next)
    if (!r.ok) {
      // #397:main enable 闸的机器码路由(不解析 reason;用户语言文案,零开发术语)。
      const code = "code" in r ? r.code : undefined
      if (code === "expired-review-confirmation-required") {
        setExpiredConfirm({ mode: "persistent", receipt: args.receipt, type: args.type, name: args.name })
        return
      }
      if (code === "session-grant-persistent-enable") {
        pushToast({ kind: "info", title: t("alpha.ext.sessionOnlyRefused") })
        return
      }
      if (code === "curation-unverifiable") {
        pushToast({ kind: "error", title: t("alpha.ext.curationUnverifiable") })
        return
      }
      pushToast({ kind: "error", title: extensionError(r.reason, "alpha.ext.error.toggle") })
      return
    }
    let mcPending = false
    if (args.type === "mcp") {
      const mc = await ext.setMcpConnected(args.name, next === "enabled")
      mcPending = mc.reason === "reload-pending"
    }
    if (r.reason === "reload-pending" || mcPending) pushToast({ kind: "info", title: t("alpha.ext.statePendingReload") })
    await refetchGovernance()
    // `#784`:包卡上的「未启用」由包图投影的 `desiredState` 画出,而它不在 governance 的
    // 指纹里 —— 不显式重取,开关拨完包卡不变,用户会以为没生效。
    await refetchPackages()
  }
  // T7/T9:安装阶段(粗粒度状态机:checking→installing)与逐条行内错误(B11:失败不裸 toast)。
  const [stage, setStage] = createSignal<Record<string, "checking" | "installing">>({})
  const [cardErr, setCardErr] = createSignal<Record<string, string>>({})
  const [packageResults, setPackageResults] = createSignal<Record<string, CatalogPackageViewV1>>({})
  const currentPackageView = (view: CatalogPackageViewV1) => packageResults()[view.catalogId] ?? view
  const rememberPackageView = (view: CatalogPackageViewV1) =>
    setPackageResults((current) => ({ ...current, [view.catalogId]: view }))
  const setStageFor = (id: string, s: "checking" | "installing" | null) =>
    setStage((prev) => {
      const next = { ...prev }
      if (s) next[id] = s
      else delete next[id]
      return next
    })
  const setErrFor = (id: string, msg: string | null) =>
    setCardErr((prev) => {
      const next = { ...prev }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })
  // REQ-019 T2:详情页目标(catalog 条目或引擎 agent)。非空 = 当前 tab 内下钻显示详情页。
  const [detail, setDetail] = createSignal<DetailTarget | null>(null)
  // 安装确认框 + #348 capability 授权两阶段状态机 —— REQ-234 `#1531` 起住在 install-confirm.tsx,与 agent 安装守望者共用
  // 同一份(这里是定制中心那一个实例)。Skill 在这里直装(Q1),plugin 只从详情页进确认框(Q2)。
  // 解构只为让本文件的既有调用点一字不动(这些名字从前就是本组件的局部 signal)。
  const confirm = createInstallConfirm({
    install: (entry, secrets, authorization, scope, selectedProjectDir) => onAdd(entry, secrets, authorization, scope, selectedProjectDir),
    update: (entry, authorization) => runUpdateRedrive(entry, authorization),
    projectDir,
    // `#810`:包确认屏那一趟经数据层出站(引擎重扫与账本刷新在那一层);落定之后的呈现留在定制中心。
    installPackage: (intent) => ext.installCatalogIntent(intent),
    onPackageSettled: async (pending, result) => {
      if (!result) {
        setErrFor(pending.view.catalogId, t("alpha.ext.error.installUnknown"))
        return pending.view
      }
      if (!result.ok) {
        if ("package" in result) rememberPackageView(result.package)
        setErrFor(pending.view.catalogId, extensionError(result.reason, "alpha.ext.error.confirmPackage"))
        return "package" in result ? result.package : pending.view
      }
      // `#698` 在这里手写过一行 warning 呈现 —— `#765` 之后它归 `extIpc`(IPC 包装层),对任何具名 warning 默认生效。
      // `#810`:引擎重扫失败是**另一件事**,`extIpc` 不知道它 —— 如实说「要重载」。
      if (result.reloadPending) flash(t("alpha.ext.addedPendingReload"))
      const latest = await extIpc.packageDetail(pending.view.catalogId)
      if (latest) rememberPackageView(latest)
      return latest ?? pending.view
    },
  })
  const { confirming, openInstallConfirmation, authz, setAuthz, confirmBusy, authzBusy, cancelAuthz, confirmAuthz, openPackage, closePackageAuthz } = confirm
  // REQ-036:创建表单已移除(创建走技能:skill-creator/agent-creator 出厂注入),原表单 state 随之下线。
  // T3:存量迁移候选(旧 XDG 根里、名字匹配 catalog 的 alpha 安装物)。仅当主进程门控开启
  // (ALPHA_MIGRATE_ENABLE=1,A6 真机验证后)且有候选时显示迁移条。
  const [migrateCandidates, setMigrateCandidates] = createSignal<CatalogEntry[]>([])
  const [migrating, setMigrating] = createSignal(false)
  // T6:导入状态。importDialog = git 输入弹窗;importBusy/importErr 行内反馈(B11)。
  // ADR-040(`#825`):npm 插件导入这一档随「扩展安装不得写引擎 plugin[]」整档撤下。
  const [importDialog, setImportDialog] = createSignal<"git" | null>(null)
  // REQ-033:自定义连接器(catalog 外任意 MCP)+ agent 导入(两段式:预览映射 → 确认)
  const [customMcpOpen, setCustomMcpOpen] = createSignal(false)
  const [cmType, setCmType] = createSignal<"local" | "remote">("local")
  const [cmName, setCmName] = createSignal("")
  const [cmCommand, setCmCommand] = createSignal("")
  const [cmUrl, setCmUrl] = createSignal("")
  const [cmEnv, setCmEnv] = createSignal("")
  const [cmSecrets, setCmSecrets] = createSignal("")
  const [cmBusy, setCmBusy] = createSignal(false)
  const [cmErr, setCmErr] = createSignal("")
  const [agentPreview, setAgentPreview] = createSignal<{ previewId: string; name: string; format: string; mapping: Array<{ source: string; value: string; target: string | null; note: string }>; composed: string } | null>(null)
  const [agentBusy, setAgentBusy] = createSignal(false)
  const [agentErr, setAgentErr] = createSignal("")
  const [importInput, setImportInput] = createSignal("")
  const [importBusy, setImportBusy] = createSignal(false)
  const [importErr, setImportErr] = createSignal("")
  // REQ-128 Phase 3 `#784`:本地 Claude 插件包的预览屏状态。
  // `previewId` **可能缺席** —— 一个都装不上 / 超预算 / 已装过时 main 不签发预览:
  // 那种终态仍然要给用户一屏说明,只是没有可确认的东西(确认键保留但禁用,原因写在键面上)。
  const [localPlugin, setLocalPlugin] = createSignal<{
    previewId?: string
    headline: string
    preview: LocalPackagePreviewV1
    reasonCode?: string
  } | null>(null)
  const [localPluginBusy, setLocalPluginBusy] = createSignal(false)
  const [localPluginErr, setLocalPluginErr] = createSignal("")
  /** 刚装完的包 —— 已安装页把它排在最前并挂引导条(裁决 B 之下不引导 = 用户以为没装上)。 */
  const [highlightPackage, setHighlightPackage] = createSignal<string | null>(null)
  const [packBusy, setPackBusy] = createSignal<string | null>(null)
  const [packErr, setPackErr] = createSignal<Record<string, string>>({})
  /** 上一次整包移除**留下了什么、为什么**。
   *
   *  它**不能**挂在包卡里:移除成功之后那张卡当场就没了(包图没了),挂在卡里的解释会跟着
   *  一起消失 —— 用户看见技能还在,却再也拿不到原因。所以它是一条**区块级**的结果,
   *  由用户自己关掉。 */
  const [packRemoval, setPackRemoval] = createSignal<{
    packageId: string
    label: string
    retained: Array<{ kind: string; name: string; reasonCode: string | null }>
  } | null>(null)
  /** 第 8 跳:对属于扩展包的单个组件点了「移除」之后的**拒绝**呈现(逐行,key = `kind:name`)。
   *  这条必须留在行上,不能只发一条 toast:用户要的是「那我该怎么办」,而答案是「移除整个包」。 */
  const [rowRefusal, setRowRefusal] = createSignal<Record<string, string>>({})

  const runImportFolder = async () => {
    setImportErr("")
    setImportBusy(true)
    try {
      // REQ-098 #255:main 自弹目录选择器并直接以用户实选目录为来源;renderer 不再传 srcDir。
      const r = await ext.importSkillFolder()
      // REQ-128 Phase 3 `#784` 第 1 跳:**按 main 给的 `route` 分流**。
      // renderer 不判目录形态(它连路径都没有),也不新增第六张卡 —— 同一张「文件夹」卡,
      // 按下去之后由 main 决定这是一个技能目录还是一个插件目录。
      if (isLocalPluginRoute(r)) {
        setLocalPlugin({
          previewId: r.previewId,
          headline: r.reason,
          preview: r.localPluginPreview,
          reasonCode: r.reasonCode,
        })
        return
      }
      // ↓ 非插件目录:**逐字不变**的既有行为(成功 toast / 失败行内红字)。
      // #336 r1:projectionLag = 本次未注入(重启自愈)—— 不得宣称「当场生效」。
      if (r.ok) flash(t(r.projectionLag ? "alpha.ext.importedPendingRestart" : "alpha.ext.imported", { name: r.name ?? "" }), "success")
      else if (!r.canceled) setImportErr(extensionError(r.reason, "alpha.ext.error.importFolder"))
    } finally {
      setImportBusy(false)
    }
  }
  // ── `#784` 第 3/4 跳:本地插件包预览屏 ────────────────────────────────────────────────────
  //
  // 关掉预览屏 = **取消**,而取消必须真的把 main 侧留存的字节放掉(G19)。
  //
  // ⚠️ 这里有一条本 portfolio 栽过的形态:**中止不了却报「已取消」**。
  // main 在安装已经开跑时会如实拒绝(`install-in-flight`),那批字节仍然算在计量里。
  // 所以拒绝**不能**被读成成功:界面留在原地、把拒绝写在屏内,而不是先关掉弹窗再飞一条
  // toast —— 弹窗一关,用户读到的第一件事就是「它取消了」。
  const closeLocalPlugin = async (): Promise<void> => {
    const current = localPlugin()
    if (!current?.previewId) {
      setLocalPlugin(null)
      setLocalPluginErr("")
      return
    }
    const released = await ext.localPluginCancel(current.previewId)
    if (!released.ok) {
      setLocalPluginErr(released.reasonCode === "install-in-flight" ? t("alpha.ext.error.cancelBusy") : extensionError(released.reason, "alpha.ext.error.cancelUnknown", released.reasonCode))
      return
    }
    setLocalPlugin(null)
    setLocalPluginErr("")
  }
  const runConfirmLocalPlugin = async (): Promise<void> => {
    const current = localPlugin()
    if (!current?.previewId || localPluginBusy()) return
    setLocalPluginBusy(true)
    setLocalPluginErr("")
    try {
      const r = await ext.localPluginConfirm(current.previewId)
      if (!r.ok) {
        // 「预览过期」「安装中途失败」对用户是同一件事:**一个都没装,盘上没有半成品**。
        // 措辞里不许出现「已装了 N 个」这种中间态。
        setLocalPluginErr(extensionError(r.reason, "alpha.ext.error.localInstall", r.code))
        return
      }
      setLocalPlugin(null)
      // 裁决 B:装完默认全关。不跳页的结果是用户按完确认**什么都看不到**,然后判定功能坏了。
      // 所以确认成功后直接落在连接器页(已装扩展包在它的「已安装」组,`#1594`),新包排最前并写明下一步。
      // **先切页再重取** —— 包清单的 resource key 里带着 tab,切页本身就是那次重取的触发器。
      setDetail(null)
      setHubSection("connectors")
      setHighlightPackage(r.packageId)
      await refetchPackages()
      flash(
        r.reason === "reload-pending"
          ? t("alpha.ext.localPackageInstalledPendingReload", { count: String(r.installed.length) })
          : t("alpha.ext.localPackageInstalled", { count: String(r.installed.length) }),
        r.reason === "reload-pending" ? "info" : "success",
      )
    } finally {
      setLocalPluginBusy(false)
    }
  }
  // ── `#784` 第 7 跳:整包移除 ─────────────────────────────────────────────────────────────
  const runRemovePackage = async (packageId: string): Promise<void> => {
    if (packBusy() === packageId) return
    // 名字要在**移除之前**取:成功之后这个包就从投影里消失了,再取只能拿到空。
    const state = installedPackages()
    const target = state && state.ok ? state.packages.find((pack) => pack.packageId === packageId) : undefined
    const label = target ? packLabel(target) : packageId
    setPackBusy(packageId)
    setPackErr((prev) => ({ ...prev, [packageId]: "" }))
    try {
      const r = await ext.uninstallPackage(packageId)
      if (!r.ok) {
        // AC:移除失败**必须显示失败**。`ok` 之外的任何东西都不许被读成「已移除」——
        // 包**仍然留在列表里**,错误就在卡上。
        setPackErr((prev) => ({ ...prev, [packageId]: extensionError(r.reason, "alpha.ext.error.removePackage") }))
        return
      }
      // 留下来的部件必须说得出理由:用户点了移除却发现某个技能还在、而系统说不出为什么,
      // 那和一个缺陷没有区别。**落在区块级结果上**,因为包卡马上就要消失了。
      const retained = r.retained.map((entry) => ({ kind: entry.kind, name: entry.name, reasonCode: entry.reasonCode }))
      setPackRemoval(retained.length > 0 ? { packageId, label, retained } : null)
      await refetchPackages()
      flash(
        r.reloadPending ? t("alpha.ext.packageRemovedPendingReload") : t("alpha.ext.packageRemoved"),
        r.reloadPending ? "info" : "success",
      )
    } finally {
      setPackBusy(null)
    }
  }
  const runImportDialog = async () => {
    const kind = importDialog()
    const value = importInput().trim()
    if (!kind || !value) return
    setImportBusy(true)
    setImportErr("")
    try {
      const r = await ext.importSkillGit(value)
      if (r.ok) {
        // #336 r1:projectionLag = 本次未注入(重启自愈)—— 不得宣称「当场生效」。
        flash(
          t(r.projectionLag ? "alpha.ext.importedPendingRestart" : "alpha.ext.imported", { name: (r as { name?: string }).name ?? "" }),
          "success",
        )
        setImportDialog(null)
        setImportInput("")
      } else {
        setImportErr(extensionError(r.reason, "alpha.ext.error.importGit"))
      }
    } finally {
      setImportBusy(false)
    }
  }

  // 技能 / 助手页的「推荐 / 系统」分段(批准稿 `#hub-skills`)。
  const [segment, setSegment] = createSignal<"recommended" | "system">("recommended")
  // Tab navigation always leaves the detail page (a detail is a drill-down of its tab).
  // `#1594`:搜索是本页的(占位写「搜索连接器 / 技能 / 助手」),换页就清空,分段回到「推荐」。
  const gotoSection = (key: HubSection) => {
    setDetail(null)
    setQuery("")
    setSegment("recommended")
    setHubSection(key)
  }
  const openEntryDetail = (e: CatalogEntry) => setDetail({ kind: "entry", entry: e })
  const openPackageDetail = (view: CatalogPackageViewV1) =>
    setDetail({ kind: "package", view: currentPackageView(view), source: catalogSource() })
  const openAgentDetail = (a: HubAgent) => setDetail({ kind: "agent", agent: a })
  const runPackageAction = async (input: CatalogPackageViewV1) => {
    const view = currentPackageView(input)
    if (!view.action.enabled || busy() === view.catalogId) return view
    setErrFor(view.catalogId, null)
    setBusy(view.catalogId)
    try {
      if (view.verdict !== "compatible") {
        if (view.action.kind === "update-alpha") await window.api.updater.check()
        const latest = await extIpc.packageDetail(view.catalogId)
        if (latest) rememberPackageView(latest)
        return latest ?? view
      }
      if (view.action.kind !== "install" && view.action.kind !== "resolve-prerequisite") return view
      // package 首驱只带全新的 attempt identity；密钥与 authorization 必须等 preview 后再提交。
      // `#810`:经**数据层**出站(`ext.installCatalogIntent`),不直连 `extIpc` —— 引擎重扫接在那一层。
      const result = await ext.installCatalogIntent({
        catalogId: view.catalogId,
        attemptId: `renderer-${globalThis.crypto.randomUUID()}`,
      })
      if (
        !result.ok &&
        "stage" in result &&
        result.stage === "authorize" &&
        "packageAuthorization" in result &&
        result.packageAuthorization
      ) {
        const preview = result.packageAuthorization
        return await new Promise<CatalogPackageViewV1>((finish) => openPackage({ view, preview, finish }))
      }
      if (!result.ok) setErrFor(view.catalogId, extensionError(result.reason, "alpha.ext.error.installPackage"))
      // `#810`:引擎重扫失败 ⇒ 如实说「要重载」。今天 admission 的首驱恒走 authorize 臂,
      // 所以这条臂到不了;留着是因为它一旦到得了,缺这一行用户读到的就是一句谎话。
      if (result.ok && result.reloadPending) flash(t("alpha.ext.addedPendingReload"))
      const latest =
        !result.ok && "package" in result ? result.package : await extIpc.packageDetail(view.catalogId)
      if (latest) rememberPackageView(latest)
      return latest ?? view
    } catch (error) {
      setErrFor(view.catalogId, t("alpha.ext.error.installUnknown"))
      return view
    } finally {
      setBusy(null)
    }
  }
  const sectionLabel = () => {
    const tab = TABS.find((x) => x.key === section())
    return tab ? t(tab.labelKey as never) : t("alpha.ext.hub")
  }

  // The component stays mounted across open/close (only the Portal content is gated), so
  // component-local signals survive a close. 分区记忆是故意的(session 内);详情页与搜索词不是 ——
  // 关闭时重置,重开回到当前分区的列表(review 发现:详情页上点 ✕ 关闭再开会残留 stale 详情)。
  createEffect(() => {
    if (!props.open()) {
      closePackageAuthz()
      setDetail(null)
      setQuery("")
    } else {
      // REQ-032:进 hub 时刷新远端 catalog(main 侧 ETag 304 零成本;失败回退缓存/内置,B20 永不空白)
      void refreshCatalog()
    }
  })

  const parseEnvLines = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const i = line.indexOf("=")
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  }
  async function runAddCustomMcp() {
    if (cmBusy()) return
    setCmBusy(true)
    setCmErr("")
    try {
      const input =
        cmType() === "remote"
          ? { mcpType: "remote" as const, url: cmUrl().trim() }
          : { mcpType: "local" as const, command: cmCommand().trim().split(/\s+/).filter(Boolean) }
      const r = await ext.addCustomMcp(cmName().trim(), input, parseEnvLines(cmEnv()), parseEnvLines(cmSecrets()))
      if (!r.ok) {
        // `#1381`:地址被拒(main 与出网围栏同一个判据)时按类别用用户的语言说;其余原样。
        const addressCode = "addressCode" in r ? r.addressCode : undefined
        setCmErr(addressCode ? t(MCP_ADDRESS_REJECTION_KEY[addressCode]) : extensionError(r.reason, "alpha.ext.error.addConnector"))
        return
      }
      setCustomMcpOpen(false)
      setCmName(""); setCmCommand(""); setCmUrl(""); setCmEnv(""); setCmSecrets("")
      // #395(Codex r10 M5):重加已 disabled 的自定义 MCP —— 落盘成功但不激活连接,如实提示。
      flash(
        r.reason === "installed-disabled" ? t("alpha.ext.installedDisabled") : r.reason === "slow" ? t("alpha.ext.customMcpSlow") : t("alpha.ext.customMcpDone"),
        "success",
      )
    } finally {
      setCmBusy(false)
    }
  }
  async function runPickAgentFile() {
    setAgentErr("")
    // openFilePicker 返回 { token, files }(授权注册表);preview 经 token 读(codex H1/M2)
    const picked = await window.api.openFilePicker({ title: t("alpha.ext.importAgentPick"), extensions: ["md"] })
    if (!picked || !picked.files?.length) return
    setAgentBusy(true)
    try {
      const r = await extIpc.importAgentPreview(picked.token, picked.files[0].path)
      if (!r.ok) {
        setAgentErr(extensionError(r.reason, "alpha.ext.error.previewAgent"))
        return
      }
      setAgentPreview(r)
    } finally {
      setAgentBusy(false)
    }
  }
  async function runConfirmAgentImport() {
    const pv = agentPreview()
    if (!pv || agentBusy()) return
    setAgentBusy(true)
    try {
      const r = await extIpc.importAgentConfirm(pv.previewId)
      if (!r.ok) {
        setAgentErr(extensionError(r.reason, "alpha.ext.error.importAgent"))
        return
      }
      setAgentPreview(null)
      await ext.requestEngineReload("imported agent")
      void ext.reloadAgents()
      flash(t("alpha.ext.importAgentDone", { name: pv.name }), "success")
    } finally {
      setAgentBusy(false)
    }
  }

  // Dedicated Portal host inside #root (mirrors alpha-sidebar.tsx), kept out of <body> so it stays
  // inside opencode's drag-region system and keeps position:fixed working.
  const host = document.createElement("div")
  host.setAttribute("data-alpha-ext-hub", "")
  document.getElementById("root")?.appendChild(host)
  onCleanup(() => host.remove())

  // Esc pops ONE level per press (REQ-019 T2): confirm dialog (owned by alpha Dialog) → detail →
  // hub. While the confirm dialog is up, Dialog's own listener closes it — the hub must not also act.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !props.open()) return
    // #348(review Major 1):授权框在场(独立宿主)或驱动/重驱进行中,hub 层绝不消费 Esc ——
    // 否则外层先关掉整个 hub,Dialog 的 dismissible=false 拦不住,IPC 会在隐藏状态下提交。
    if (confirming() || authz() || confirmBusy() || authzBusy()) return
    if (detail()) {
      setDetail(null)
      return
    }
    props.onClose()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  // Agent search: match name/description against the shared query.
  const matchesAgent = (a: { name: string; description?: string }) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q)
  }

  const matches = (e: CatalogEntry) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return `${e.displayName} ${e.name} ${e.description}`.toLowerCase().includes(q)
  }
  const matchesPackage = (view: CatalogPackageViewV1) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return `${view.presentation.displayName} ${view.catalogId} ${view.presentation.description} ${packageListingTextV1(view.listing, "developerName") ?? ""}`
      .toLowerCase()
      .includes(q)
  }
  // 公示阻断事实(main 派生已验公示 LKG + 随包基线;advisory 永远赢,§1)—— 每次打开刷新。
  // r1-1(Major):**不可判定 ≠ 空集** —— 加载中 / IPC 失败 / 公示不新鲜(fresh=false:冷启动、
  // 过期 LKG)时,renderer 无法证明条目未被公示阻断,推荐面必须保守(不建货架,诚实降级文案),
  // 与 main 闸「advisories 不可验即拒激活」同向 fail-closed。fetcher 自吞异常归一为不可判定态。
  const [advisoryFacts] = createResource(
    () => (props.open() ? "open" : null),
    () => extIpc.advisoryActive().catch((): { ids: string[]; fresh: boolean } => ({ ids: [], fresh: false })),
  )
  const advisoryBlocked = createMemo(() => new Set(advisoryFacts()?.ids ?? []))
  // REQ-135:the signed snapshot remains byte-honest for installed-item identity, while every surface
  // that can lead to installation consumes this installable view, including verified advisory blocks.
  const installableEntries = createMemo(() => installableCatalogEntries(catalog().entries, advisoryBlocked()))
  const installablePackages = createMemo(() =>
    installableCatalogPackages(catalog().packages ?? [], catalog().entries, advisoryBlocked()),
  )
  // REQ-235:root 档案为 cloud@1 的签名包(main 投影了表单描述)与 legacy 云条目同列在「云能力」分区。
  const cloudPackages = createMemo(() => installablePackages().filter((view) => view.cloud))
  const byType = (type: CatalogEntry["type"]) => installableEntries().filter((e) => e.type === type)
  // Full-catalog lookup is intentional: an installed retired connector still needs honest name,
  // provenance, and retirement guidance until boot teardown has completed.
  const byId = (id: string) => catalog().entries.find((e) => e.id === id)

  // REQ-079 curation:引擎原生内置(build/plan/general/…)不进浏览面 —— 它们在助手页「系统」分段的内置治理面板里。
  const ownAgents = createMemo(() => ext.store.agents.filter((a) => !a.native))
  const searching = () => query().trim().length > 0

  // ── #397 PR-B:策展视图(解码一次/目录;fail-closed —— invalid 与未策展同呈现)────────────────
  const curationById = createMemo(() => curationMapOf(catalog()))
  const statusOf = (id: string): CurationStatus => curationOf(curationById(), id)
  // 复审期限比较的时钟:每次打开 hub 取一次(合同:消费端时钟仅用于此比较)。
  const nowIso = createMemo(() => (props.open(), new Date().toISOString()))
  // `#1594`:可添加的 = 目录里还没装的(已装的在本页顶部「已安装」组);出厂内置技能在技能页「系统」分段。
  // 每组内已分级的排前(批准稿:精选排前);未分级的照样可装,装上默认关闭(行为在安装层,不在这里)。
  const browsable = (type: CatalogEntry["type"]) => {
    const items = byType(type).filter(
      (e) => matches(e) && !ext.isInstalled(e) && !(type === "skill" && ext.factorySkills().includes(e.name)),
    )
    const split = splitBrowse(items, curationById())
    return [...split.graded, ...split.ungraded]
  }
  // 按目录 `category` 分组(固定序);插件目录今天 0 条,有了也和连接器同组。
  const groupByCategory = (items: CatalogEntry[]) => {
    const map = new Map<string, CatalogEntry[]>()
    for (const e of items) {
      const k = (CAT_ORDER as readonly string[]).includes(e.category) ? e.category : "other"
      map.set(k, [...(map.get(k) ?? []), e])
    }
    return CAT_ORDER.filter((c) => map.has(c)).map((c) => ({ cat: c as string, items: map.get(c)! }))
  }
  const connectorGroups = createMemo(() => groupByCategory([...browsable("mcp"), ...browsable("plugin")]))
  const skillGroups = createMemo(() => groupByCategory(browsable("skill")))
  const browsablePackages = createMemo(() => installablePackages().filter((view) => !view.cloud && matchesPackage(view)))
  const browsableCloud = createMemo(() => browsable("cloud"))
  const browsableCloudPackages = createMemo(() => cloudPackages().filter(matchesPackage))

  // 已安装 = 全类型统一视图(REQ-018 T6):receipts(skill/agent/plugin/mcp)⨝ SDK 的 MCP 实时
  // 状态(connected/error)。live-but-unrecorded 的 MCP(手动加/迁移前)也并入,合成最小 receipt
  // 以支持卸载。MCP 有开关(connected 真相取 SDK);fs/plugin 只有卸载。
  const installedAll = createMemo((): ManageRow[] => {
    const mcpByName = new Map(catalog().entries.filter((e) => e.type === "mcp").map((e) => [e.name, e] as const))
    const rows: ManageRow[] = []
    const seenMcp = new Set<string>()
    for (const r of ext.store.receipts) {
      const entry = byId(r.id) ?? (r.type === "mcp" ? mcpByName.get(r.name) : undefined)
      if (r.type === "mcp") seenMcp.add(r.name)
      rows.push({
        key: `${r.type}:${r.name}`,
        type: r.type,
        name: r.name,
        displayName: entry?.displayName ?? r.name,
        source: entry?.source,
        version: r.version,
        receipt: r,
        entry,
        mcp: r.type === "mcp" ? sdkMcpStatusForReceipt(r, ext.store.mcp) : undefined,
      })
    }
    // live MCP the SDK knows but we have no receipt for (manual / pre-migration) — allow uninstall.
    // `#1594`:平台云连接器在连接器页有自己的一行(状态、登录、去授权都在那一行),不再重复成一条已装行。
    for (const s of Object.values(ext.store.mcp)) {
      if (s === cloudLive() || seenMcp.has(s.name) || !nameOnlyLiveMcpIsUnambiguousGlobal(s.name, ext.store.projectReceipts))
        continue
      const entry = mcpByName.get(s.name)
      rows.push({
        key: `mcp:${s.name}`,
        type: "mcp",
        name: s.name,
        displayName: entry?.displayName ?? s.name,
        source: entry?.source,
        receipt: { id: entry?.id ?? `user:${s.name}`, name: s.name, type: "mcp", scope: "global", installedAt: "", origin: "created" },
        entry,
        mcp: s,
      })
    }
    // REQ-099/136 项目账本行(scope=project:导入/收编与合规 MCP 安装)。无 live MCP join ——
    // project MCP 只消费 main 的 D-scoped verdict;key 加 scope 后缀,AC5 同名并存不撞。
    for (const r of ext.store.projectReceipts) {
      const entry = byId(r.id)
      rows.push({
        key: `${r.type}:${r.name}:project`,
        type: r.type,
        name: r.name,
        displayName: entry?.displayName ?? r.name,
        source: entry?.source,
        version: r.version,
        receipt: r,
        entry,
      })
    }
    return rows
  })

  // REQ-103(#195,AC5)已安装按 scope 分组:全局 / 本项目;同名可并存,各自独立操作(receipt.scope 即真源;
  // project 行仅当传入项目目录后才出现)。`#1594`:分到所属那一页的「已安装」组,并吃本页搜索。
  const installedFor = (page: HubSection) => {
    const q = query().trim().toLowerCase()
    const rows = installedAll().filter(
      (row) =>
        pageOfType(row.type) === page &&
        (!q || `${row.displayName} ${row.name} ${row.entry?.description ?? ""}`.toLowerCase().includes(q)),
    )
    return {
      global: rows.filter((row) => row.receipt.scope !== "project"),
      project: rows.filter((row) => row.receipt.scope === "project"),
    }
  }

  // 有更新(REQ-019 T1:已安装 tab 角标 + 列表顶部分组;T5 接更新动作):receipt 记录的 catalog
  // 快照版本落后于当前 catalog,且条目仍在目录中。created/imported 无版本概念,不参与。
  // REQ-105(#197):归档连接器(上游不再维护)禁自动更新 —— 不进角标/更新组;处置只剩
  // 禁用/卸载(advisory 分组如实呈现,不静默删除)。
  const updatable = createMemo(() =>
    ext.store.receipts.filter(
      // REQ-032:条目级更新判定(receipt.version vs entry.version;X7:非 catalog 来源不参与角标)
      // #307/REQ-136:updatable 只扫 global receipts;project 行没有 name-only 受管更新入口。
      (r) =>
        r.scope !== "project" &&
        r.origin !== "imported" &&
        r.origin !== "created" &&
        !officeAdvisoryFor({ id: r.id, name: r.name }) &&
        !retiredCommunityOfficeFor({ id: r.id, name: r.name }) &&
        !!r.version &&
        !!byId(r.id) &&
        versionLess(r.version, entryVersion(byId(r.id))),
    ),
  )

  // B11:收编进全局 pushToast(一处定义,各处复用)—— toast 只报成功,失败走行内。
  const flash = (msg: string, kind: "info" | "success" | "error" = "info") => pushToast({ kind, title: msg })
  const comingSoon = () => flash(t("alpha.ext.comingSoon"))

  // ── `#733`(REQ-130):`needs_auth` 的用户可见补救入口 ───────────────────────────────────
  //
  // 引擎的 MCP 状态是**五臂**判别联合,而此前 renderer 只认 connected / disabled ——
  // `needs_auth` 被折成「未连接」,用户看到一行灰字、**没有任何可点的东西**。
  // 这里补的不是文案,是一个动作:调引擎现成的 `POST /mcp/:name/auth/authenticate`
  //(开系统浏览器 + 等本地回调,一步到位)。授权流的每一步都在引擎侧,renderer 不实现其中任何一步。
  //
  // 出口**只有这一个定义**,两个呈现点(已安装行 / 云连接器卡)共用它 —— 逐点各写一份的
  // 形态在本文件里已经栽过三次(`#765` 的 warning 呈现是同一个故事):枚举对新呈现点默认放行,
  // 而这里"放行"的具体后果是用户在那个入口下依然点不动。
  const [authBusy, setAuthBusy] = createSignal<string | null>(null)
  const McpNeedsAuthAction = (cp: { name: string }) => (
    <button
      class="alpha-ext-updbtn"
      data-mcp-authorize={cp.name}
      disabled={authBusy() === cp.name}
      onClick={(ev) => {
        ev.stopPropagation()
        if (authBusy()) return
        setAuthBusy(cp.name)
        void ext
          .authenticateMcp(cp.name)
          // 成败都如实说:`authenticateMcp` 已经在数据层复查过重读回来的状态,
          // 「HTTP 调通了」不算成功。
          .then((r) => flash(r.ok ? t("alpha.ext.mcpAuthDone") : t("alpha.ext.mcpAuthFailed"), r.ok ? "success" : "error"))
          .finally(() => setAuthBusy(null))
      }}
    >
      {authBusy() === cp.name ? t("alpha.ext.mcpAuthorizing") : t("alpha.ext.mcpAuthorize")}
    </button>
  )

  // REQ-019 T5:更新执行状态(busy = receipt id;失败行内呈现,不裸 toast)。
  const [updBusy, setUpdBusy] = createSignal<string | null>(null)
  const [updErr, setUpdErr] = createSignal<Record<string, string>>({})
  // #348(review Major 2):更新路径单飞 + 模态互斥 —— 任何进行中的更新/确认框/授权框在场时,
  // 单行更新与「全部更新」一律 no-op;批量循环遇到任何弹框(authorize / MCP 确认)立即停止。
  // 否则并发 setAuthz 互相覆盖 diff、单值 updBusy 被先完成者错误清空、双模态同屏。
  const [updFlight, setUpdFlight] = createSignal(false)
  const updateBlocked = () => updFlight() || !!confirming() || !!authz() || confirmBusy() || authzBusy()
  const runUpdateOne = async (r: InstallReceipt): Promise<"authz" | "mcp-confirm" | undefined> => {
    const target = byId(r.id)
    if (!target) return
    setUpdErr((prev) => ({ ...prev, [r.id]: "" }))
    // MCP:persistMcp 为覆盖写,静默重装会丢 {file:} 密钥引用 → 走确认框重装(密钥可重填)。
    if (target.type === "mcp") {
      openInstallConfirmation(target)
      return "mcp-confirm"
    }
    setUpdBusy(r.id)
    try {
      const res = await ext.updateEntry(target)
      // `#765`:具名 warning 不在这里呈现 —— `extIpc` 在 IPC 包装层已经呈现过。
      if (res.ok) flash(t("alpha.ext.updated"), "success")
      else if (isAuthzRequired(res)) {
        // #348:扩权 → 授权框(mode=update,场景化文案);调用方据返回值中止批量循环。
        setAuthz({ entry: target, mode: "update", host: "standalone", diffs: res.authorization })
        return "authz"
      } else setUpdErr((prev) => ({ ...prev, [r.id]: extensionError(res.reason, "alpha.ext.error.update") }))
    } finally {
      setUpdBusy(null)
    }
  }
  const runUpdate = async (r: InstallReceipt) => {
    if (updateBlocked()) return
    setUpdFlight(true)
    try {
      await runUpdateOne(r)
    } finally {
      setUpdFlight(false)
    }
  }
  /** #348:授权确认后的更新重驱(与 runUpdate 同反馈面;再次 authorize 返回最新 diff 原地刷新)。
   *  由 confirmAuthz 持 authzBusy 调用,天然被 updateBlocked 与其它入口互斥。 */
  const runUpdateRedrive = async (target: CatalogEntry, authorization: AuthorizationConfirmationWire): Promise<CapabilityDiffWire[] | null> => {
    setUpdBusy(target.id)
    try {
      const res = await ext.updateEntry(target, authorization)
      if (res.ok) {
        // `#765`:同 runUpdateOne —— warning 归 `extIpc`,这里只报「已更新」。
        flash(t("alpha.ext.updated"), "success")
        return null
      }
      if (isAuthzRequired(res)) return res.authorization
      setUpdErr((prev) => ({ ...prev, [target.id]: extensionError(res.reason, "alpha.ext.error.update") }))
      return null
    } finally {
      setUpdBusy(null)
    }
  }
  const runUpdateAll = async () => {
    // #348(Codex 裁决 D2 + review Major 2):遇任何弹框(authorize / MCP 确认)必须停 ——
    // 不能一边开着弹框一边继续更新其它条目;整个批量持 updFlight 单飞。
    // `#1594`:「全部更新」挂在每页「已安装」组上,只更新这一页的条目(与它显不显示同一判据)。
    if (updateBlocked()) return
    setUpdFlight(true)
    try {
      for (const r of updatable().filter((r) => pageOfType(r.type) === section()))
        if ((await runUpdateOne(r)) !== undefined) break
    } finally {
      setUpdFlight(false)
    }
  }

  const addMcpEntry = async (
    e: CatalogEntry,
    secrets?: Record<string, string>,
    skipCheck?: boolean, // onAdd 已做「检查中」阶段时跳过重复 which
    authorization?: AuthorizationConfirmationWire,
    scope: CatalogInstallScopeChoice = DEFAULT_CATALOG_INSTALL_SCOPE,
    selectedProjectDir?: string,
  ): Promise<ActionResult> => {
    if (!skipCheck) {
      const rc = await ext.checkRuntime(e)
      if (!rc.ok) return { ok: false, reason: "reason" in rc ? rc.reason : t("alpha.ext.runtimeMissing", { tool: rc.missing }) }
    }
    return ext.addMcp(e, undefined, secrets, authorization, scope, selectedProjectDir)
  }

  // Bundle = alpha-defined manifest: fan out to install each referenced entry by its own type
  // (ADR-014 §2). Required items count toward failure; optional ones don't.
  const installBundle = async (e: CatalogEntry, authorization?: AuthorizationConfirmationWire): Promise<ActionResult> => {
    // REQ-100 #311:bundle = 一次 main-owned 原子事务(required 全提交或全回滚),renderer 只发一次
    // 请求。归档连接器/不支持子项的跳过决策由 main planner 落 skipped(带审计);此处只呈现结果。
    // #348:一次展示、一次授权、一次 commit —— authorize 失败原样上抛给 onAdd 统一拦截。
    // `#810`:同 `runPackageAction` —— 经数据层出站,引擎重扫在那一层接一次。
    // 套件成员里有 skill / agent / plugin 时,不重扫 = 装完在下一条消息里仍然不存在。
    const r = await ext.installCatalogIntent({ catalogId: e.id, ...(authorization ? { authorization } : {}) })
    if (!r.ok) return r
    const okCount = r.installed?.length ?? 0
    const skippedCount = r.skipped?.length ?? 0
    if (skippedCount > 0) setErrFor(e.id, t("alpha.ext.bundlePartialFail", { ok: okCount, fail: skippedCount }))
    // `#810`:重扫没成功就**不许**说「已添加」——同一句成功行改说「要重载」。
    else if (r.reloadPending) flash(t("alpha.ext.metaItems", { count: okCount }) + " · " + t("alpha.ext.addedPendingReload"), "success")
    else flash(t("alpha.ext.metaItems", { count: okCount }) + " · " + t("alpha.ext.added"), "success")
    // 具名 warning 原样带出去(数据保真);**呈现**已由 `extIpc` 在上面那次调用里做完(`#765`)。
    return { ok: true, ...(r.reloadPending ? { reason: "reload-pending" } : {}), ...(r.warning ? { warning: r.warning } : {}) }
  }

  // T7(B11)+T9:失败一律行内(卡片错误行 / 详情页同款),toast 只报成功;安装阶段粗状态机
  // (MCP:检查中→安装中;其余:安装中)反映在按钮文案上。
  // #348:返回值 = stage="authorize" 时的逐 item diff(调用方开授权框;null = 已按 B11 反馈完毕)。
  // authorization = 授权确认后的重驱决定,原样进 install intent(引擎整集覆盖判定)。
  const onAdd = async (
    e: CatalogEntry,
    secrets?: Record<string, string>,
    authorization?: AuthorizationConfirmationWire,
    scope: CatalogInstallScopeChoice = DEFAULT_CATALOG_INSTALL_SCOPE,
    selectedProjectDir?: string,
  ): Promise<CapabilityDiffWire[] | null> => {
    setBusy(e.id)
    setErrFor(e.id, null)
    // authorize 拦截:diff 上抛给授权框;其余失败保持行内(B11)。
    const failOr = (res: ActionResult): CapabilityDiffWire[] | null => {
      if (isAuthzRequired(res)) return res.authorization
      setErrFor(e.id, extensionError(res.reason, "alpha.ext.error.install"))
      return null
    }
    // #395:第三方 fresh 安装默认关 —— 成功文案如实说「已安装但未启用」,不暗示立即可用
    // (分类与 main 落账同一 shared 真源;已装条目的重装/更新不改既有状态,不换文案)。
    // #397:有效 curation 的声明进同一分类器(default-enabled 核心 = 装完即用;session-grant/过期 = 关)。
    const willBeDisabled =
      !ext.isInstalled(e) &&
      initialDesiredState({
        origin: "catalog",
        source: e.source,
        kind: e.type,
        ...curationActivationFacts(statusOf(e.id), nowIso()),
      }) === "disabled"
    const addedFlash = (fallbackKey: "alpha.ext.added" | "alpha.ext.addedLive" | "alpha.ext.pluginRestart") =>
      flash(willBeDisabled ? t("alpha.ext.addedDisabled") : t(fallbackKey), "success")
    try {
      if (scope === "project" && e.type !== "mcp")
        return failOr({ ok: false, reason: "project-scope-mcp-only" })
      // `#765`:这里**不再**有 warning 呈现。`#698` 把它收成本函数的单点出口,但那只覆盖一个
      // 函数 —— 详情页装 package 走确认屏,压根不经过这里。现在呈现在 `extIpc`(IPC 包装层),
      // 对**任何**返回具名 warning 的调用默认生效,不必逐入口登记。
      if (e.type === "mcp") {
        setStageFor(e.id, "checking")
        const rc = await ext.checkRuntime(e)
        if (!rc.ok) {
          setErrFor(e.id, "reason" in rc ? t("alpha.ext.officeRuntimeMissing") : t("alpha.ext.runtimeMissing", { tool: rc.missing }))
          return null
        }
        setStageFor(e.id, "installing")
        const res = await addMcpEntry(e, secrets, true, authorization, scope, selectedProjectDir)
        if (!res.ok) {
          // hook 返回稳定 reason code,文案在这一层映射(hook 不持有 i18n)。
          if (res.reason === "connect-failed") {
            setErrFor(e.id, t("alpha.ext.mcpConnectFailed"))
            return null
          }
          if (res.reason?.startsWith("project-scope-")) {
            setErrFor(
              e.id,
              t(
                res.reason === "project-scope-missing-current-project" ||
                  res.reason === "project-scope-current-project-changed"
                  ? "alpha.ext.installScopeProjectLost"
                  : "alpha.ext.installScopeProjectUnavailable",
              ),
            )
            return null
          }
          return failOr(res)
        }
        if (res.projectMcpState) {
          const state = projectMcpStatusView(res.projectMcpState)
          flash(t(state.textKey), state.connected ? "success" : "info")
          return null
        }
        // #395(Codex r8 M4):第三方 MCP 默认关 —— 装成功但未激活连接,如实提示「已装未启用」。
        if (res.reason === "installed-disabled") flash(t("alpha.ext.installedDisabled"))
        // #696:main 侧引擎重载有上界(5s/5s/10s),超时落 reload-pending —— 如实说"要重启",
        // 不要报"已添加"。skill/agent 分支早有这条映射,catalog MCP 此前走不到该状态。
        else if (res.reason === "reload-pending") flash(t("alpha.ext.addedPendingReload"))
        else if (res.reason === "slow") flash(t("alpha.ext.installSlow"))
        else addedFlash("alpha.ext.added")
      } else if (e.type === "skill") {
        setStageFor(e.id, "installing")
        const res = await ext.installSkill(e, authorization)
        if (!res.ok) return failOr(res)
        // REQ-234 `#1529`:重载交给 ext 调度器(等会话空闲),「可以使用」只在该行显示可用之后才成立 —— 这里只说已添加。
        if (res.reason === "reload-pending") flash(t("alpha.ext.addedPendingReload"))
        else addedFlash("alpha.ext.added")
      } else if (e.type === "agent") {
        setStageFor(e.id, "installing")
        const res = await ext.installAgentEntry(e, authorization)
        if (!res.ok) return failOr(res)
        if (res.reason === "reload-pending") flash(t("alpha.ext.addedPendingReload"))
        else addedFlash("alpha.ext.added")
      } else if (e.type === "plugin") {
        setStageFor(e.id, "installing")
        const res = await ext.installPlugin(e, authorization)
        if (!res.ok) return failOr(res)
        addedFlash("alpha.ext.pluginRestart")
      } else if (e.type === "bundle") {
        setStageFor(e.id, "installing")
        const res = await installBundle(e, authorization)
        if (!res.ok) return failOr(res)
      } else if (e.type === "cloud") {
        // REQ-020 T4:「启用」= receipts-only(账本可用列表);门控在按钮层(!cloudReady 禁用)。
        setStageFor(e.id, "installing")
        const res = await ext.enableCloud(e, authorization)
        if (!res.ok) return failOr(res)
        flash(t("alpha.ext.cloudEnabled"), "success")
      }
      return null
    } finally {
      setBusy(null)
      setStageFor(e.id, null)
    }
  }

  // #348:授权框动作与包确认屏(closeAuthz / cancelAuthz / confirmAuthz / closePackageAuthz / confirmPackageAuthz)在 install-confirm.tsx。
  /** skill 直装(无确认框)路径:authorize → 独立授权框。 */
  const addDirect = async (e: CatalogEntry) => {
    const diffs = await onAdd(e)
    if (diffs) setAuthz({ entry: e, mode: "install", host: "standalone", diffs })
  }
  // 「添加」三档分流(2026-07-04 拍板,Q1/Q2):
  //   skill  → 直装(零配置零密钥,免确认框);
  //   plugin → 详情页先行(风险最高:运行于引擎进程 + npm 下载),页内安装再过风险确认框;
  //   mcp / bundle → 确认框(密钥采集 / 组合清单)。
  const stageInstall = (e: CatalogEntry) => {
    if (retiredCommunityOfficeFor({ id: e.id, name: e.name })) {
      setErrFor(e.id, t("alpha.ext.retiredCommunityNoInstallHint"))
      return
    }
    if (e.type === "skill") return void addDirect(e)
    // plugin(引擎进程内运行)/ agent(带权限档)/ cloud(数据出境,上行明细在详情页)=
    // 详情页先行档:先看清楚再启用。
    if (e.type === "plugin" || e.type === "agent" || e.type === "cloud") return openEntryDetail(e)
    openInstallConfirmation(e)
  }
  // Install action coming FROM the detail page: plugin now goes to its risk confirm dialog
  // (the user has just seen the hooks/risk sections); skill stays direct; the rest confirm.
  const stageInstallFromDetail = (e: CatalogEntry) => {
    if (retiredCommunityOfficeFor({ id: e.id, name: e.name })) {
      setErrFor(e.id, t("alpha.ext.retiredCommunityNoInstallHint"))
      return
    }
    // 用户已在详情页看过内容/权限:skill/agent 直装;cloud 直启用(上行明细刚看过);
    // plugin 仍过风险确认框;MCP/套件过确认框。
    if (e.type === "skill" || e.type === "agent" || e.type === "cloud") return void addDirect(e)
    openInstallConfirmation(e)
  }

  const onUninstall = async (receipt: InstallReceipt) => {
    const rowKey = `${receipt.type}:${receipt.name}`
    setRowRefusal((prev) => {
      const next = { ...prev }
      delete next[rowKey]
      return next
    })
    const res = await ext.uninstall(receipt)
    // `#784` 第 8 跳:这一条属于某个扩展包 ⇒ main 的 `directUninstallVerdict` 会在**删任何实物
    // 之前**响亮拒绝。那条拒绝的原文是给开发者看的英文(`… is owned by bundle:… — uninstall the
    // package instead`),用户读不了也做不出动作,所以行上说人话并给出**正确的下一步**。
    // 判据是「main 拒了 **且** 这一条在某个包图里」——**不解析 reason 的文字**,
    // 那样一改措辞这条分支就静默失效了。
    const owner = packageOwnerOf().get(rowKey)
    if (!res.ok && owner) {
      setRowRefusal((prev) => ({ ...prev, [rowKey]: owner.packageId }))
      flash(t("alpha.ext.componentOwnedByPackage", { pack: owner.label }), "error")
      return
    }
    flash(
      res.ok
        ? res.reason === "reload-pending"
          ? t("alpha.ext.statePendingReload")
          : t("alpha.ext.removed")
        : extensionError(res.reason, "alpha.ext.error.remove"),
      res.ok ? (res.reason === "reload-pending" ? "info" : "success") : "error",
    )
    if (res.ok) await refetchPackages()
    // `#706` 的「它还属于某个扩展包 —— 只移除了你的独立安装,文件保留」正是走这条 warning;
    // `#765` 之后它由 `extIpc` 在 uninstallV2 返回时呈现,这里不再重复(重复会出两条同样的 toast)。
  }

  // T3:开 hub 时扫描旧 XDG 根,匹配 catalog(只迁 alpha 自己装的,不碰用户自建内容,ADR-019 §4)。
  // REQ-044:名字匹配只定位候选;main 侧 provenance 终审(skill=与打包资产逐字节比对,mcp/plugin=
  // catalog 形状比对)放行才列入 —— 同名用户自建被排除(fail-closed),排除原因见 main.log
  // [req044-provenance]。此前名字命中即候选,「迁移」会用 catalog 版覆盖并删除用户自建旧位。
  const provenanceRequest = (e: CatalogEntry): ProvenanceRequest | null => {
    if (e.type === "skill")
      return { type: "skill", name: e.name, builtinAssetKey: e.installSpec?.kind === "skill" ? e.installSpec.builtinAssetKey : undefined }
    if (e.type === "mcp" && e.installSpec?.kind === "mcp") {
      const s = e.installSpec
      return {
        type: "mcp",
        name: e.name,
        spec: {
          mcpType: s.mcpType,
          command: s.command,
          mirrorCommand: s.mirrorCommand,
          url: s.url,
          requiredEnvVars: s.requiredEnvVars,
          headerNames: Object.keys(s.headersTemplate ?? {}),
        },
      }
    }
    if (e.type === "plugin" && e.installSpec?.kind === "plugin") return { type: "plugin", name: e.name, package: e.installSpec.package }
    return null
  }
  const scanMigration = async () => {
    try {
      const { enabled, inventory } = await extIpc.migrateScan()
      if (!enabled) return setMigrateCandidates([])
      const skillNames = new Set(inventory.skills)
      const mcpNames = new Set(inventory.mcp.map((m) => m.name))
      const pluginBases = new Set(inventory.plugins.map((p) => p.split("@")[0]))
      const named = installableEntries().filter((e) => {
        if (e.type === "skill") return skillNames.has(e.name)
        if (e.type === "mcp") return mcpNames.has(e.name)
        if (e.type === "plugin" && e.installSpec?.kind === "plugin") return pluginBases.has(e.installSpec.package.split("@")[0])
        return false
      })
      const requests = named.map(provenanceRequest).filter((r): r is ProvenanceRequest => r !== null)
      const verdicts = requests.length ? await extIpc.migrateVerify(requests) : []
      const passed = new Set(verdicts.filter((v) => v.verified).map((v) => `${v.type}:${v.name}`))
      setMigrateCandidates(named.filter((e) => passed.has(`${e.type}:${e.name}`)))
    } catch {
      setMigrateCandidates([])
    }
  }
  createEffect(() => {
    if (props.open()) void scanMigration()
  })

  // Migrate each candidate: reinstall into the current-environment root via the existing installer (pins MCP version from
  // catalog + moves inline secrets to the {file:} channel), then remove the legacy copy.
  const runMigration = async () => {
    setMigrating(true)
    let ok = 0
    let fail = 0
    try {
      for (const e of migrateCandidates()) {
        let installed: { ok: boolean } = { ok: false }
        if (e.type === "skill") installed = await ext.installSkill(e)
        else if (e.type === "mcp") installed = await addMcpEntry(e)
        else if (e.type === "plugin") installed = await ext.installPlugin(e)
        if (!installed.ok) {
          fail++
          continue
        }
        const legacyName = e.type === "plugin" && e.installSpec?.kind === "plugin" ? e.installSpec.package : e.name
        await extIpc.removeLegacy(e.type as "skill" | "mcp" | "plugin", legacyName)
        ok++
      }
      flash(fail ? `${t("alpha.ext.migrated", { count: ok })} · ${t("alpha.ext.migrateFailedCount", { count: fail })}` : t("alpha.ext.migrated", { count: ok }), fail ? "error" : "success")
      await scanMigration()
    } finally {
      setMigrating(false)
    }
  }

  // ── reusable pieces ─────────────────────────────────────────────────────────────────────────
  const SecRow = (cp: { label: string; count?: number; warn?: boolean; actionLabel?: string; onAction?: () => void }) => (
    <div class="alpha-ext-secrow">
      <span class="alpha-ext-overline" data-warn={cp.warn ? "" : undefined}>
        {cp.label}
        <Show when={cp.count !== undefined}>
          {" · "}
          <b>{cp.count}</b>
        </Show>
      </span>
      <Show when={cp.actionLabel && cp.onAction}>
        <button class="alpha-ext-link" onClick={() => cp.onAction!()}>
          {cp.actionLabel}
        </button>
      </Show>
    </div>
  )

  // `#1594` 列表行(批准稿 `#hub-connectors`):图标 + 名称 + 一行描述 + 一个动作,双列排布。来源、版本、
  // 兼容、运行位置都只在详情页;点行进详情页。行上的动作仍走既有的分流(stageInstall)。
  const EntryRow = (cp: { e: CatalogEntry; dim?: boolean }) => {
    const e = cp.e
    const ic = iconFor(e)
    const isBusy = () => busy() === e.id
    // #397/REQ-135:archived 与 retired 都不可新装,文案各自说;已分级的动作是主按钮,未分级是次按钮(装上默认关闭)。
    const cst = createMemo(() => statusOf(e.id))
    const archivedNow = () => isArchived(cst())
    const retiredNow = () => retiredCommunityOfficeFor({ id: e.id, name: e.name }) !== undefined
    return (
      <div
        class="alpha-ext-kit alpha-ext-card"
        data-clickable=""
        data-entry={e.id}
        data-dim={cp.dim ? "" : undefined}
        onClick={() => openEntryDetail(e)}
      >
        <span class="alpha-ext-kit-ic" style={{ background: ic.color }}>
          {ic.glyph}
        </span>
        <div class="alpha-ext-kit-body">
          <div class="alpha-ext-kit-ttl">
            <b title={e.name}>{e.displayName}</b>
          </div>
          <div class="alpha-ext-kit-desc">{catalogDescription(e)}</div>
          {/* B11:失败行内,不裸 toast */}
          <Show when={cardErr()[e.id]}>
            <p class="alpha-ext-card-err">{cardErr()[e.id]}</p>
          </Show>
        </div>
        <Show
          when={!archivedNow() && !retiredNow()}
          fallback={
            <button
              class="alpha-ext-add"
              disabled
              title={t(retiredNow() ? "alpha.ext.retiredCommunityNoInstallHint" : "alpha.ext.archivedNoInstallHint")}
              onClick={(ev) => ev.stopPropagation()}
            >
              {t(retiredNow() ? "alpha.ext.retiredCommunityNoInstall" : "alpha.ext.archivedNoInstall")}
            </button>
          }
        >
          <button
            class="alpha-ext-add"
            data-variant={cst().kind === "curated" ? "primary" : "ghost"}
            disabled={isBusy()}
            onClick={(ev) => {
              ev.stopPropagation()
              stageInstall(e)
            }}
          >
            {stage()[e.id] === "checking"
              ? t("alpha.ext.stageChecking")
              : stage()[e.id] === "installing" || isBusy()
                ? t("alpha.ext.stageInstalling")
                : e.type === "cloud"
                  ? t("alpha.ext.enableCloud")
                  : t("alpha.ext.add")}
          </button>
        </Show>
      </div>
    )
  }

  const Grid = (cp: { items: CatalogEntry[]; group: string }) => (
    <div class="alpha-ext-grid" data-group={cp.group}>
      <For each={cp.items}>{(e) => <EntryRow e={e} />}</For>
    </div>
  )

  // 签名扩展包的一行。`#1594` AC6:需要令牌或本机文件时,描述换成缺什么(「需要 GitHub 令牌」),动作是「设置」,
  // 点下去走既有的 runPackageAction —— 打开的就是原来那个填令牌 / 填数据库位置的确认屏。
  const PackageRow = (cp: { view: CatalogPackageViewV1; dim?: boolean }) => {
    const view = () => currentPackageView(cp.view)
    const needsSetup = () => view().action.kind === "resolve-prerequisite"
    return (
      <div
        class="alpha-ext-kit"
        data-clickable=""
        data-package-card={view().catalogId}
        data-prerequisite={view().prerequisites.status}
        data-dim={cp.dim ? "" : undefined}
        onClick={() => openPackageDetail(view())}
      >
        {/* `#1287`:发布者签名的 logo 与品牌色;两者都缺就是首字母 + 主题色。 */}
        <span
          class="alpha-ext-kit-ic"
          style={{ background: packageListingTextV1(view().listing, "brandColor") ?? "var(--a-accent-solid)" }}
        >
          <PackageLogo listing={view().listing} fallback={view().presentation.displayName} />
        </span>
        <div class="alpha-ext-kit-body">
          <div class="alpha-ext-kit-ttl">
            <b title={view().catalogId}>{view().presentation.displayName}</b>
          </div>
          <div class="alpha-ext-kit-desc" data-package-need={needsSetup() ? "" : undefined}>
            {needsSetup() ? prerequisiteNeedText(view()) : view().presentation.description}
          </div>
          <Show when={cardErr()[view().catalogId]}>
            <p class="alpha-ext-card-err" role="alert">{cardErr()[view().catalogId]}</p>
          </Show>
        </div>
        <button
          class="alpha-ext-add"
          data-variant={needsSetup() ? "ghost" : "primary"}
          disabled={!view().action.enabled || busy() === view().catalogId}
          onClick={(event) => {
            event.stopPropagation()
            void runPackageAction(view())
          }}
        >
          {needsSetup() ? t("alpha.ext.rowSetup") : t("alpha.ext.add")}
        </button>
      </div>
    )
  }

  // 自己在对话里建的助手(没有安装记录)。来源说明只在详情页(批准稿 `#hub-agents`)。
  const AgentRow = (cp: { a: HubAgent }) => {
    const a = cp.a
    const ic = iconForRow(undefined, "agent", a.name)
    return (
      <div class="alpha-ext-kit" data-clickable="" data-own-agent={a.name} onClick={() => openAgentDetail(a)}>
        <span class="alpha-ext-kit-ic" style={{ background: ic.color }}>
          {ic.glyph}
        </span>
        <div class="alpha-ext-kit-body">
          <div class="alpha-ext-kit-ttl">
            <b title={a.name}>{a.name}</b>
          </div>
          <div class="alpha-ext-kit-desc">{a.description ?? t("alpha.ext.agentNoDesc")}</div>
        </div>
        <MoreMenu id={`agent:${a.name}`} items={[{ key: "settings", label: t("alpha.ext.rowSetup"), onSelect: () => openAgentDetail(a) }]} />
      </div>
    )
  }

  // 出厂内置技能(skill-creator 等):技能页「系统」分段。有目录条目的可进详情页。
  const FactorySkillRow = (cp: { name: string }) => {
    const entry = () => installableEntries().find((e) => e.type === "skill" && e.name === cp.name)
    const ic = iconForRow(entry(), "skill", cp.name)
    return (
      <div
        class="alpha-ext-kit"
        data-clickable={entry() ? "" : undefined}
        data-factory-skill={cp.name}
        onClick={() => entry() && openEntryDetail(entry()!)}
      >
        <span class="alpha-ext-kit-ic" style={{ background: ic.color }}>
          {ic.glyph}
        </span>
        <div class="alpha-ext-kit-body">
          <div class="alpha-ext-kit-ttl">
            <b title={cp.name}>{entry()?.displayName ?? cp.name}</b>
          </div>
          <div class="alpha-ext-kit-desc">{entry() ? catalogDescription(entry()!) : t("alpha.ext.factoryBuiltin")}</div>
        </div>
        <Show when={entry()}>
          {(e) => <MoreMenu id={`factory:${cp.name}`} items={[{ key: "settings", label: t("alpha.ext.rowSetup"), onSelect: () => openEntryDetail(e()) }]} />}
        </Show>
      </div>
    )
  }

  const EmptyState = (cp: { title: string; sub?: string; action?: JSX.Element }) => (
    <div class="alpha-ext-empty-state">
      <span class="alpha-ext-empty-ic">
        <svg class="alpha-ic" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ width: "24px", height: "24px" }}>
          <rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.6" />
          <path d="M8 7V5a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="1.6" />
        </svg>
      </span>
      <b>{cp.title}</b>
      <Show when={cp.sub}>
        <p>{cp.sub}</p>
      </Show>
      {cp.action}
    </div>
  )

  // ── REQ-128 Phase 3 `#784`:已装扩展包 ─────────────────────────────────────────────────────
  //
  // `#1594`:每个包是连接器页「已安装」组里的一行,「…」里是「移除此扩展包」(整包移除的入口,本地导入的包
  // 没有目录详情页可去,这里是唯一的移除入口)。包内技能各自是技能页「已安装」组里的一行,开关走既有的
  // `runStateToggle` —— 与平铺行同一条通道、同一个账本、同一次重载请求。
  const orderedPackages = createMemo(() => {
    const s = installedPackages()
    if (!s || !s.ok) return []
    const q = query().trim().toLowerCase()
    const top = highlightPackage()
    // 刚装完的排最前(裁决 B 之下,不这么做用户按完确认「什么都看不到」)。
    return s.packages
      .filter((pack) => !q || packLabel(pack).toLowerCase().includes(q))
      .sort((a, b) => (a.packageId === top ? -1 : b.packageId === top ? 1 : packLabel(a) < packLabel(b) ? -1 : 1))
  })
  const InstalledPackageRow = (cp: { pack: ReturnType<typeof orderedPackages>[number] }) => {
    const pack = cp.pack
    const enabledCount = () => pack.components.filter((c) => c.desiredState === "enabled").length
    const ic = iconForRow(undefined, "bundle", packLabel(pack))
    return (
      // 来源**只从 child record 的 `origin` 读**(基线 §8 纪律 2),行上不显示,留作身份属性。
      <div class="alpha-ext-kit" data-installed-package={pack.packageId} data-package-origin={pack.origin ?? ""}>
        <span class="alpha-ext-kit-ic" style={{ background: ic.color }}>
          {ic.glyph}
        </span>
        <div class="alpha-ext-kit-body">
          <div class="alpha-ext-kit-ttl">
            <b data-package-label={pack.packageId}>{packLabel(pack)}</b>
          </div>
          {/* 裁决 B 的必然连带:装完默认全关 ⇒ 不说下一步,用户按完确认拿不到任何东西。有任意一个开了就换成计数。 */}
          <div class="alpha-ext-kit-desc">
            {enabledCount() === 0
              ? t("alpha.ext.packageAllOffRow", { count: String(pack.components.length) })
              : `${t("alpha.ext.packageSkillCount", { count: String(pack.components.length) })} · ${t("alpha.ext.packageSomeEnabled", { count: String(enabledCount()) })}`}
          </div>
          <Show when={packErr()[pack.packageId]}>
            {(error) => (
              <p class="alpha-ext-card-err" data-package-error={pack.packageId} role="alert">
                {error()}
              </p>
            )}
          </Show>
        </div>
        <MoreMenu
          id={`package:${pack.packageId}`}
          items={[
            {
              key: "remove-package",
              label: packBusy() === pack.packageId ? t("alpha.ext.packageRemoving") : t("alpha.ext.packageActionUninstall"),
              danger: true,
              disabled: packBusy() === pack.packageId,
              onSelect: () => void runRemovePackage(pack.packageId),
            },
          ]}
        />
      </div>
    )
  }
  // 整包移除的结果与「读不出」—— 区块级,**故意放在包行之外**:行会随着包图消失,解释不能跟着走;
  // 「读不出」与「没装」**永远分开**,折叠成一句「暂无扩展包」会让用户以为东西丢了而去重装。
  const PackageFeedback = () => (
    <>
      <Show when={packRemoval()}>
        {(removal) => (
          <div class="alpha-ext-verify-note" data-package-removal={removal().packageId} role="status">
            <b>{t("alpha.ext.packageRemovedWithRetained", { pack: removal().label, count: String(removal().retained.length) })}</b>
            <ul class="alpha-ext-package-retained">
              <For each={removal().retained}>
                {(entry) => (
                  <li data-package-retained={`${entry.kind}:${entry.name}`} data-retained-reason={entry.reasonCode ?? ""}>
                    <code>{entry.name}</code>
                    <span>{entry.reasonCode ? (t(packageRetainedReasonKey(entry.reasonCode) as never) as string) : ""}</span>
                  </li>
                )}
              </For>
            </ul>
            <button class="alpha-ext-updbtn" data-dismiss-removal="" onClick={() => setPackRemoval(null)}>
              {t("alpha.ext.gotIt")}
            </button>
          </div>
        )}
      </Show>
      <Show when={packagesUnreadable()}>
        <div class="alpha-ext-verify-note" data-packages-unreadable="" role="alert">
          <b>{t("alpha.ext.packagesUnreadableTitle")}</b>
          <p>{(installedPackages() as { reason: string }).reason}</p>
          <button class="alpha-ext-updbtn" onClick={() => void refetchPackages()}>
            {t("alpha.ext.retry")}
          </button>
        </div>
      </Show>
    </>
  )

  // REQ-103(#195)→ `#1594` 已安装行:图标 + 名称 + 一行状态 + 一个动作。三态正交的事实(健康 = governance、
  // 启用 = 账本 desiredState、生效 = main 三档)仍各从原数据源读,只是合成一行、取最要紧的那一件说。
  // 没有要处理的事时描述照常,动作是「…」(停用 / 移除 / 设置);有要处理的事(去授权 / 开启 / 立即生效 /
  // 审查更新 / 会话开关)时那颗按钮就是动作 —— 停用、移除在详情页;进不了详情页的行(项目行、手动加的连接器、
  // 本地导入的技能)「…」照样留在旁边,移除入口一个不少。
  const InstalledRow = (cp: { row: ManageRow }) => {
    const row = cp.row
    const rowKey = `${row.type}:${row.name}`
    const ic = iconForRow(row.entry, row.type, row.name)
    const openRow = () => {
      if (row.entry) {
        openEntryDetail(row.entry)
        return
      }
      if (row.type === "agent") {
        const a = ext.store.agents.find((x) => x.name === row.name)
        if (a) openAgentDetail(a)
      }
    }
    // Codex r1 B1:project 行不下钻详情 —— 详情页的收据解析是 global 语义面(receipt memo 只查
    // global 账本),legacy 项目账本若存 catalog-id 记录,下钻后「卸载」会误落同 id 的 global 安装。
    // project 行的独立移除动作已完备,详情留给 global/目录语义。
    const clickable = () =>
      row.receipt.scope !== "project" &&
      (!!row.entry || (row.type === "agent" && ext.store.agents.some((x) => x.name === row.name)))
    // health 三态:governance 只读真源按 (id,scope) join。
    const gov = () => inventoryInstallRow(governance(), row.receipt.id, row.receipt.scope)
    const health = () => {
      const g = gov()
      return g ? healthPresentation(g.health) : undefined
    }
    // #395:启用真源 = governance activation(账本 desiredState 的读投影);无 governance 行
    // (live-unreceipted MCP 合成收据)按启用处理(其启停走 live 语义,见 toggleState)。
    const desiredOn = () => gov()?.activation !== "disabled"
    const stateBusy = createSignal(false)
    const toggleState = async () => {
      if (stateBusy[0]()) return // Codex r1 Minor 1:busy 门提前 —— 防双击并发。
      stateBusy[1](true)
      try {
        // 启停逻辑统一进 runStateToggle(Codex r9 B3:与详情页共用一条通道)。
        await runStateToggle({
          receipt: row.receipt,
          type: row.type,
          name: row.name,
          currentlyOn: desiredOn(),
          liveUnreceipted: row.receipt.installedAt === "",
          mcpConnected: !!row.mcp?.connected,
        })
      } finally {
        stateBusy[1](false)
      }
    }
    // #397 策展身份 → #408 PR-C:labs(session-grant)行的真实会话开关 —— 状态机真源 = main grant
    // 登记 + 本地连接结果(sessionViewFor);非 mcp 的 labs 行无引擎瞬态激活面,不给开关(假开关禁止)。
    const rowCst = createMemo(() => statusOf(row.receipt.id))
    const rowSessionGrant = () => isSessionGrant(rowCst())
    const rowSessionView = createMemo(() => sessionViewFor(row.receipt.id))
    const projectMcpView = createMemo(() =>
      row.type === "mcp" && row.receipt.scope === "project"
        ? projectMcpStatusView(row.receipt.projectMcpState)
        : undefined,
    )
    const activationText = () => {
      if (row.type !== "mcp") return desiredOn() ? t("alpha.ext.installed") : t("alpha.ext.notOn")
      return row.mcp?.connected ? t("alpha.ext.enabledLive") : t("alpha.ext.disabled")
    }
    const isUpdatable = () =>
      updatable().some((r) => r.id === row.receipt.id && r.name === row.name && r.scope === row.receipt.scope)
    // REQ-234 `#1529`:三档状态(main 对当前目录即时算出,agent 读同一份)。合成的 live-only 行没有账本身份 ⇒ 不显示。
    const hubState = createMemo(() => hubStateView(hubRowFor(ext.store.hubRows, row.receipt.id, row.receipt.scope)))
    const [reloadBusy, setReloadBusy] = createSignal(false)
    const reloadNow = async () => {
      if (reloadBusy()) return
      setReloadBusy(true)
      try {
        const ok = await ext.refreshEngine(row.receipt.scope === "project" ? projectDir() : undefined)
        if (!ok) flash(t("alpha.ext.hubReloadNowRefused"), "error")
      } finally {
        setReloadBusy(false)
      }
    }
    // #395:开关只给**有禁用生效面**的类型 —— mcp/agent(主权注入)、plugin(alpha.jsonc plugin[])、skill(允许集)。
    // Codex r12 Major3:command/bundle 无生效面,cloud 无本地运行面;project 收据只读(Codex r1 M2 + #307);
    // #397:session-grant 行不给持久开关(main 闸拒持久启用)。
    const hasToggle = () =>
      (row.type === "mcp" || row.type === "agent" || row.type === "plugin" || row.type === "skill") &&
      row.receipt.scope !== "project" &&
      !rowSessionGrant()
    const isOn = () => (row.type === "mcp" && row.receipt.installedAt === "" ? !!row.mcp?.connected : desiredOn())

    // 一行状态:取最要紧的那一件。
    const line = (): { text: string; err?: boolean; hub?: string; detail?: string } => {
      if (row.type === "mcp" && row.mcp?.error)
        return { text: row.mcp.repair === "reinstall-app" ? t("alpha.ext.officeRuntimeMissing") : row.mcp.error, err: true }
      // `#733`:`needs_auth` 不是「未连接」——它是一个用户能自己修好的状态。
      if (row.type === "mcp" && row.mcp?.needsAuth) return { text: t("alpha.ext.mcpNeedsAuth") }
      if (rowSessionGrant())
        return { text: row.type === "mcp" ? t(rowSessionView().textKey) : t("alpha.ext.sessionKindUnsupportedRow") }
      const hs = hubState()
      const hubText = hs ? (hs.reasonKey ? `${t(hs.textKey)} · ${t(hs.reasonKey)}` : t(hs.textKey)) : ""
      // #395:账本 disabled 的诚实呈现(未完成审核的扩展装上默认关闭)。`#1529`:停用也要一次重载才生效 ——
      // 还没生效时两件事一起说,「立即生效」照给。
      if (!desiredOn())
        return hs && hs.reloadNow
          ? { text: `${t("alpha.ext.notOn")} · ${hubText}`, hub: hs.state, detail: hs.detail }
          : { text: t("alpha.ext.notOn") }
      if (hs && hs.state !== "available") return { text: hubText, hub: hs.state, detail: hs.detail }
      const hp = health()
      if (hp && hp.tone === "warn") return { text: t(hp.textKey) }
      // `#1563`:还在后台启动(准备中)不是「已停用」。
      if (row.mcp?.pending) return { text: t("alpha.ext.hubReasonNotLoaded") }
      // REQ-105:上游归档(禁自动更新);REQ-135:已退役的社区 Office 连接器。
      if (officeAdvisoryFor({ id: row.receipt.id, name: row.name })) return { text: t("alpha.ext.advArchivedUnsupported") }
      if (retiredCommunityOfficeFor({ id: row.receipt.id, name: row.name })) return { text: t("alpha.ext.retiredCommunityChip") }
      if (row.entry) return { text: catalogDescription(row.entry), hub: hs?.state }
      return { text: hs ? t(hs.textKey) : activationText(), hub: hs?.state }
    }
    const attention = (): "auth" | "session" | "enable" | "reload" | "update" | undefined => {
      if (row.type === "mcp" && row.mcp?.needsAuth) return "auth"
      if (row.type === "mcp" && row.receipt.scope !== "project" && rowSessionGrant()) return "session"
      if (hubState()?.reloadNow) return "reload"
      if (hasToggle() && !isOn()) return "enable"
      if (isUpdatable()) return "update"
      return undefined
    }
    // 「开启」已经是行上的那颗按钮时,菜单里不再重复一遍(移除、设置照常在菜单里)。
    const menuItems = () => [
      ...(hasToggle() && attention() !== "enable"
        ? [{ key: isOn() ? "disable" : "enable", label: isOn() ? t("alpha.ext.turnOff") : t("alpha.ext.turnOn"), disabled: stateBusy[0](), onSelect: () => void toggleState() }]
        : []),
      { key: "remove", label: t("alpha.ext.remove"), danger: true, onSelect: () => void onUninstall(row.receipt) },
      ...(clickable() ? [{ key: "settings", label: t("alpha.ext.rowSetup"), onSelect: openRow }] : []),
    ]
    return (
      <div
        class="alpha-ext-kit"
        data-installed-row={rowKey}
        data-clickable={clickable() ? "" : undefined}
        onClick={() => clickable() && openRow()}
      >
        <span class="alpha-ext-kit-ic" style={{ background: ic.color }}>
          {ic.glyph}
        </span>
        <div class="alpha-ext-kit-body">
          <div class="alpha-ext-kit-ttl">
            <b title={row.name}>{row.displayName}</b>
          </div>
          {/* REQ-136:项目行的状态只消费 main 给的项目范围判定(name-only 的全局实时状态不许串进来)。 */}
          <Show
            when={projectMcpView()}
            fallback={
              <div class="alpha-ext-kit-desc" data-err={line().err ? "" : undefined} data-hub-state={line().hub} title={line().detail}>
                {line().text}
              </div>
            }
          >
            {(project) => (
              <div class="alpha-ext-kit-desc" data-project-mcp-state={project().state}>
                {t(project().textKey)}
              </div>
            )}
          </Show>
          <Show when={updErr()[row.receipt.id]}>
            <p class="alpha-ext-card-err">{updErr()[row.receipt.id]}</p>
          </Show>
          {/* `#784` 第 8 跳:单独移除被拒 ⇒ **明确拒绝 + 指向正确动作**(移除整个扩展包,在连接器页)。
              单独**停用**仍然合法,不能单独**移除**而已。 */}
          <Show when={rowRefusal()[rowKey]}>
            {(packageId) => (
              <div class="alpha-ext-man-refusal" data-row-refusal={rowKey} role="alert">
                <div class="alpha-ext-man-st" data-err="">
                  {t("alpha.ext.componentOwnedByPackage", { pack: packageOwnerOf().get(rowKey)?.label ?? packageId() })}
                </div>
                <button
                  class="alpha-ext-updbtn"
                  data-goto-package={packageId()}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setHighlightPackage(packageId())
                    gotoSection("connectors")
                  }}
                >
                  {t("alpha.ext.removeWholePackage")}
                </button>
              </div>
            )}
          </Show>
        </div>
        <Show when={attention()}>
          {(kind) => (
            <>
              {/* `#733`:MCP 走 OAuth 且当前没令牌 ⇒ 一颗能点的「去授权」,与状态「需要重新登录」是同一个事实的两半。 */}
              <Show when={kind() === "auth"}>
                <McpNeedsAuthAction name={row.name} />
              </Show>
              {/* #408 PR-C:labs mcp 行的会话开关 —— 开 = grant + 同 directory 热连,关 = 撤销 + 断连;会话结束自动归位。
                  home/new-session 无 instance 上下文 → 禁用 + 如实提示(main 要求绝对 directory,fail-closed)。 */}
              <Show when={kind() === "session"}>
                <button
                  class="alpha-ext-add"
                  data-session-toggle={rowSessionView().on ? "on" : "off"}
                  disabled={sessionBusy() === row.receipt.id || !sessionDirectory()}
                  title={!sessionDirectory() ? t("alpha.ext.sessionNeedsProject") : undefined}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void runSessionToggle({ catalogId: row.receipt.id, name: row.name, on: !rowSessionView().on })
                  }}
                >
                  {rowSessionView().on ? t("alpha.ext.close") : t("alpha.ext.turnOn")}
                </button>
              </Show>
              <Show when={kind() === "enable"}>
                <button
                  class="alpha-ext-add"
                  data-enable-row={rowKey}
                  disabled={stateBusy[0]()}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void toggleState()
                  }}
                >
                  {t("alpha.ext.turnOn")}
                </button>
              </Show>
              {/* REQ-234 `#1529`:待生效的行给一个显式「立即生效」—— 唯一会跳过「等对话空闲」的入口,悬停说清代价。 */}
              <Show when={kind() === "reload"}>
                <button
                  class="alpha-ext-add"
                  data-hub-reload-now=""
                  title={t("alpha.ext.hubReloadNowHint")}
                  disabled={reloadBusy()}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void reloadNow()
                  }}
                >
                  {t("alpha.ext.hubReloadNow")}
                </button>
              </Show>
              {/* REQ-103:审查更新(复用既有 runUpdate —— MCP 走确认框重装,其余原子更新) */}
              <Show when={kind() === "update"}>
                <button
                  class="alpha-ext-add"
                  data-update-row={rowKey}
                  disabled={updBusy() === row.receipt.id}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void runUpdate(row.receipt)
                  }}
                >
                  {updBusy() === row.receipt.id ? t("alpha.ext.adding") : t("alpha.ext.reviewUpdate")}
                </button>
              </Show>
            </>
          )}
        </Show>
        <Show when={!attention() || !clickable()}>
          <MoreMenu id={`installed:${rowKey}:${row.receipt.scope ?? "global"}`} items={menuItems()} />
        </Show>
      </div>
    )
  }

  // 平台云连接器(非目录条目,点开专属详情)。批准稿:已登录平台时在「已安装」组,否则在「Code Puppy 云」组首行,
  // 动作是「登录」或「切换到平台模式」。
  const CloudConnectorRow = () => (
    <div class="alpha-ext-kit" data-clickable="" data-cloud-connector="" onClick={() => setDetail({ kind: "cloud-connector" })}>
      <span class="alpha-ext-kit-ic" style={{ background: "#5c7cbf" }}>
        云
      </span>
      <div class="alpha-ext-kit-body">
        <div class="alpha-ext-kit-ttl">
          <b>{t("alpha.ext.cloudConnectorTitle")}</b>
        </div>
        <div class="alpha-ext-kit-desc">
          {/* `#733`:云连接器是用户看这条状态的**主要**地方 —— `needs_auth` 在这里也必须说成「需要重新登录」并给出动作。
              `#624`:恢复中不能说「需登录平台模式」—— 用户已登录。 */}
          <span
            class="alpha-ext-cloudst"
            data-st={
              cloudReady()
                ? cloudLive()?.needsAuth
                  ? "idle"
                  : cloudLive()?.connected
                    ? "on"
                    : "idle"
                : cloudRecovering()
                  ? "idle"
                  : "off"
            }
          >
            {cloudReady()
              ? cloudLive()?.needsAuth
                ? t("alpha.ext.mcpNeedsAuth")
                : cloudLive()?.connected
                  ? t("alpha.ext.cloudConnConnected")
                  : t("alpha.ext.cloudConnDisconnected")
              : cloudRecovering()
                ? t("alpha.ext.cloudConnRecovering")
                : t("alpha.ext.cloudConnNeedLogin")}
          </span>
        </div>
      </div>
      {/* server 名取**引擎报回来的那个**(`InstalledState.name`),不在 renderer 再写一遍字面量。 */}
      <Show
        when={cloudReady()}
        fallback={
          // `#624`:恢复中的用户**已登录、已在 platform 模式** —— 不给「登录 / 切换」(点下去是 no-op)。
          <Show when={!cloudRecovering()}>
            <Show
              when={authState().status !== "logged-in"}
              fallback={
                <button
                  class="alpha-ext-add"
                  data-variant="primary"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void window.api.auth.setMode("platform")
                  }}
                >
                  {t("alpha.ext.cloudSwitchMode")}
                </button>
              }
            >
              <button
                class="alpha-ext-add"
                data-variant="primary"
                onClick={(ev) => {
                  ev.stopPropagation()
                  void window.api.auth.start()
                }}
              >
                {t("alpha.ext.cloudLoginCta")}
              </button>
            </Show>
          </Show>
        }
      >
        <Show
          when={cloudLive()?.needsAuth}
          fallback={
            <MoreMenu
              id="cloud-connector"
              items={[{ key: "settings", label: t("alpha.ext.rowSetup"), onSelect: () => setDetail({ kind: "cloud-connector" }) }]}
            />
          }
        >
          <McpNeedsAuthAction name={cloudLive()!.name} />
        </Show>
      </Show>
    </div>
  )

  // ── 页 ───────────────────────────────────────────────────────────────────────────────────
  const currentTab = () => TABS.find((x) => x.key === section()) ?? TABS[0]!
  const installedPage = createMemo(() => installedFor(section()))
  const pageHasUpdates = () => updatable().some((r) => pageOfType(r.type) === section())
  const ownAgentsUnreceipted = createMemo(() => {
    const q = query().trim().toLowerCase()
    return ownAgents().filter(
      (a) => !ext.store.receipts.some((r) => r.type === "agent" && r.name === a.name) && (!q || matchesAgent(a)),
    )
  })
  const factorySkillNames = createMemo(() => ext.factorySkills().filter((name) => matchesAgent({ name })))
  const cloudConnectorMatches = () => matchesAgent({ name: t("alpha.ext.cloudConnectorTitle") })
  // 「添加 ▾」(批准稿 `#hub-add`,取代「导入」页签):每一项打开的都是原来那个导入窗口,窗口本身不改。
  const addItems = (): MoreMenuItem[] => [
    { key: "folder", label: t("alpha.ext.importFolder"), disabled: importBusy(), onSelect: () => void runImportFolder() },
    {
      key: "git",
      label: t("alpha.ext.importGit"),
      disabled: importBusy(),
      onSelect: () => {
        setImportErr("")
        setImportInput("")
        setImportDialog("git")
      },
    },
    {
      key: "custom-connector",
      label: t("alpha.ext.customMcp"),
      disabled: cmBusy(),
      onSelect: () => {
        setCmErr("")
        setCustomMcpOpen(true)
      },
    },
    { key: "agent", label: t("alpha.ext.importAgent"), disabled: agentBusy(), onSelect: () => void runPickAgentFile() },
  ]
  const InstalledHead = () => (
    <SecRow
      label={t("alpha.ext.tabInstalled")}
      actionLabel={pageHasUpdates() ? t("alpha.ext.updateAll") : undefined}
      onAction={() => void runUpdateAll()}
    />
  )
  const ProjectGroup = () => (
    <Show when={projectDir() && installedPage().project.length > 0}>
      <div class="alpha-ext-scopeh">
        {t("alpha.ext.scopeProjectGroup")} · {projectLabel(projectDir()!)}
      </div>
      <div class="alpha-ext-grid" data-group="project">
        <For each={installedPage().project}>{(row) => <InstalledRow row={row} />}</For>
      </div>
    </Show>
  )
  const Skeleton = () => (
    <Show when={!ext.store.ready && installedAll().length === 0}>
      <div class="alpha-ext-grid" aria-hidden="true">
        <div class="alpha-ext-skel-row" />
        <div class="alpha-ext-skel-row" />
      </div>
    </Show>
  )
  const Segments = () => (
    <div class="alpha-ext-seg" role="tablist">
      <button role="tab" data-segment="recommended" data-on={segment() === "recommended" ? "" : undefined} onClick={() => setSegment("recommended")}>
        {t("alpha.ext.tabFeatured")}
      </button>
      <button role="tab" data-segment="system" data-on={segment() === "system" ? "" : undefined} onClick={() => setSegment("system")}>
        {t("alpha.ext.segSystem")}
      </button>
    </div>
  )
  const NoMatches = (cp: { when: boolean }) => (
    <Show when={searching() && cp.when}>
      <EmptyState title={t("alpha.ext.noResults")} />
    </Show>
  )

  return (
    <Show when={props.open()}>
      <Portal mount={host}>
        <div class="a-ui alpha-ext-page" role="region" aria-label={t("alpha.ext.hub")}>
          {/* ░░ HORIZONTAL TAB BAR(批准稿 `#hub-tabs`:连接器 / 技能 / 助手) ░░ */}
          <nav class="alpha-ext-tabs">
            <div class="alpha-ext-tabs-inner">
              <For each={TABS}>
                {(item) => (
                  <button
                    class="alpha-ext-tab"
                    data-tab={item.key}
                    data-active={section() === item.key ? "" : undefined}
                    onClick={() => gotoSection(item.key)}
                  >
                    {t(item.labelKey as never)}
                  </button>
                )}
              </For>
            </div>
            <button
              ref={(element) => (hubCloseButton = element)}
              class="alpha-ext-close"
              title={t("alpha.ext.close")}
              aria-label={t("alpha.ext.close")}
              onClick={() => props.onClose()}
            >
              <Svg d="M6 6l12 12M18 6L6 18" />
            </button>
          </nav>

          <div class="alpha-ext-scroll">
            <div class="alpha-ext-center">
              {/* B11:mcp.status 整表读取失败此前静默空白(per-row error ≠ 整表失败) */}
              <Show when={ext.store.error}>
                <Banner
                  kind="error"
                  title={t("alpha.ext.loadFailed")}
                  detail={t("alpha.ext.loadFailedDetail")}
                  action={{ label: t("alpha.ext.retry"), onClick: () => void ext.refresh() }}
                />
              </Show>

              <Show
                when={!detail()}
                fallback={
                  <ExtensionDetail
                    target={detail()!}
                    ext={ext}
                    catalogVersion={catalog().version}
                    byId={byId}
                    busy={busy}
                    crumb={sectionLabel()}
                    errorFor={(id) => cardErr()[id]}
                    onBack={() => setDetail(null)}
                    onInstall={(e) => stageInstallFromDetail(e)}
                    onPackageAction={runPackageAction}
                    onUninstall={(r) => void onUninstall(r)}
                    onOpenEntry={(e) => openEntryDetail(e)}
                    cloudReady={cloudReady}
                    cloudRecovering={cloudRecovering}
                    onLogin={authState().status !== "logged-in" ? () => void window.api.auth.start() : undefined}
                    governance={governance}
                    onToggleState={runStateToggle}
                    curationStatus={statusOf}
                    nowIso={nowIso}
                    sessionViewFor={sessionViewFor}
                    sessionAvailable={() => !!sessionDirectory()}
                    sessionBusyFor={(id) => sessionBusy() === id}
                    onSessionToggle={runSessionToggle}
                  />
                }
              >
                {/* 页头(批准稿 `#hub-connectors`):标题 + 一行副标题 + 本页搜索 +「添加 ▾」。 */}
                <header class="alpha-ext-pagehd">
                  <div class="alpha-ext-pagehd-t">
                    <h1 class="alpha-ext-title">{t(currentTab().labelKey as never)}</h1>
                    <p class="alpha-ext-sub">{t(currentTab().subKey as never)}</p>
                  </div>
                  <div class="alpha-ext-search">
                    <span class="alpha-ext-search-ic">
                      <SearchIc />
                    </span>
                    <input
                      type="search"
                      placeholder={t(currentTab().searchKey as never)}
                      value={query()}
                      onInput={(ev) => setQuery(ev.currentTarget.value)}
                    />
                  </div>
                  <MoreMenu id="add" trigger={`${t("alpha.ext.add")} ▾`} primary items={addItems()} />
                </header>
                {/* B11:导入失败行内呈现(文件夹 / 助手文件走这里;Git 与自定义连接器的失败落在各自窗口内) */}
                <Show when={importErr() && !importDialog()}>
                  <p class="alpha-ext-import-err">{importErr()}</p>
                </Show>
                <Show when={agentErr() && !agentPreview()}>
                  <p class="alpha-ext-import-err">{agentErr()}</p>
                </Show>
                <Show when={importBusy() && !importDialog()}>
                  <p class="alpha-ext-dnote">{t("alpha.ext.importing")}</p>
                </Show>

                {/* ░░ 连接器 ░░ */}
                <Show when={section() === "connectors"}>
                  {/* T3:存量迁移条(仅门控开启且检测到旧安装时;不碰用户自建内容) */}
                  <Show when={migrateCandidates().length > 0}>
                    <div class="alpha-ext-migrate">
                      <div class="alpha-ext-migrate-t">{t("alpha.ext.migrateTitle", { count: migrateCandidates().length })}</div>
                      <div class="alpha-ext-migrate-sub">{t("alpha.ext.migrateSub")}</div>
                      <button class="alpha-ext-add" data-variant="primary" disabled={migrating()} onClick={() => void runMigration()}>
                        {migrating() ? t("alpha.ext.migrating") : t("alpha.ext.migrateAction")}
                      </button>
                    </div>
                  </Show>
                  <InstalledHead />
                  <PackageFeedback />
                  <Skeleton />
                  <div class="alpha-ext-grid" data-group="installed">
                    <Show when={cloudReady() && cloudConnectorMatches()}>
                      <CloudConnectorRow />
                    </Show>
                    <For each={orderedPackages()}>{(pack) => <InstalledPackageRow pack={pack} />}</For>
                    <For each={installedPage().global}>{(row) => <InstalledRow row={row} />}</For>
                  </div>
                  {/* `#784` R1 Major:扩展包清单读不出时**不许**同时说「还没有安装」—— 两条互相矛盾的信息摆在一起,
                      用户会当成东西丢了而去重装,而重装会撞上同名拒绝。 */}
                  <Show
                    when={
                      ext.store.ready &&
                      !searching() &&
                      !packagesUnreadable() &&
                      !cloudReady() &&
                      orderedPackages().length === 0 &&
                      installedPage().global.length === 0 &&
                      installedPage().project.length === 0
                    }
                  >
                    <p class="alpha-ext-man-empty">{t("alpha.ext.empty")}</p>
                  </Show>
                  <ProjectGroup />
                  <For each={connectorGroups()}>
                    {(g) => (
                      <>
                        <SecRow label={catLabel(g.cat)} />
                        <Grid items={g.items} group={g.cat} />
                      </>
                    )}
                  </For>
                  <Show when={browsablePackages().length > 0}>
                    <SecRow label={t("alpha.ext.packageType")} />
                    <div class="alpha-ext-grid" data-group="packages">
                      <For each={browsablePackages()}>{(view) => <PackageRow view={view} />}</For>
                    </div>
                  </Show>
                  {/* Code Puppy 云(原「云能力」页):灰显 ≠ 隐藏 —— 未登录 / 自带 Key 时可浏览,启用与发送被门控。 */}
                  <Show
                    when={(!cloudReady() && cloudConnectorMatches()) || browsableCloud().length > 0 || browsableCloudPackages().length > 0}
                  >
                    <SecRow label={t("alpha.ext.cat.cloud")} />
                    <div class="alpha-ext-grid" data-group="cloud">
                      <Show when={!cloudReady() && cloudConnectorMatches()}>
                        <CloudConnectorRow />
                      </Show>
                      <For each={browsableCloud()}>{(e) => <EntryRow e={e} dim={!cloudReady()} />}</For>
                      <For each={browsableCloudPackages()}>{(view) => <PackageRow view={view} dim={!cloudReady()} />}</For>
                    </div>
                  </Show>
                  <Show when={browsable("bundle").length > 0}>
                    <SecRow label={t("alpha.ext.tabBundles")} />
                    <Grid items={browsable("bundle")} group="bundles" />
                  </Show>
                  <NoMatches
                    when={
                      installedPage().global.length === 0 &&
                      installedPage().project.length === 0 &&
                      orderedPackages().length === 0 &&
                      !cloudConnectorMatches() &&
                      connectorGroups().length === 0 &&
                      browsablePackages().length === 0 &&
                      browsableCloud().length === 0 &&
                      browsableCloudPackages().length === 0 &&
                      browsable("bundle").length === 0
                    }
                  />
                </Show>

                {/* ░░ 技能 ░░ */}
                <Show when={section() === "skills"}>
                  <InstalledHead />
                  <Skeleton />
                  <Show
                    when={installedPage().global.length > 0}
                    fallback={
                      <Show when={ext.store.ready && !searching()}>
                        <p class="alpha-ext-man-empty">
                          {ext.factorySkills().length > 0 ? t("alpha.ext.skillsEmptyHint") : t("alpha.ext.empty")}
                        </p>
                      </Show>
                    }
                  >
                    <div class="alpha-ext-grid" data-group="installed">
                      <For each={installedPage().global}>{(row) => <InstalledRow row={row} />}</For>
                    </div>
                  </Show>
                  <ProjectGroup />
                  <Segments />
                  <Show when={segment() === "recommended"}>
                    <For each={skillGroups()}>
                      {(g) => (
                        <>
                          <SecRow label={catLabel(g.cat)} />
                          <Grid items={g.items} group={g.cat} />
                        </>
                      )}
                    </For>
                    <NoMatches when={skillGroups().length === 0 && installedPage().global.length === 0} />
                  </Show>
                  {/* 「系统」= 应用自带的技能与内置命令(原「已安装 → 应用自带的功能」);隐藏 / 停用 / 自定义收进「…」。 */}
                  <Show when={segment() === "system"}>
                    <Show when={factorySkillNames().length > 0}>
                      <div class="alpha-ext-grid" data-group="system">
                        <For each={factorySkillNames()}>{(name) => <FactorySkillRow name={name} />}</For>
                      </div>
                    </Show>
                    <BuiltinControlsPanel
                      part="commands"
                      agents={ext.store.agents}
                      requestReload={() => ext.requestEngineReload("built-in policy changed")}
                      reloadAgents={ext.reloadAgents}
                      flash={flash}
                    />
                  </Show>
                </Show>

                {/* ░░ 助手 ░░(REQ-018 T7 / ADR-014 O2:Agent 作一等原语) */}
                <Show when={section() === "agents"}>
                  <InstalledHead />
                  <Skeleton />
                  <Show
                    when={installedPage().global.length > 0 || ownAgentsUnreceipted().length > 0}
                    fallback={
                      <Show when={ext.store.ready && !searching()}>
                        <p class="alpha-ext-man-empty">
                          {ext.factorySkills().length > 0 ? t("alpha.ext.agentsEmptyHint") : t("alpha.ext.empty")}
                        </p>
                      </Show>
                    }
                  >
                    <div class="alpha-ext-grid" data-group="installed">
                      <For each={installedPage().global}>{(row) => <InstalledRow row={row} />}</For>
                      <For each={ownAgentsUnreceipted()}>{(a) => <AgentRow a={a} />}</For>
                    </div>
                  </Show>
                  <ProjectGroup />
                  <Segments />
                  <Show when={segment() === "recommended"}>
                    <Grid items={browsable("agent")} group="recommended" />
                    <NoMatches
                      when={browsable("agent").length === 0 && installedPage().global.length === 0 && ownAgentsUnreceipted().length === 0}
                    />
                  </Show>
                  {/* 「系统」= build、plan 等应用自带的助手(REQ-037 内置治理);隐藏 / 停用 / 自定义收进「…」。 */}
                  <Show when={segment() === "system"}>
                    <BuiltinControlsPanel
                      part="agents"
                      agents={ext.store.agents}
                      requestReload={() => ext.requestEngineReload("built-in policy changed")}
                      reloadAgents={ext.reloadAgents}
                      flash={flash}
                    />
                  </Show>
                </Show>
              </Show>
            </div>
          </div>
        </div>

        {/* Install confirmation — staged by MCP/bundle 添加 or the plugin detail page. Backdrop/
            Escape cancel (alpha Dialog). Plugin confirms carry an explicit risk line (Q2). */}
        {/* #397:复审过期的启用显式确认(v6 稿态二;main 闸 code 驱动,确认后携标记重发 ——
            已装已启用不动,时钟仅用于该比较;取消 = 不启用,零副作用)。 */}
        <Dialog
          open={!!expiredConfirm()}
          onClose={() => setExpiredConfirm(null)}
          besideSidebar
          size="sm"
          title={t("alpha.ext.expiredConfirmTitle")}
          restoreFocus={() => hubCloseButton}
          description={<p class="alpha-ext-dnote">{t("alpha.ext.expiredConfirmBody", { date: expiredConfirmDate() })}</p>}
          footer={
            <>
              <Button variant="ghost" autofocus onClick={() => setExpiredConfirm(null)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button variant="primary" onClick={() => void proceedExpiredEnable()}>
                {t("alpha.ext.expiredConfirmGo")}
              </Button>
            </>
          }
        />
        <Dialog
          open={confirm.open()}
          onClose={confirm.close}
          dismissible={!confirmBusy() && !authzBusy()}
          busy={confirmBusy() || authzBusy()}
          besideSidebar
          size="sm"
          title={confirm.title()}
          restoreFocus={() => hubCloseButton}
          footer={<InstallConfirmFooter confirm={confirm} />}
        >
          <InstallConfirmBody confirm={confirm} />
        </Dialog>

        {/* #348:独立授权框 —— skill 直装 / 更新扩权(无前置确认框的宿主)。busy 期间不可关
            (dismissible=false:IPC 无取消能力);取消零权威副作用、静默。 */}
        <ExtStandaloneAuthzDialog
          state={
            authz()?.host === "standalone"
              ? {
                  name: authz()!.entry.displayName,
                  isBundle: authz()!.entry.type === "bundle",
                  mode: authz()!.mode,
                  diffs: authz()!.diffs,
                }
              : null
          }
          busy={authzBusy()}
          onCancel={cancelAuthz}
          onConfirm={() => void confirmAuthz()}
          restoreFocus={() => hubCloseButton}
        />

        {/* T6:导入输入弹窗(Git URL)。失败行内呈现于弹窗内(B11),成功 toast。 */}
        <Dialog
          open={!!importDialog()}
          onClose={() => {
            setImportDialog(null)
            setImportErr("")
          }}
          besideSidebar
          size="sm"
          title={t("alpha.ext.importGitTitle")}
          restoreFocus={() => hubCloseButton}
          footer={
            <>
              <Button variant="ghost" onClick={() => setImportDialog(null)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button variant="primary" disabled={importBusy() || !importInput().trim()} onClick={() => void runImportDialog()}>
                {importBusy() ? t("alpha.ext.importing") : t("alpha.ext.importGo")}
              </Button>
            </>
          }
        >
          <div class="alpha-ext-confirm">
            <p class="alpha-ext-confirm-desc">
              {t("alpha.ext.importGitHint")}
            </p>
            <input
              class="alpha-ext-input alpha-mono"
              placeholder="https://github.com/user/skill-repo"
              value={importInput()}
              onInput={(ev) => setImportInput(ev.currentTarget.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && importInput().trim() && !importBusy()) void runImportDialog()
              }}
            />
            <Show when={importErr()}>
              <p class="alpha-ext-import-err">{importErr()}</p>
            </Show>
          </div>
        </Dialog>

        {/* REQ-033:自定义连接器表单(校验主体在 main:命令/URL 白名单、env 值校验、密钥 file 化) */}
        <Dialog
          open={customMcpOpen()}
          onClose={() => setCustomMcpOpen(false)}
          besideSidebar
          size="sm"
          title={t("alpha.ext.customMcpTitle")}
          restoreFocus={() => hubCloseButton}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCustomMcpOpen(false)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button variant="primary" disabled={cmBusy() || !cmName().trim()} onClick={() => void runAddCustomMcp()}>
                {cmBusy() ? t("alpha.ext.importing") : t("alpha.ext.customMcpAdd")}
              </Button>
            </>
          }
        >
          <div class="alpha-ext-confirm">
            <p class="alpha-ext-confirm-desc">{t("alpha.ext.customMcpHint")}</p>
            <label class="alpha-ext-flabel">{t("alpha.ext.customMcpName")}
              <input class="alpha-ext-input alpha-mono" value={cmName()} onInput={(e) => setCmName(e.currentTarget.value)} placeholder="my-connector" />
            </label>
            <div class="alpha-gov-mode" style={{ margin: "8px 0" }}>
              <button data-on={cmType() === "local" ? "" : undefined} onClick={() => setCmType("local")}>{t("alpha.ext.customMcpTypeLocal")}</button>
              <button data-on={cmType() === "remote" ? "" : undefined} onClick={() => setCmType("remote")}>{t("alpha.ext.customMcpTypeRemote")}</button>
            </div>
            <Show when={cmType() === "local"} fallback={
              <label class="alpha-ext-flabel">{t("alpha.ext.customMcpUrl")}
                <input class="alpha-ext-input alpha-mono" value={cmUrl()} onInput={(e) => setCmUrl(e.currentTarget.value)} placeholder="https://mcp.example.com/sse" />
              </label>
            }>
              <label class="alpha-ext-flabel">{t("alpha.ext.customMcpCommand")}
                <input class="alpha-ext-input alpha-mono" value={cmCommand()} onInput={(e) => setCmCommand(e.currentTarget.value)} placeholder="npx -y @some/mcp-server@1.0.0" />
              </label>
            </Show>
            <label class="alpha-ext-flabel">{t("alpha.ext.customMcpEnv")}
              <textarea class="alpha-ext-input alpha-ext-textarea alpha-mono" rows="2" value={cmEnv()} onInput={(e) => setCmEnv(e.currentTarget.value)} />
            </label>
            <label class="alpha-ext-flabel">{t("alpha.ext.customMcpSecrets")}
              <textarea class="alpha-ext-input alpha-ext-textarea alpha-mono" rows="2" value={cmSecrets()} onInput={(e) => setCmSecrets(e.currentTarget.value)} />
            </label>
            <Show when={cmErr()}>
              <p class="alpha-ext-import-err">{cmErr()}</p>
            </Show>
          </div>
        </Dialog>

        {/* ░░ REQ-128 Phase 3 `#784` 第 3 跳:本地插件包预览屏 ░░
            骨架继承上面那个 agent 两段式预览(取消 / 确认两键,确认之前一个字节都不写盘),
            尺寸放大到 lg —— 单插件技能数实测最多 13 个,弹窗装得下。
            内容分三段:会安装 / 不会安装(逐条原因)/ 这一版不安装的内容类型。
            **每一条「不装」都带具名原因,没有「其他」这一档** —— 原因文案全部由 main 的
            `reasonCode → 人话` 表给出,renderer 一个字都不自己编,也不把多条折叠成「跳过 N 项」。 */}
        <Dialog
          open={!!localPlugin()}
          onClose={() => void closeLocalPlugin()}
          besideSidebar
          size="lg"
          title={t("alpha.ext.localPackageTitle")}
          dismissible={!localPluginBusy()}
          restoreFocus={() => hubCloseButton}
          footer={
            <>
              {/* 安装在跑的时候「取消」**照样可点** —— 用户必须有一条出路,而 main 会如实告诉他
                  这次中止不了。把按钮禁掉等于把那条真话藏起来,用户只会以为界面卡死了。 */}
              <Button variant="ghost" onClick={() => void closeLocalPlugin()}>
                {t("alpha.ext.cancel")}
              </Button>
              {/* 一个都装不上时**保留确认键但禁用**,并把原因写在键面上 —— 这一屏和能装的那一屏
                  是同一屏,不换成一个「知道了」把它伪装成提示框。 */}
              <Button
                variant="primary"
                disabled={localPluginBusy() || !localPlugin()?.previewId}
                onClick={() => void runConfirmLocalPlugin()}
              >
                {localPluginBusy()
                  ? t("alpha.ext.importing")
                  : localPlugin()?.previewId
                    ? t("alpha.ext.localPackageConfirm", { count: String(localPlugin()?.preview.installableCount ?? 0) })
                    : t("alpha.ext.localPackageNothingToInstall")}
              </Button>
            </>
          }
        >
          <Show when={localPlugin()}>
            {(pv) => (
              <div class="alpha-ext-confirm" data-local-package-preview={pv().preview.packageId ?? ""}>
                <p class="alpha-ext-confirm-desc">
                  <b>{pv().preview.name}</b> ·{" "}
                  {pv().preview.version ? `v${pv().preview.version}` : t("alpha.ext.packageNoVersion")} ·{" "}
                  {t("alpha.ext.localPackageFound", { count: String(pv().preview.limits.skillCandidates) })}
                </p>
                {/* 这句话不是免责声明,是这个功能的实际保证水平。任何把它改写成
                    「已检查 / 已验证 / 安全」的措辞都是错的(基线 §8 纪律 3)。 */}
                <p class="alpha-ext-verify-note" data-unreviewed="" role="note">
                  {t("alpha.ext.localPackageUnreviewed")}
                </p>
                {/* `#784` R2:名字显示不了(超长 / 带特殊字符)⇒ 在**按确认之前**说清它会怎么显示。
                    它**不影响能不能装** —— 显示名是可选的、只管显示的;之前它能让整个事务在
                    落账那一刻回滚,那是「预览说能装、点了确认却失败」。 */}
                <Show when={pv().preview.displayNameNotice}>
                  {(notice) => (
                    <p class="alpha-ext-verify-note" data-display-name-notice="" role="note">
                      {notice()}
                    </p>
                  )}
                </Show>
                {/* K19:重复导入必须在**按确认之前**说清。说得晚就从提示变成了失败。 */}
                <Show when={pv().preview.duplicateImportNotice}>
                  {(notice) => (
                    <p class="alpha-ext-verify-note" data-duplicate-import="" role="alert">
                      {notice()}
                    </p>
                  )}
                </Show>
                {/* 一个都装不上 / 结构不认识 / 超出单次导入上限 —— 三种终态共用这一条,
                    文字全部来自 main 的具名判定,不在这里重新措辞。 */}
                <Show when={pv().preview.disposition === "blocked" || !pv().previewId}>
                  <p class="alpha-ext-import-err" data-local-package-blocked={pv().preview.blockedReasonCode ?? pv().reasonCode ?? ""} role="alert">
                    {extensionError(pv().headline, "alpha.ext.error.localInstall", pv().reasonCode ?? pv().preview.blockedReasonCode ?? undefined)}
                  </p>
                </Show>

                <Show when={pv().preview.components.some((c) => c.disposition === "install")}>
                  <SecRow
                    label={t("alpha.ext.localPackageWillInstall")}
                    count={pv().preview.components.filter((c) => c.disposition === "install").length}
                  />
                  <div class="alpha-ext-manage">
                    <For each={pv().preview.components.filter((c) => c.disposition === "install")}>
                      {(component) => (
                        <div class="alpha-ext-man" data-preview-component={component.dir} data-disposition="install">
                          <div class="alpha-ext-man-body">
                            <div class="alpha-ext-man-nm">
                              <b>{component.name}</b>
                              <span class="alpha-ext-type-pill">{typeLabel("skill")}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={pv().preview.components.some((c) => c.disposition === "skip")}>
                  <SecRow
                    label={t("alpha.ext.localPackageWontInstall")}
                    count={pv().preview.components.filter((c) => c.disposition === "skip").length}
                  />
                  <div class="alpha-ext-manage">
                    <For each={pv().preview.components.filter((c) => c.disposition === "skip")}>
                      {(component) => (
                        <div class="alpha-ext-man" data-preview-component={component.dir} data-disposition="skip" data-dim="">
                          <div class="alpha-ext-man-body">
                            <div class="alpha-ext-man-nm">
                              <b>{component.name}</b>
                              <For each={component.reasonCodes}>
                                {(code) => (
                                  <span class="alpha-ext-type-pill" data-off="" data-skip-reason={code}>
                                    {code}
                                  </span>
                                )}
                              </For>
                            </div>
                            {/* 逐条人话,与 reasonCodes 同序同长(main 给的,不折叠、不改写)。 */}
                            <For each={component.reasons}>
                              {(reason) => <div class="alpha-ext-man-st">{reason}</div>}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={pv().preview.unsupportedLayouts.length > 0}>
                  <SecRow label={t("alpha.ext.localPackageUnsupportedLayout")} count={pv().preview.unsupportedLayouts.length} />
                  <div class="alpha-ext-manage">
                    <For each={pv().preview.unsupportedLayouts}>
                      {(issue) => (
                        <div class="alpha-ext-man" data-unsupported-layout={issue.code} data-dim="">
                          <div class="alpha-ext-man-body">
                            <div class="alpha-ext-man-nm">
                              <b>{issue.at || pv().preview.name}</b>
                            </div>
                            <div class="alpha-ext-man-st">{issue.detail}</div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={pv().preview.unsupportedComponentTypes.length > 0}>
                  <SecRow
                    label={t("alpha.ext.localPackageUnsupportedTypes")}
                    count={pv().preview.unsupportedComponentTypes.length}
                  />
                  <div class="alpha-ext-manage">
                    <For each={pv().preview.unsupportedComponentTypes}>
                      {(item) => (
                        <div class="alpha-ext-man" data-unsupported-type={item.type} data-dim="">
                          <div class="alpha-ext-man-body">
                            <div class="alpha-ext-man-nm">
                              <b>{item.at}</b>
                            </div>
                            <div class="alpha-ext-man-st">{item.detail}</div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={localPluginErr()}>
                  <p class="alpha-ext-import-err" data-local-package-error="" role="alert">
                    {localPluginErr()}
                  </p>
                </Show>
                <p class="alpha-ext-key-hint">{t("alpha.ext.localPackageCancelNote")}</p>
              </div>
            )}
          </Show>
        </Dialog>

        {/* REQ-033:agent 导入映射预览(显式逐字段;不支持项 loud,确认才写入) */}
        <Dialog
          open={!!agentPreview()}
          onClose={() => setAgentPreview(null)}
          besideSidebar
          size="md"
          title={t("alpha.ext.importAgentTitle")}
          restoreFocus={() => hubCloseButton}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAgentPreview(null)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button variant="primary" disabled={agentBusy()} onClick={() => void runConfirmAgentImport()}>
                {agentBusy() ? t("alpha.ext.importing") : t("alpha.ext.importAgentConfirm")}
              </Button>
            </>
          }
        >
          <Show when={agentPreview()}>
            {(pv) => (
              <div class="alpha-ext-confirm">
                <p class="alpha-ext-confirm-desc">
                  <b>{pv().name}</b> · {t("alpha.ext.importAgentFormat")}:{pv().format}
                </p>
                <div class="alpha-ext-manage">
                  <For each={pv().mapping}>
                    {(m) => (
                      <div class="alpha-ext-man">
                        <span class="alpha-ext-man-name">
                          {m.source}
                          <span class="alpha-ext-chip">{m.target ?? t("alpha.ext.mapping.notMapped")}</span>
                        </span>
                        <small style={{ "margin-left": "auto", opacity: 0.7, "max-width": "60%" }}>{m.note}</small>
                      </div>
                    )}
                  </For>
                </div>
                <p class="alpha-ext-key-hint">{t("alpha.ext.importAgentMapNote")}</p>
                <Show when={agentErr()}>
                  <p class="alpha-ext-import-err">{agentErr()}</p>
                </Show>
              </div>
            )}
          </Show>
        </Dialog>
      </Portal>
    </Show>
  )
}
