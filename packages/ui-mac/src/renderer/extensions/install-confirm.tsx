// install-confirm — 定制中心的**安装确认框**与 `#348` capability 授权两阶段控制器。
//
// REQ-234 `#1531`(基线 §2.3):从 extension-hub.tsx 原样抽出,定制中心与 agent 安装守望者(alpha-ui/hub-install-watcher.tsx)
// 共用**同一份** —— agent 请求的安装弹的就是定制中心自己的这个框(同一个条目说明、同一个作用域选择、同一个遮罩密钥输入、
// 同一个授权第二阶段),不是另画一个。两个宿主各建一份控制器实例,区别只在「确认之后装的那一下」(deps.install):
// 定制中心装完自己呈现结果;守望者装的时候带上 hubRequestId,让 main 记下这一次请求的结局。
//
// 状态机(设计稿 D1 + Codex 裁决 D2):
//   idle → confirming-install(确认框)→ driving(confirmBusy)→ authorizing(authz 非空)
//        → redriving(authzBusy)→ success | failure | canceled
//   host="confirm" = 确认框原地切第二阶段(MCP/plugin/bundle);host="standalone" = skill 直装 / 更新扩权时独立弹出。
//   busy(driving / redriving)期间宿主 Dialog 必须 dismissible=false —— IPC 无取消能力,放任关闭 =
//   「用户以为取消,main 已提交」竞态。取消 = 零权威副作用、静默(B11:取消不是失败,不 toast 不行内)。

import { createSignal, For, Show, type Accessor } from "solid-js"
import { t } from "../i18n"
import { projectLabel } from "../sidebar/route"
import { Button } from "../alpha-ui/Button"
import type { AuthorizationConfirmationWire, CapabilityDiffWire } from "../../shared/ext-capability-authorization"
import { catalog } from "./catalog-source"
import type { CatalogEntry } from "./catalog-types"
import { ExtAuthzView, authzIsEscalation, buildAuthzConfirmation } from "./ext-authz"
import { catalogDescription, iconFor, sourceLabel, typeLabel } from "./ext-presentation"
import { catalogInstallTargetFor, DEFAULT_CATALOG_INSTALL_SCOPE, type CatalogInstallScopeChoice } from "./use-extensions"

export type InstallAuthzState = {
  entry: CatalogEntry
  mode: "install" | "update"
  host: "standalone" | "confirm"
  secrets?: Record<string, string>
  scope?: CatalogInstallScopeChoice
  projectDir?: string
  diffs: CapabilityDiffWire[]
}

export type InstallConfirmDeps = {
  /** 首驱与授权后的重驱。返回 authorize 阶段的逐 item diff(控制器原地切授权视图);null = 这一趟已结束(成败由宿主呈现)。 */
  install: (
    entry: CatalogEntry,
    secrets: Record<string, string> | undefined,
    authorization: AuthorizationConfirmationWire | undefined,
    scope: CatalogInstallScopeChoice | undefined,
    projectDir: string | undefined,
  ) => Promise<CapabilityDiffWire[] | null>
  /** 更新扩权的授权重驱(只有定制中心有更新入口)。 */
  update?: (entry: CatalogEntry, authorization: AuthorizationConfirmationWire) => Promise<CapabilityDiffWire[] | null>
  /** 当前路由的项目目录;缺席 =「本项目」作用域不可选。 */
  projectDir: Accessor<string | undefined>
}

export function createInstallConfirm(deps: InstallConfirmDeps) {
  // The entry awaiting install confirmation (MCP/bundle/plugin 档;agent 请求的安装不分类型都经它)。
  const [confirming, setConfirming] = createSignal<CatalogEntry | null>(null)
  // REQ-136:Hub scope is a UX choice, not a path picker. Every fresh confirmation resets Global;
  // project submission resolves the route's current D again inside useExtensions before IPC.
  const [installScope, setInstallScope] = createSignal<CatalogInstallScopeChoice>(DEFAULT_CATALOG_INSTALL_SCOPE)
  const openInstallConfirmation = (entry: CatalogEntry) => {
    setInstallScope(DEFAULT_CATALOG_INSTALL_SCOPE)
    setConfirming(entry)
  }
  // T5:确认弹窗采集的 requiredEnvVars 密钥值(仅内存;安装后清空)。经 addMcp → 主进程 {file:}
  // 通道落盘,绝不明文进 opencode.jsonc。切换/关闭弹窗即重置。
  const [envValues, setEnvValues] = createSignal<Record<string, string>>({})
  const [authz, setAuthz] = createSignal<InstallAuthzState | null>(null)
  const [confirmBusy, setConfirmBusy] = createSignal(false)
  const [authzBusy, setAuthzBusy] = createSignal(false)

  // 授权框动作(两宿主共用)。
  const closeAuthz = () => {
    setAuthz(null)
    setConfirming(null)
    setEnvValues({})
    setInstallScope(DEFAULT_CATALOG_INSTALL_SCOPE)
  }
  const cancelAuthz = () => {
    if (authzBusy() || confirmBusy()) return
    closeAuthz()
  }
  const confirmAuthz = async () => {
    const a = authz()
    if (!a || authzBusy()) return
    const decision = buildAuthzConfirmation(a.diffs)
    setAuthzBusy(true)
    try {
      const next =
        a.mode === "update" && deps.update
          ? await deps.update(a.entry, decision)
          : await deps.install(a.entry, a.secrets, decision, a.scope, a.projectDir)
      // 重驱再遇 authorize(授权与重驱之间 grants/catalog 变化)→ 最新 diff 原地替换,不只拦第一次。
      if (next) {
        setAuthz({ ...a, diffs: next })
        return
      }
      closeAuthz()
    } finally {
      setAuthzBusy(false)
    }
  }
  // 确认框主按钮:#348 两阶段(设计稿 D1)—— await 首驱;stage="authorize" 时同框原地切第二阶段(标题/body/footer
  // 换为授权视图),成功或普通失败才关框;不再点击即关。
  const submitInstall = async () => {
    const e = confirming()
    if (!e || confirmBusy()) return
    const raw = envValues()
    const secretsArg = Object.keys(raw).length ? raw : undefined
    setConfirmBusy(true)
    try {
      const scope = installScope()
      const selectedProjectDir = scope === "project" ? deps.projectDir() : undefined
      const diffs = await deps.install(e, secretsArg, undefined, scope, selectedProjectDir)
      if (diffs) {
        setAuthz({
          entry: e,
          mode: "install",
          host: "confirm",
          secrets: secretsArg,
          scope,
          projectDir: selectedProjectDir,
          diffs,
        })
        return
      }
      closeAuthz()
    } finally {
      setConfirmBusy(false)
    }
  }
  // 标题两宿主共用(Q1 场景化:首装「授权能力/授权并安装」,扩权「能力变更需确认/授权并更新」)。
  const authzTitle = () => {
    const a = authz()
    if (!a) return ""
    return authzIsEscalation(a.diffs) ? t("alpha.ext.authz.titleEscalation") : t("alpha.ext.authz.titleFirst")
  }

  return {
    projectDir: deps.projectDir,
    confirming,
    installScope,
    setInstallScope,
    envValues,
    setEnvValues,
    authz,
    setAuthz,
    confirmBusy,
    authzBusy,
    setAuthzBusy,
    openInstallConfirmation,
    closeAuthz,
    cancelAuthz,
    confirmAuthz,
    submitInstall,
    authzTitle,
    /** 宿主 Dialog 的 open / title(确认框这一半;定制中心另有 package 预览那一半)。 */
    open: () => !!confirming(),
    title: () => (authz()?.host === "confirm" ? authzTitle() : confirming() ? t("alpha.ext.confirmTitle", { name: confirming()!.displayName }) : ""),
    busy: () => confirmBusy() || authzBusy(),
  }
}

export type InstallConfirm = ReturnType<typeof createInstallConfirm>

// Pre-install disclosure for the confirm dialog.
function runtimeDeps(e: CatalogEntry): string {
  const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
  return (spec?.runtimeDep ?? []).join(", ")
}
function requiredEnvVarList(e: CatalogEntry): string[] {
  const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
  return spec?.requiredEnvVars ?? []
}
// Items the confirm dialog lists: a bundle fans out to its referenced entries; everything else is
// just itself. Full-catalog lookup (same source as the Hub's byId).
function confirmItems(e: CatalogEntry): { entry: CatalogEntry; optional: boolean }[] {
  if (e.type === "bundle") {
    return (e.bundleItems ?? [])
      .slice()
      .sort((a, b) => a.installOrder - b.installOrder)
      .map((it) => ({ entry: catalog().entries.find((x) => x.id === it.catalogEntryId), optional: it.optional }))
      .filter((x): x is { entry: CatalogEntry; optional: boolean } => !!x.entry)
  }
  return [{ entry: e, optional: false }]
}

/** 确认框的页脚:授权第二阶段(host=confirm)是「取消 / 授权并安装」,否则是「取消 / 确认安装」。 */
export function InstallConfirmFooter(props: { confirm: InstallConfirm }) {
  const c = props.confirm
  return (
    <Show
      when={c.authz()?.host === "confirm"}
      fallback={
        <>
          <Button variant="ghost" autofocus disabled={c.confirmBusy()} onClick={c.closeAuthz}>
            {t("alpha.ext.cancel")}
          </Button>
          <Button variant="primary" loading={c.confirmBusy()} onClick={() => void c.submitInstall()}>
            {t("alpha.ext.confirmInstall")}
          </Button>
        </>
      }
    >
      <Button variant="ghost" autofocus disabled={c.authzBusy()} onClick={c.cancelAuthz}>
        {t("alpha.ext.cancel")}
      </Button>
      <Button variant="primary" loading={c.authzBusy()} onClick={() => void c.confirmAuthz()}>
        {c.authz()?.mode === "update" ? t("alpha.ext.authz.confirmUpdate") : t("alpha.ext.authz.confirmInstall")}
      </Button>
    </Show>
  )
}

/** 确认框正文:授权第二阶段的授权视图,或条目确认(说明 / 组成 / 作用域 / 风险 / 运行时 / 遮罩密钥输入)。
 *  `paused` 在场且为真时不呈现条目确认(定制中心同一个框正在展示 package 预览)。 */
export function InstallConfirmBody(props: { confirm: InstallConfirm; paused?: Accessor<boolean> }) {
  const c = props.confirm
  return (
    <>
      <Show when={c.authz()?.host === "confirm"}>
        <ExtAuthzView name={c.authz()!.entry.displayName} isBundle={c.authz()!.entry.type === "bundle"} mode={c.authz()!.mode} diffs={c.authz()!.diffs} />
      </Show>
      <Show when={!props.paused?.() && c.authz()?.host !== "confirm" && c.confirming()}>
        {(entry) => (
          <div class="alpha-ext-confirm">
            <div class="alpha-ext-confirm-meta">
              <span class="alpha-ext-chip" data-source={entry().source}>
                {sourceLabel(entry().source)}
              </span>
              <span class="alpha-ext-confirm-type">{typeLabel(entry().type)}</span>
            </div>
            <p class="alpha-ext-confirm-desc">{catalogDescription(entry())}</p>
            <div class="alpha-ext-install-box">
              <For each={confirmItems(entry())}>
                {(it) => {
                  const ic = iconFor(it.entry)
                  return (
                    <div class="alpha-ext-install-row">
                      <span class="alpha-ext-install-ic" style={{ background: ic.color }}>
                        {ic.glyph}
                      </span>
                      <span class="alpha-ext-install-nm">{it.entry.displayName}</span>
                      <Show when={it.optional}>
                        <span class="alpha-ext-install-opt">{t("alpha.ext.optional")}</span>
                      </Show>
                      <span class="alpha-ext-install-k">{typeLabel(it.entry.type)}</span>
                    </div>
                  )
                }}
              </For>
            </div>
            <Show when={entry().type === "mcp"}>
              <fieldset class="alpha-ext-install-scope" data-install-scope="mcp">
                <legend>{t("alpha.ext.installScopeTitle")}</legend>
                <div class="alpha-ext-install-scope-options">
                  <label
                    class="alpha-ext-install-scope-option"
                    data-selected={c.installScope() === "global" ? "" : undefined}
                  >
                    <input
                      type="radio"
                      name="alpha-ext-install-scope"
                      value="global"
                      checked={c.installScope() === "global"}
                      onChange={() => c.setInstallScope("global")}
                    />
                    <span>
                      <b>{t("alpha.ext.installScopeGlobal")}</b>
                      <small>{t("alpha.ext.installScopeGlobalHint")}</small>
                    </span>
                  </label>
                  <Show when={c.projectDir()}>
                    {(dir) => {
                      const projectTarget = () => catalogInstallTargetFor(entry(), "project", dir())
                      return (
                        <label
                          class="alpha-ext-install-scope-option"
                          data-selected={c.installScope() === "project" ? "" : undefined}
                          data-disabled={!projectTarget().ok ? "" : undefined}
                        >
                          <input
                            type="radio"
                            name="alpha-ext-install-scope"
                            value="project"
                            checked={c.installScope() === "project"}
                            disabled={!projectTarget().ok}
                            onChange={() => c.setInstallScope("project")}
                          />
                          <span>
                            <b>{t("alpha.ext.installScopeProject")}</b>
                            <small>
                              {projectTarget().ok
                                ? t("alpha.ext.installScopeProjectHint", { project: projectLabel(dir()) })
                                : t("alpha.ext.installScopeProjectUnavailable")}
                            </small>
                          </span>
                        </label>
                      )
                    }}
                  </Show>
                </div>
              </fieldset>
            </Show>
            <Show when={entry().type === "plugin"}>
              <p class="alpha-ext-confirm-risk">⚠ {t("alpha.ext.pluginRisk")}</p>
            </Show>
            <Show when={runtimeDeps(entry())}>
              <div class="alpha-ext-confirm-line">
                {t("alpha.ext.confirmRuntime")}: <code>{runtimeDeps(entry())}</code>
              </div>
            </Show>
            <Show when={requiredEnvVarList(entry()).length}>
              <div class="alpha-ext-confirm-keys">
                <div class="alpha-ext-confirm-line">{t("alpha.ext.confirmEnv")}</div>
                <For each={requiredEnvVarList(entry())}>
                  {(varName) => (
                    <label class="alpha-ext-key-field">
                      <span class="alpha-ext-key-name">{varName}</span>
                      <input
                        class="alpha-ext-key-input"
                        type="password"
                        autocomplete="off"
                        spellcheck={false}
                        placeholder={t("alpha.ext.keyPlaceholder")}
                        value={c.envValues()[varName] ?? ""}
                        onInput={(ev) => c.setEnvValues((prev) => ({ ...prev, [varName]: ev.currentTarget.value }))}
                      />
                    </label>
                  )}
                </For>
                <p class="alpha-ext-key-hint">{t("alpha.ext.keyHint")}</p>
              </div>
            </Show>
            <p class="alpha-ext-confirm-note">
              {entry().type === "mcp"
                ? t(
                    c.installScope() === "project"
                      ? "alpha.ext.confirmNoteProjectMcp"
                      : "alpha.ext.confirmNoteGlobalMcp",
                  )
                : t("alpha.ext.confirmNote")}
            </p>
          </div>
        )}
      </Show>
    </>
  )
}
