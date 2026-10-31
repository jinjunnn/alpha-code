// HubInstallWatcher — REQ-234 `#1531`(基线 §2.3,不变量 I2 / I3 / I9):agent 请求安装定制中心条目或签名包时,弹的是**定制中心
// 自己的安装确认框**(extensions/install-confirm.tsx,与定制中心共用同一份控制器),用户在框里点同意、在框里填密钥。
//
// 运输:agent 的 codepuppy_hub_install 工具经引擎审批请求(`ctx.ask`,metadata.alphaHub = { catalogId, requestId })到这里;
// PermissionWatcher 按 metadata.alphaHub 把这类请求交给本组件,通用审批框不呈现它(同一个请求不会弹两个框)。
// 应答命令没有自由载荷,结构上不可能把框里填的密钥带回工具;密钥只经 install 意图的 grants 进 main(与定制中心同一路)。
//
// ── 一次请求的进度 = 模块级状态机(审计 R1 Major 3 / R2 #1 #2)────────────────────────────────────────────────────
// 审批面会在 SSE 重连时卸载再挂载(feed 重读快照期间不就绪),组件状态随之丢失;而 main 的阶段只前进、终态后拒。
// 所以进度按 requestId 记在本模块,任何一次挂载都从这里恢复,组件只是它的呈现。I9:**先记阶段、再回审批**,
// 结局以 main 记的阶段为准,审批应答只负责唤醒工具;「回复」只在回执成功之后才算完成。
//
//   阶段                     | 重挂载                               | 回复失败                     | 安装落定                                   | 用户取消 / 关框
//   ─────────────────────────┼──────────────────────────────────────┼──────────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────
//   starting(记 confirming、 | 不显示框,等它进 confirming;不回     | —(此阶段不回复)             | —(包的取预览首驱若直接落定,同「安装落定」) | —(还没有框)
//    找条目/取包预览)        |                                      |                              |                                            |
//   confirming(等用户确认)  | 重开同一个确认框(条目 / 包预览),    | —                            | —(没有在途安装)                           | 记 declined ⇒ decided(reject)⇒ 回 reject
//                            | 不再记阶段;不回                      |                              |                                            |
//   authorizing(等用户授权, | 重开条目确认框的授权第二阶段,同一份  | —                            | —                                          | 记 failed(authorization canceled)
//    main 已 submitted)      | diffs / 密钥 / 作用域;不回           |                              |                                            | ⇒ decided(reject)⇒ 回 reject
//   executing(安装执行中,  | 不显示框,只等结局;不回              | —                            | committed ⇒ decided(once)⇒ 回 once;       | 原挂载里框 busy、取消不可点;重挂载后
//    确认那一下就进,先于    |                                      |                              | failed ⇒ 记 failed ⇒ failed(显示原因);   | 没有框 ⇒ 无可取消,不记、不回;结局照常
//    submitted IPC)         |                                      |                              | 又要授权 ⇒ authorizing(显示授权框)        | (once / 显示原因 / 授权框,这时才可取消)
//   failed(框里显示原因)    | 重新显示原因,不再记;不回            | —                            | —                                          | 用户关框 ⇒ decided(reject)⇒ 回 reject
//   decided(已决定待回)     | 不显示框;经**当前** feed 回(先等    | 留在 decided,不显示;下一次  | —                                          | —
//                            | 那一笔阶段记完)                     | 挂载再经当前 feed 重试       |                                            |
//   replied(已回,回执成功) | 不显示,不回                         | —                            | —                                          | —
//
// 记不上 confirming ⇒ decided(reject),不弹框(没有框就没有安装);目录里找不到 ⇒ 记 failed ⇒ decided(reject)。
// 300 s 无人应答:引擎自己广播 reject 回执,请求从列表里消失、本组件不再挂载 —— 不记 declined(已记的阶段保持)。
// 判据:hub-install-watcher.test.ts 的「状态表」—— 每一格一条,生产组件 + main 的生产阶段簿。

import { createEffect, createSignal, onMount, Show, untrack, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
import type { PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { parseRoute } from "../../shared/route-manifest"
import { t } from "../i18n"
import { Dialog } from "./Dialog"
import { Button } from "./Button"
import { catalog, refreshCatalog } from "../extensions/catalog-source"
import { installableCatalogEntries, installableCatalogPackages } from "../extensions/catalog-installable-view"
import type { CatalogEntry } from "../extensions/catalog-types"
import { extIpc } from "../extensions/ext-ipc"
import { extensionError } from "../extensions/ext-presentation"
import { createInstallConfirm, InstallConfirmBody, InstallConfirmFooter } from "../extensions/install-confirm"
import {
  isAuthzRequired,
  useExtensions,
  type ActionResult,
  type CatalogInstallIntentV1,
  type CatalogInstallResult,
  type CatalogInstallScopeChoice,
} from "../extensions/use-extensions"
import type { AuthorizationConfirmationWire, CapabilityDiffWire } from "../../shared/ext-capability-authorization"
import type { CatalogPackageViewV1 } from "../../shared/catalog-package-view"
import type { PackageAdmissionPreviewV1 } from "../../shared/package-admission"
import type { ServerInfo } from "../sidebar/use-projects"

export type AlphaHubRequest = { catalogId: string; requestId: string }

/** 审批请求是不是 agent 的定制中心安装请求(PermissionWatcher 据此分流)。形状不对 = 不是,交给通用审批框照常处理。 */
export function alphaHubRequestOf(request: PermissionV2Request): AlphaHubRequest | undefined {
  const hub = (request as { metadata?: { alphaHub?: unknown } }).metadata?.alphaHub
  if (!hub || typeof hub !== "object") return
  const { catalogId, requestId } = hub as Record<string, unknown>
  if (typeof catalogId !== "string" || !catalogId || typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return
  return { catalogId, requestId }
}

type Target =
  | { kind: "entry"; entry: CatalogEntry }
  | { kind: "package"; view: CatalogPackageViewV1; preview: PackageAdmissionPreviewV1 }

type Phase =
  | { kind: "starting" }
  | { kind: "confirming"; target: Target }
  | {
      kind: "authorizing"
      entry: CatalogEntry
      diffs: CapabilityDiffWire[]
      secrets: Record<string, string> | undefined
      scope: CatalogInstallScopeChoice | undefined
      projectDir: string | undefined
    }
  | { kind: "executing"; name: string }
  | { kind: "failed"; name: string; reason: string; recorded: Promise<unknown> }
  | { kind: "decided"; decision: "once" | "reject"; recorded: Promise<unknown> }
  | { kind: "replied" }

type Flight = {
  phase: Accessor<Phase | undefined>
  setPhase: (phase: Phase) => void
  /** 在途的那一次回复(两次挂载不并发回同一个决定)。 */
  delivering?: Promise<boolean>
}
const flights = new Map<string, Flight>()
const MAX_FLIGHTS = 64

function flightFor(requestId: string): Flight {
  const known = flights.get(requestId)
  if (known) return known
  const [phase, setPhase] = createSignal<Phase | undefined>(undefined)
  const flight: Flight = { phase, setPhase: (next) => void setPhase(() => next) }
  flights.set(requestId, flight)
  while (flights.size > MAX_FLIGHTS) flights.delete(flights.keys().next().value!)
  return flight
}

export function HubInstallWatcher(props: {
  hub: AlphaHubRequest
  server: Accessor<ServerInfo | undefined>
  /** 回审批(once / reject);由 PermissionWatcher 按请求 ID 绑定到**当前** feed。 */
  reply: (decision: "once" | "reject") => Promise<unknown>
}) {
  const loc = useLocation()
  const projectDir = () => {
    const r = parseRoute(loc.pathname)
    return r.kind === "session" || r.kind === "directory" ? r.directory : undefined
  }
  const ext = useExtensions(props.server, () => true, projectDir)
  const flight = flightFor(props.hub.requestId)

  const record = async (input: { stage: "confirming" | "submitted" | "declined" | "failed"; catalogId?: string; reason?: string }) => {
    try {
      return (await extIpc.hubRequestStage({ requestId: props.hub.requestId, ...input })).ok === true
    } catch {
      return false
    }
  }
  /** 决定:先把阶段记完(recorded),回复由挂着的那一次挂载经它的 feed 发。 */
  const decide = (decision: "once" | "reject", recorded: Promise<unknown> = Promise.resolve()) =>
    flight.setPhase({ kind: "decided", decision, recorded })
  /** install IPC 返回 !ok 之后才记 failed;记完才在框里显示原因,用户关框才决定 reject。 */
  const fail = async (name: string, reason: string) => {
    const recorded = record({ stage: "failed", reason })
    await recorded
    flight.setPhase({ kind: "failed", name, reason, recorded })
  }
  const settle = (name: string, ok: boolean, reason?: string) => (ok ? decide("once") : void fail(name, reason ?? "install failed"))

  /** 确认(或授权)之后装的那一下:与定制中心同一组出站,多带 hubRequestId。 */
  const install = async (
    entry: CatalogEntry,
    secrets: Record<string, string> | undefined,
    authorization: AuthorizationConfirmationWire | undefined,
    scope: CatalogInstallScopeChoice | undefined,
    selectedProjectDir: string | undefined,
  ): Promise<CapabilityDiffWire[] | null> => {
    // 确认的那一下就进 executing,先于 submitted IPC(审计 R3):在途期间重挂载只等结局,恢复不出可操作的确认框
    const fromConfirming = flight.phase()?.kind === "confirming"
    flight.setPhase({ kind: "executing", name: entry.displayName })
    if (fromConfirming && !(await record({ stage: "submitted" }))) {
      void fail(entry.displayName, "the request could not be recorded")
      return null
    }
    const res = await dispatch(entry, secrets, authorization, scope, selectedProjectDir)
    if (isAuthzRequired(res)) {
      flight.setPhase({ kind: "authorizing", entry, diffs: res.authorization, secrets, scope, projectDir: selectedProjectDir })
      return res.authorization
    }
    settle(entry.displayName, res.ok, res.reason)
    return null
  }
  const dispatch = async (
    entry: CatalogEntry,
    secrets: Record<string, string> | undefined,
    authorization: AuthorizationConfirmationWire | undefined,
    scope: CatalogInstallScopeChoice | undefined,
    selectedProjectDir: string | undefined,
  ): Promise<ActionResult> => {
    const requestId = props.hub.requestId
    if (scope === "project" && entry.type !== "mcp") return { ok: false, reason: "project-scope-mcp-only" }
    if (entry.type === "mcp") {
      const rc = await ext.checkRuntime(entry)
      if (!rc.ok) return { ok: false, reason: "reason" in rc ? rc.reason : t("alpha.ext.runtimeMissing", { tool: rc.missing }) }
      return ext.addMcp(entry, undefined, secrets, authorization, scope, selectedProjectDir, requestId)
    }
    if (entry.type === "skill") return ext.installSkill(entry, authorization, requestId)
    if (entry.type === "agent") return ext.installAgentEntry(entry, authorization, requestId)
    if (entry.type === "plugin") return ext.installPlugin(entry, authorization, requestId)
    if (entry.type === "cloud") return ext.enableCloud(entry, authorization, requestId)
    const r = await ext.installCatalogIntent({ catalogId: entry.id, ...(authorization ? { authorization } : {}), hubRequestId: requestId })
    return r.ok ? { ok: true } : r
  }

  /** 包确认屏那一趟(审计 R1 Major 2):与定制中心同一个出口 installCatalogIntent,多带 hubRequestId;确认时才记 submitted。 */
  const installPackage = async (intent: CatalogInstallIntentV1): Promise<CatalogInstallResult> => {
    const phase = flight.phase()
    const name = phase?.kind === "confirming" && phase.target.kind === "package" ? phase.target.view.presentation.displayName : intent.catalogId
    flight.setPhase({ kind: "executing", name })
    if (phase?.kind === "confirming" && !(await record({ stage: "submitted" }))) return { ok: false, reason: "the request could not be recorded" }
    return ext.installCatalogIntent({ ...intent, hubRequestId: props.hub.requestId })
  }

  const confirm = createInstallConfirm({
    install,
    projectDir,
    installPackage,
    onPackageSettled: async (pending, result) => {
      settle(pending.view.presentation.displayName, result?.ok === true, result && !result.ok ? result.reason : undefined)
      return pending.view
    },
  })

  /** starting:记 confirming → 目录条目,否则签名包(首驱只取预览,带 hubRequestId;main 对授权暂停不落定)。 */
  const start = async () => {
    flight.setPhase({ kind: "starting" })
    if (!(await record({ stage: "confirming", catalogId: props.hub.catalogId }))) return decide("reject")
    await refreshCatalog()
    const advisory = await extIpc.advisoryActive().catch(() => ({ ids: [] as string[] }))
    const blocked = new Set(advisory.ids)
    const entry = installableCatalogEntries(catalog().entries, blocked).find((e) => e.id === props.hub.catalogId)
    if (entry) return flight.setPhase({ kind: "confirming", target: { kind: "entry", entry } })
    const view = installableCatalogPackages(catalog().packages ?? [], catalog().entries, blocked).find((item) => item.catalogId === props.hub.catalogId)
    if (!view) return decide("reject", record({ stage: "failed", reason: "not in this app's verified catalog" }))
    const first = await ext.installCatalogIntent({ catalogId: view.catalogId, attemptId: `hub-${globalThis.crypto.randomUUID()}`, hubRequestId: props.hub.requestId })
    if (!first.ok && "stage" in first && first.stage === "authorize" && "packageAuthorization" in first && first.packageAuthorization)
      return flight.setPhase({ kind: "confirming", target: { kind: "package", view, preview: first.packageAuthorization } })
    // 没进授权暂停就是落定了(main 已按 hubRequestId 记 committed / failed)
    settle(view.presentation.displayName, first.ok, first.ok ? undefined : first.reason)
  }

  // 挂载之后的下一拍才开框:重挂载时阶段早已在,同一拍里把 open 与 title 一起翻真,Dialog 的焦点 effect 会跑在它的
  // Portal 面板挂上之前(实测 `panel.ownerDocument` 为 undefined)。首次挂载的开框本来就在几次 IPC 之后。
  const [mounted, setMounted] = createSignal(false)
  onMount(() => {
    queueMicrotask(() => setMounted(true))
    if (flight.phase() === undefined) void start()
  })

  // 呈现跟着阶段走(本次挂载与重挂载同一条路):框没开着而阶段要框 ⇒ 按阶段里存的东西重开。
  createEffect(() => {
    const phase = flight.phase()
    if (!mounted() || untrack(confirm.open)) return
    if (phase?.kind === "confirming" && phase.target.kind === "entry") confirm.openInstallConfirmation(phase.target.entry)
    if (phase?.kind === "confirming" && phase.target.kind === "package")
      confirm.openPackage({ view: phase.target.view, preview: phase.target.preview, finish: () => {} })
    if (phase?.kind === "authorizing") {
      confirm.openInstallConfirmation(phase.entry)
      confirm.setAuthz({ entry: phase.entry, mode: "install", host: "confirm", secrets: phase.secrets, scope: phase.scope, projectDir: phase.projectDir, diffs: phase.diffs })
    }
  })

  // 框在「等用户」的阶段里被关 = 用户取消。有结局的关框(executing 之后)不在这两格里,不算取消。
  let wasOpen = false
  createEffect(() => {
    if (confirm.open()) {
      wasOpen = true
      return
    }
    if (!wasOpen) return
    wasOpen = false
    const phase = untrack(flight.phase)
    if (phase?.kind === "confirming") decide("reject", record({ stage: "declined" }))
    if (phase?.kind === "authorizing") decide("reject", record({ stage: "failed", reason: "authorization canceled" }))
  })

  // decided ⇒ 经本次挂载的 feed 回;回执成功才 replied。别的挂载正在回同一个决定 ⇒ 等它,它失败了本次再试一次。
  let attempted: Phase | undefined
  createEffect(() => {
    const phase = flight.phase()
    if (phase?.kind !== "decided" || attempted === phase) return
    attempted = phase
    void (async () => {
      if (flight.delivering && (await flight.delivering)) return
      if (flight.phase() !== phase) return
      flight.delivering = (async () => {
        await phase.recorded
        try {
          await props.reply(phase.decision)
          flight.setPhase({ kind: "replied" })
          return true
        } catch {
          return false
        }
      })()
      const delivered = await flight.delivering
      flight.delivering = undefined
      return delivered
    })()
  })

  const failed = () => {
    const phase = flight.phase()
    return phase?.kind === "failed" ? phase : undefined
  }
  const closeFailure = () => {
    const phase = failed()
    if (phase) decide("reject", phase.recorded)
  }

  return (
    <Dialog
      open={confirm.open() || failed() !== undefined}
      onClose={() => (failed() ? closeFailure() : confirm.close())}
      dismissible={!confirm.busy()}
      busy={confirm.busy()}
      size="sm"
      title={failed() ? t("alpha.ext.confirmTitle", { name: failed()!.name }) : confirm.title()}
      footer={
        <Show when={failed()} fallback={<InstallConfirmFooter confirm={confirm} />}>
          <Button variant="primary" autofocus onClick={closeFailure}>
            {t("alpha.ext.close")}
          </Button>
        </Show>
      }
    >
      <p class="alpha-ext-confirm-line" data-hub-agent-request={props.hub.requestId}>
        {t("alpha.ext.hubAgentRequested")}
      </p>
      <Show when={failed()} fallback={<InstallConfirmBody confirm={confirm} />}>
        {(phase) => (
          <p class="alpha-ext-key-hint" role="alert" data-hub-agent-failure="">
            {extensionError(phase().reason, "alpha.ext.error.install")}
          </p>
        )}
      </Show>
    </Dialog>
  )
}
