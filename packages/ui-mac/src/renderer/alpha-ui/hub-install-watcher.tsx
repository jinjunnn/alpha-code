// HubInstallWatcher — REQ-234 `#1531`(基线 §2.3,不变量 I2 / I3 / I9):agent 请求安装定制中心条目时,弹的是**定制中心
// 自己的安装确认框**(extensions/install-confirm.tsx,与定制中心共用同一份),用户在框里点同意、在框里填密钥。
//
// 运输:agent 的 hub_install 工具经引擎审批请求(`ctx.ask`,metadata.alphaHub = { catalogId, requestId })到这里;
// PermissionWatcher 按 metadata.alphaHub 把这类请求交给本组件,通用审批框不呈现它(同一个请求不会弹两个框)。
//
// 顺序(I9:**先记阶段、再回审批**,结局以 main 记的阶段为准,审批应答只负责唤醒工具):
//   ① 记 confirming(记不上 ⇒ 不弹框、回 reject —— 没有框就没有安装)
//   ② 按 catalogId 在本机已验目录的可安装视图里找到条目(找不到 ⇒ 记 failed、回 reject)→ 弹框
//   ③ 用户确认 ⇒ 记 submitted ⇒ 既有出站(use-extensions,带 hubRequestId)⇒ main 提交成功时**自己**记 committed、请 ext 重载
//        ├─ 提交成功 ⇒ 回 once
//        └─ main 拒绝 / 失败(install IPC 已返回 !ok 之后)⇒ 记 failed(带原因)⇒ 框里显示原因 ⇒ 用户关框 ⇒ 回 reject
//   ④ 用户取消 / 关框 ⇒ 还在 confirming 记 declined;授权第二阶段才取消(已 submitted)记 failed「授权已取消」⇒ 回 reject
//   ⑤ 300 s 无人应答:引擎自己广播 reject 回执,请求从列表里消失,本组件随之卸载 —— 不记 declined(已记的阶段保持)。
// 应答命令没有自由载荷,结构上不可能把框里填的密钥带回工具;密钥只经 install 意图的 grants 进 main(与定制中心同一路)。

import { createEffect, createSignal, onMount, Show, type Accessor } from "solid-js"
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

type Outcome = { kind: "committed" } | { kind: "failed"; reason: string }

/**
 * 一次 agent 安装请求的进度,按 requestId 记在**模块**里(审计 R1 Major 3)。审批面在 SSE 重连时会卸载再挂载
 * (feed 重读快照期间不就绪)—— 组件状态随之丢失,而 main 的阶段只前进:重挂载的组件若再记一次 confirming,
 * main 拒绝,守望者就替用户回了 reject。同一个 requestId 的任何一次挂载都接着这里的阶段走:
 *   none → 记 confirming;confirming → 不再记,重新弹框;submitted → 不弹框,等那一次安装的结局;
 *   结局(outcome)是 signal —— 安装在旧组件里落定、而回审批的是新挂载的那一个,也照样收得到。
 */
type Flight = {
  stage: "none" | "confirming" | "submitted"
  outcome: Accessor<Outcome | undefined>
  setOutcome: (outcome: Outcome) => void
  /** main 已记过 failed(守望者这一侧),重挂载时只重新显示原因、不再记。 */
  failureRecorded: boolean
  finished: boolean
}
const flights = new Map<string, Flight>()
const MAX_FLIGHTS = 64

function flightFor(requestId: string): Flight {
  const known = flights.get(requestId)
  if (known) return known
  const [outcome, setOutcome] = createSignal<Outcome | undefined>(undefined)
  const flight: Flight = { stage: "none", outcome, setOutcome: (next) => void setOutcome(next), failureRecorded: false, finished: false }
  flights.set(requestId, flight)
  while (flights.size > MAX_FLIGHTS) flights.delete(flights.keys().next().value!)
  return flight
}

export function HubInstallWatcher(props: {
  hub: AlphaHubRequest
  server: Accessor<ServerInfo | undefined>
  /** 回审批(once / reject);由 PermissionWatcher 按请求 ID 绑定。 */
  reply: (decision: "once" | "reject") => Promise<unknown>
}) {
  const loc = useLocation()
  const projectDir = () => {
    const r = parseRoute(loc.pathname)
    return r.kind === "session" || r.kind === "directory" ? r.directory : undefined
  }
  const ext = useExtensions(props.server, () => true, projectDir)
  const flight = flightFor(props.hub.requestId)
  /** 提交失败之后框不立刻关:显示原因,用户关框才回 reject(基线 §2.3「框里显示原因」)。 */
  const [failure, setFailure] = createSignal<{ name: string; reason: string } | null>(null)
  let entryName = props.hub.catalogId

  const record = async (input: { stage: "confirming" | "submitted" | "declined" | "failed"; catalogId?: string; reason?: string }) => {
    try {
      return (await extIpc.hubRequestStage({ requestId: props.hub.requestId, ...input })).ok === true
    } catch {
      return false
    }
  }
  const finish = async (decision: "once" | "reject") => {
    if (flight.finished) return
    flight.finished = true
    await props.reply(decision).catch(() => undefined)
  }

  /** 确认之后装的那一下:与定制中心同一组出站,多带 hubRequestId。 */
  const install = async (
    entry: CatalogEntry,
    secrets: Record<string, string> | undefined,
    authorization: AuthorizationConfirmationWire | undefined,
    scope: CatalogInstallScopeChoice | undefined,
    selectedProjectDir: string | undefined,
  ): Promise<CapabilityDiffWire[] | null> => {
    if (flight.stage === "confirming") {
      if (!(await record({ stage: "submitted" }))) {
        flight.setOutcome({ kind: "failed", reason: "the request could not be recorded" })
        return null
      }
      flight.stage = "submitted"
    }
    const res = await dispatch(entry, secrets, authorization, scope, selectedProjectDir)
    if (isAuthzRequired(res)) return res.authorization
    flight.setOutcome(res.ok ? { kind: "committed" } : { kind: "failed", reason: res.reason ?? "install failed" })
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
      const spec = entry.installSpec && entry.installSpec.kind === "mcp" ? entry.installSpec : undefined
      const rc = await ext.checkRuntime(spec?.runtimeDep)
      if (!rc.ok) return { ok: false, reason: t("alpha.ext.runtimeMissing", { tool: rc.missing }) }
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
    if (flight.stage === "confirming") {
      if (!(await record({ stage: "submitted" }))) return { ok: false, reason: "the request could not be recorded" }
      flight.stage = "submitted"
    }
    return ext.installCatalogIntent({ ...intent, hubRequestId: props.hub.requestId })
  }

  const confirm = createInstallConfirm({
    install,
    projectDir,
    installPackage,
    onPackageSettled: async (pending, result) => {
      flight.setOutcome(result?.ok ? { kind: "committed" } : { kind: "failed", reason: (result && !result.ok ? result.reason : undefined) ?? "install failed" })
      return pending.view
    },
  })

  /** 签名包:首驱只取预览(带 hubRequestId;main 对授权暂停不落定),拿到预览才弹包确认框。 */
  const openPackage = async (catalogId: string) => {
    const advisory = await extIpc.advisoryActive().catch(() => ({ ids: [] as string[] }))
    const view = installableCatalogPackages(catalog().packages ?? [], catalog().entries, new Set(advisory.ids)).find((item) => item.catalogId === catalogId)
    if (!view) return false
    const first = await ext.installCatalogIntent({
      catalogId,
      attemptId: `hub-${globalThis.crypto.randomUUID()}`,
      hubRequestId: props.hub.requestId,
    })
    if (!first.ok && "stage" in first && first.stage === "authorize" && "packageAuthorization" in first && first.packageAuthorization) {
      confirm.openPackage({ view, preview: first.packageAuthorization, finish: () => {} })
      return true
    }
    // 没进授权暂停就是落定了(main 已按 hubRequestId 记 committed / failed)
    flight.setOutcome(first.ok ? { kind: "committed" } : { kind: "failed", reason: first.reason ?? "install failed" })
    return true
  }

  onMount(() => {
    void (async () => {
      // 已在途(重挂载):submitted ⇒ 不弹框,等结局;confirming ⇒ 不再记,直接重新弹框。
      if (flight.finished || flight.stage === "submitted") return
      if (flight.stage === "none") {
        if (!(await record({ stage: "confirming", catalogId: props.hub.catalogId }))) return finish("reject")
        flight.stage = "confirming"
      }
      await refreshCatalog()
      const advisory = await extIpc.advisoryActive().catch(() => ({ ids: [] as string[] }))
      const entry = installableCatalogEntries(catalog().entries, new Set(advisory.ids)).find((e) => e.id === props.hub.catalogId)
      if (entry) return confirm.openInstallConfirmation(entry)
      if (await openPackage(props.hub.catalogId)) return
      await record({ stage: "failed", reason: "not in this app's verified catalog" })
      return finish("reject")
    })()
  })

  // 结局(不论落定在哪一次挂载里)⇒ 收尾:committed 回 once;failed 先记(只记一次)再在框里显示原因,用户关框才 reject。
  createEffect(() => {
    const outcome = flight.outcome()
    if (!outcome || flight.finished || failure() !== null) return
    if (outcome.kind === "committed") return void finish("once")
    void (async () => {
      if (!flight.failureRecorded) {
        flight.failureRecorded = true
        await record({ stage: "failed", reason: outcome.reason })
      }
      setFailure({ name: entryName, reason: outcome.reason })
    })()
  })
  // 控制器在**没有结局**时关框 = 用户取消:还在 confirming ⇒ declined;已进授权第二阶段(submitted)⇒ declined 记不上,
  // 记 failed 带原因。有结局的关框由上面那一段收尾。
  let opened = false
  createEffect(() => {
    if (confirm.open()) {
      opened = true
      entryName = confirm.packageAuthz()?.view.presentation.displayName ?? confirm.confirming()?.displayName ?? entryName
      return
    }
    if (!opened || flight.finished || flight.outcome() !== undefined) return
    void (async () => {
      await record(flight.stage === "submitted" ? { stage: "failed", reason: "authorization canceled" } : { stage: "declined" })
      return finish("reject")
    })()
  })

  return (
    <Dialog
      open={confirm.open() || failure() !== null}
      onClose={() => (failure() !== null ? void finish("reject").then(() => setFailure(null)) : confirm.close())}
      dismissible={!confirm.busy()}
      busy={confirm.busy()}
      size="sm"
      title={failure() ? t("alpha.ext.confirmTitle", { name: failure()!.name }) : confirm.title()}
      footer={
        <Show when={failure() !== null} fallback={<InstallConfirmFooter confirm={confirm} />}>
          <Button variant="primary" autofocus onClick={() => void finish("reject").then(() => setFailure(null))}>
            {t("alpha.ext.close")}
          </Button>
        </Show>
      }
    >
      <p class="alpha-ext-confirm-line" data-hub-agent-request={props.hub.requestId}>
        {t("alpha.ext.hubAgentRequested")}
      </p>
      <Show when={failure()} fallback={<InstallConfirmBody confirm={confirm} />}>
        {(failed) => (
          <p class="alpha-ext-key-hint" role="alert" data-hub-agent-failure="">
            {extensionError(failed().reason, "alpha.ext.error.install")}
          </p>
        )}
      </Show>
    </Dialog>
  )
}
