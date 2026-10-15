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
import { installableCatalogEntries } from "../extensions/catalog-installable-view"
import type { CatalogEntry } from "../extensions/catalog-types"
import { extIpc } from "../extensions/ext-ipc"
import { extensionError } from "../extensions/ext-presentation"
import { createInstallConfirm, InstallConfirmBody, InstallConfirmFooter } from "../extensions/install-confirm"
import { isAuthzRequired, useExtensions, type ActionResult, type CatalogInstallScopeChoice } from "../extensions/use-extensions"
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
  let stage: "none" | "confirming" | "submitted" = "none"
  let outcome: Outcome | undefined
  let finished = false
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
    if (finished) return
    finished = true
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
    if (stage === "confirming") {
      if (!(await record({ stage: "submitted" }))) {
        outcome = { kind: "failed", reason: "the request could not be recorded" }
        return null
      }
      stage = "submitted"
    }
    const res = await dispatch(entry, secrets, authorization, scope, selectedProjectDir)
    if (isAuthzRequired(res)) return res.authorization
    outcome = res.ok ? { kind: "committed" } : { kind: "failed", reason: res.reason ?? "install failed" }
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

  const confirm = createInstallConfirm({ install, projectDir })

  onMount(() => {
    void (async () => {
      if (!(await record({ stage: "confirming", catalogId: props.hub.catalogId }))) return finish("reject")
      stage = "confirming"
      await refreshCatalog()
      const advisory = await extIpc.advisoryActive().catch(() => ({ ids: [] as string[] }))
      const entry = installableCatalogEntries(catalog().entries, new Set(advisory.ids)).find((e) => e.id === props.hub.catalogId)
      if (!entry) {
        await record({ stage: "failed", reason: "not in this app's verified catalog" })
        return finish("reject")
      }
      confirm.openInstallConfirmation(entry)
    })()
  })

  // 控制器关框(成功 / 失败 / 取消)⇒ 按这一次的结局收尾。
  let opened = false
  createEffect(() => {
    const open = confirm.confirming()
    if (open) {
      opened = true
      entryName = open.displayName
      return
    }
    if (!opened || finished || failure() !== null) return
    void (async () => {
      if (outcome?.kind === "committed") return finish("once")
      if (outcome?.kind === "failed") {
        await record({ stage: "failed", reason: outcome.reason })
        setFailure({ name: entryName, reason: outcome.reason })
        return
      }
      // 用户取消:还在 confirming ⇒ declined;已进授权第二阶段(submitted)⇒ declined 记不上,记 failed 带原因。
      await record(stage === "submitted" ? { stage: "failed", reason: "authorization canceled" } : { stage: "declined" })
      return finish("reject")
    })()
  })

  return (
    <Dialog
      open={confirm.open() || failure() !== null}
      onClose={() => (failure() !== null ? void finish("reject").then(() => setFailure(null)) : confirm.closeAuthz())}
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
