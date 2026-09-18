// REQ-131 / #1130 —— Settings「工具」节:按来源分组的工具三态策略面。
// 视觉与交互基线:docs/design/2026-08-25-req131-settings-tool-policy(approved,§3 数据映射 / §4 交互规范);
// 活稿锚 docs/design/current/settings/design.html#set-tools。
//
// 这一面只消费引擎的 live inventory(#1129 `AlphaToolInventory.list()` 经 #1130 的 HTTP 出口 → main → IPC),
// 不建第二份工具名单、不做任何授权判决:
//   · 三态 radiogroup 显示的是**用户 override**(无记录 = 无选中);
//   · 「生效」徽标是 resolver 终值,「生效:…」小字是原因(9 型 reason 逐型文案,一型不落);
//   · 三者可以不一致(record=enabled 而 binding 变了 ⇒ 徽标是每次询问),这正是要让用户看见的。
// 逐条即写、无草稿、无整页保存键:每次写完重读 inventory,控件永远显示权威值;写失败不做乐观更新,
// 只给 role=alert + 重试(§4「写失败 ⇒ 回退到权威值」的实现就是「从不离开权威值」)。
// 收紧畅通,放宽有闸:询问 / 停用一点即存;class / service 层「启用」先弹行内确认(broad intent 明示
// 未来成员),service / tool 层的启用写入携带 inventory 给出的**当前** bindingDigest,class 层不带 ——
// 这条由 wire schema 在引擎侧再执行一次(400),本文件不是最后一道。
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import type {
  EffectiveToolPolicyV1,
  ToolClass,
  ToolPolicyApi,
  ToolPolicyInventoryServiceV1,
  ToolPolicyInventoryToolV1,
  ToolPolicyInventoryV1,
  ToolPolicyReadFailureCode,
  ToolPolicyRecord,
  ToolPolicySelector,
  ToolPolicyState,
  ToolPolicyWriteFailureCode,
  ToolPolicyWriteResult,
} from "../../shared/tool-policy-wire"
import { Button } from "./Button"
import { rovingKey, rovingTabIndex } from "./roving-focus"
import { t } from "../i18n"

const CLASS_ORDER: readonly ToolClass[] = ["builtin", "alpha-cloud", "third-party-mcp", "plugin"]
const STATES: readonly ToolPolicyState[] = ["enabled", "ask", "disabled"]

const classLabel = (cls: ToolClass) => {
  if (cls === "builtin") return t("alpha.settings.toolsClassBuiltin")
  if (cls === "alpha-cloud") return t("alpha.settings.toolsClassCloud")
  if (cls === "third-party-mcp") return t("alpha.settings.toolsClassMcp")
  return t("alpha.settings.toolsClassPlugin")
}
const classCaption = (cls: ToolClass) => {
  if (cls === "builtin") return t("alpha.settings.toolsCapBuiltin")
  if (cls === "alpha-cloud") return t("alpha.settings.toolsCapCloud")
  if (cls === "third-party-mcp") return t("alpha.settings.toolsCapMcp")
  return t("alpha.settings.toolsCapPlugin")
}
const stateLabel = (state: ToolPolicyState) => {
  if (state === "enabled") return t("alpha.settings.toolsStateEnabled")
  if (state === "ask") return t("alpha.settings.toolsStateAsk")
  return t("alpha.settings.toolsStateDisabled")
}
const effectiveLabel = (state: ToolPolicyState) => {
  if (state === "enabled") return t("alpha.settings.toolsEffectiveEnabled")
  if (state === "ask") return t("alpha.settings.toolsEffectiveAsk")
  return t("alpha.settings.toolsEffectiveDisabled")
}

/** 9 型 reason 逐型文案(exhaustive switch:resolver 加第 10 型,这里当场红)。 */
function reasonCopy(reason: EffectiveToolPolicyV1["reason"]): string {
  switch (reason.kind) {
    case "default":
      return reason.class === "builtin"
        ? t("alpha.settings.toolsReasonDefaultBuiltin")
        : t("alpha.settings.toolsReasonDefault")
    case "user":
      if (reason.level === "class") return t("alpha.settings.toolsReasonUserClass")
      if (reason.level === "service") return t("alpha.settings.toolsReasonUserService")
      return t("alpha.settings.toolsReasonUserTool")
    case "binding-changed":
      return t("alpha.settings.toolsReasonBindingChanged")
    case "cap-managed":
      return t("alpha.settings.toolsReasonManaged")
    case "cap-managed-unreadable":
      return t("alpha.settings.toolsReasonManagedUnreadable")
    case "cap-entitlement":
      return t("alpha.settings.toolsReasonEntitlement")
    case "cap-hard-deny":
      return t("alpha.settings.toolsReasonHardDeny")
    case "quarantine":
      return t("alpha.settings.toolsReasonQuarantine")
    case "invalid-identity":
      return t("alpha.settings.toolsReasonInvalid")
  }
}

/** cap 永远压住用户层:这些原因下控件锁定(§4)。 */
function lockedBy(reason: EffectiveToolPolicyV1["reason"]) {
  return (
    reason.kind === "cap-managed" ||
    reason.kind === "cap-managed-unreadable" ||
    reason.kind === "cap-entitlement" ||
    reason.kind === "cap-hard-deny" ||
    reason.kind === "quarantine" ||
    reason.kind === "invalid-identity"
  )
}

/** UI 侧的行键(只用于 pending / failure / confirm / 折叠状态的索引,不是策略 selector 的匹配)。 */
function keyOf(selector: ToolPolicySelector): string {
  if (selector.level === "class") return `class:${selector.class}`
  if (selector.level === "service") return `service:${selector.source}:${selector.origin}`
  return `tool:${selector.canonical}`
}
const serviceSelector = (service: ToolPolicyInventoryServiceV1): ToolPolicySelector => ({
  level: "service",
  source: service.source,
  origin: service.origin,
})
const shortDigest = (digest: string | undefined) =>
  digest ? `${digest.slice(0, 11)}…${digest.slice(-4)}` : t("alpha.settings.toolsDevNoBinding")

type LoadState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "failed"; code: ToolPolicyReadFailureCode }

type Failure = { code: ToolPolicyWriteFailureCode; retry: () => void }
type Confirm = { key: string; level: "class" | "service"; record: ToolPolicyRecord }
type Group = {
  cls: ToolClass
  services: ToolPolicyInventoryServiceV1[]
  record: ToolPolicyRecord | undefined
  toolCount: number
  verified: boolean
}

export function AlphaSettingsTools(props: {
  open: boolean
  active: boolean
  directory: string | undefined
  api: ToolPolicyApi
}) {
  const [load, setLoad] = createSignal<LoadState>({ state: "idle" })
  const [inventory, setInventory] = createSignal<ToolPolicyInventoryV1 | null>(null)
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  const [failures, setFailures] = createSignal<ReadonlyMap<string, Failure>>(new Map())
  const [confirm, setConfirm] = createSignal<Confirm | null>(null)
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const [live, setLive] = createSignal("")
  const [resetting, setResetting] = createSignal(false)
  let run = 0
  let loadedFor: string | undefined
  let alertToFocus: HTMLElement | undefined
  let banner: HTMLDivElement | undefined
  let bannerFocused = false

  const reload = (silent: boolean) => {
    const directory = props.directory
    if (!directory) return
    const current = ++run
    if (!silent) setLoad({ state: "loading" })
    void props.api.inventory({ directory }).then(
      (result) => {
        if (current !== run || !props.open) return
        if (result.ok) {
          setInventory(result.inventory)
          setLoad({ state: "ready" })
          return
        }
        setInventory(null)
        setLoad({ state: "failed", code: result.code })
      },
      () => {
        if (current !== run || !props.open) return
        setInventory(null)
        setLoad({ state: "failed", code: "request-failed" })
      },
    )
  }

  // 首次进入本节(或项目目录变了)才读;关闭整页时作废在途读取,下次打开重读。
  createEffect(
    on(
      () => [props.open, props.active, props.directory] as const,
      ([open, active, directory]) => {
        if (!open) {
          run += 1
          loadedFor = undefined
          setInventory(null)
          setLoad({ state: "idle" })
          setFailures(new Map())
          setConfirm(null)
          setCollapsed(new Set<string>())
          bannerFocused = false
          return
        }
        if (!active) return
        if (!directory) {
          loadedFor = undefined
          setInventory(null)
          setLoad({ state: "idle" })
          return
        }
        if (loadedFor === directory) return
        loadedFor = directory
        setFailures(new Map())
        setConfirm(null)
        setCollapsed(new Set<string>())
        bannerFocused = false
        reload(false)
      },
    ),
  )

  const quarantined = () => inventory()?.user.status === "quarantined"
  const managedUnreadable = () => inventory()?.managed.status === "unreadable"
  const readOnly = () => quarantined() || managedUnreadable() || resetting()

  // 损坏 / 管理策略不可读:整节横幅接管焦点(一次)。
  createEffect(() => {
    if (!(quarantined() || managedUnreadable()) || bannerFocused) return
    bannerFocused = true
    queueMicrotask(() => banner?.focus())
  })
  createEffect(() => {
    if (!quarantined() && !managedUnreadable()) bannerFocused = false
  })

  onCleanup(() => {
    run += 1
  })

  const groups = createMemo((): Group[] => {
    const inv = inventory()
    if (!inv) return []
    return CLASS_ORDER.map((cls) => {
      const services = inv.services.filter((service) => service.class === cls)
      const record = inv.classRecords.find((item) => item.selector.level === "class" && item.selector.class === cls)
      return {
        cls,
        services,
        record,
        toolCount: services.reduce((sum, service) => sum + service.tools.length, 0),
        verified: services.length > 0 && services.every((service) => service.authority.kind === "alpha-cloud"),
      }
    })
  })

  const isPending = (key: string) => pending().has(key)
  const failureFor = (key: string) => failures().get(key)

  const write = (key: string, op: () => Promise<ToolPolicyWriteResult>) => {
    if (isPending(key) || readOnly()) return
    const attempt = () => {
      setFailures((current) => {
        const next = new Map(current)
        next.delete(key)
        return next
      })
      setPending((current) => new Set(current).add(key))
      setLive("")
      void op()
        .then(
          (result) => result,
          (): ToolPolicyWriteResult => ({ ok: false, code: "request-failed" }),
        )
        .then((result) => {
          setPending((current) => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
          if (!props.open) return
          if (result.ok) {
            setLive(t("alpha.settings.toolsSaved"))
            reload(true)
            return
          }
          setFailures((current) => new Map(current).set(key, { code: result.code, retry: attempt }))
          // 409 = 文档在我们读完清单之后进了 quarantine:横幅与「重置」只在 inventory 说 quarantined 时才渲染,
          // 不重读的话提示「先在上方重置」而上方没有按钮 —— 重读让横幅出现,重试才有路可走。
          if (result.code === "quarantined") reload(true)
          queueMicrotask(() => alertToFocus?.focus())
        })
    }
    attempt()
  }

  const directoryOrEmpty = () => props.directory ?? ""
  const setRecord = (record: ToolPolicyRecord) =>
    write(keyOf(record.selector), () => props.api.setRecord({ directory: directoryOrEmpty(), record }))
  const removeRecord = (selector: ToolPolicySelector) =>
    write(keyOf(selector), () => props.api.removeRecord({ directory: directoryOrEmpty(), selector }))

  /**
   * 三态点选(§4):收紧一点即存;class / service 层启用先确认;service / tool 层启用带当前 digest。
   * 没有可核验的 digest 时「启用」按钮本身是禁用的(见 Tri),这里不再判。
   */
  const pick = (selector: ToolPolicySelector, state: ToolPolicyState, digest: string | undefined, current?: ToolPolicyState) => {
    setConfirm(null)
    if (state === current) return
    if (state !== "enabled") {
      setRecord({ selector, state })
      return
    }
    if (selector.level === "class") {
      setConfirm({ key: keyOf(selector), level: "class", record: { selector, state } })
      return
    }
    if (digest === undefined) return
    const record: ToolPolicyRecord = { selector, state, bindingDigest: digest }
    if (selector.level === "service") {
      setConfirm({ key: keyOf(selector), level: "service", record })
      return
    }
    setRecord(record)
  }

  const reset = () => {
    const directory = props.directory
    if (!directory || resetting()) return
    setResetting(true)
    setLive("")
    void props.api
      .reset({ directory })
      .then(
        (result) => result,
        () => ({ ok: false as const, code: "request-failed" as const }),
      )
      .then((result) => {
        setResetting(false)
        if (!props.open) return
        if (result.ok) {
          setLive(t("alpha.settings.toolsSaved"))
          reload(true)
          return
        }
        setFailures((current) => new Map(current).set("reset", { code: result.code, retry: reset }))
        queueMicrotask(() => alertToFocus?.focus())
      })
  }

  const toggleService = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  // 默认:每组第一个服务展开,其余折叠(与帧一致);用户点过之后按点的来。
  const expanded = (service: ToolPolicyInventoryServiceV1, index: number) => {
    const key = keyOf(serviceSelector(service))
    return collapsed().has(key) ? index !== 0 : index === 0
  }

  const loadTitle = (code: ToolPolicyReadFailureCode) => {
    if (code === "engine-unavailable") return t("alpha.settings.toolsLoadEngine")
    if (code === "not-wired") return t("alpha.settings.toolsLoadNotWired")
    return t("alpha.settings.toolsLoadFailed")
  }
  const failureDetail = (failure: Failure) =>
    failure.code === "quarantined"
      ? t("alpha.settings.toolsSaveFailedQuarantined")
      : t("alpha.settings.toolsSaveFailedDetail")

  // ── 子组件 ─────────────────────────────────────────────────────────────────
  // 三态 radiogroup 的方向键走全 alpha-ui 唯一的 roving-focus 实现(C21 AC2 棘轮):
  // `radio` 键表 = →↓ 下一项、←↑ 上一项;Tab 进出整组一次。
  // 但**移动只移动焦点,不写入**(已批帧:「左右键切换、空格确认」)—— 这是放宽权限的路径
  // (询问 → 启用),方向键不该在无确认下改动长期策略;空格 / 回车落在原生 <button> 上才走 pick。
  const Tri = (tri: {
    label: string
    value: ToolPolicyState | undefined
    disabled: boolean
    enableBlocked: boolean
    busy: boolean
    attr: "data-tools-radio" | "data-tools-class-radio"
    onPick: (state: ToolPolicyState) => void
  }) => {
    let group: HTMLDivElement | undefined
    const selectable = () =>
      tri.disabled || tri.busy ? [] : STATES.filter((state) => !(state === "enabled" && tri.enableBlocked))
    const focusState = (state: ToolPolicyState) =>
      group?.querySelector<HTMLButtonElement>(`button[${tri.attr}="${state}"]`)?.focus()
    // 方向键相对**此刻聚焦**的那一项移动(不是相对记录值 —— 否则连按两次会卡在同一项)。
    const focused = (): ToolPolicyState | undefined => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement) || !group?.contains(element)) return tri.value
      return (element.getAttribute(tri.attr) as ToolPolicyState | null) ?? tri.value
    }
    // Tab 落点:有记录落在选中项;无记录落在第一个可选项(无选中 = 无记录,不是「默认选中启用」)。
    const active = () => tri.value ?? selectable()[0]
    return (
      <div
        ref={(element) => (group = element)}
        class="alpha-tools-seg"
        role="radiogroup"
        aria-label={tri.label}
        aria-disabled={tri.disabled ? "true" : undefined}
        aria-busy={tri.busy ? "true" : undefined}
        onKeyDown={(event) =>
          rovingKey(event, "radio", selectable(), focused(), focusState)
        }
      >
        <For each={STATES}>
          {(state) => (
            <button
              type="button"
              role="radio"
              aria-checked={tri.value === state ? "true" : "false"}
              tabIndex={rovingTabIndex(active() === state)}
              disabled={tri.disabled || tri.busy || (state === "enabled" && tri.enableBlocked)}
              title={state === "enabled" && tri.enableBlocked && !tri.disabled ? t("alpha.settings.toolsNoBinding") : undefined}
              {...{ [tri.attr]: state }}
              onClick={() => tri.onPick(state)}
            >
              {stateLabel(state)}
            </button>
          )}
        </For>
      </div>
    )
  }

  const Lock = () => (
    <span class="alpha-tools-lock" role="img" aria-label={t("alpha.settings.toolsLocked")}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </span>
  )

  const Clear = (clear: { selector: ToolPolicySelector }) => (
    <button
      type="button"
      class="alpha-tools-clear"
      data-tools-clear
      title={t("alpha.settings.toolsInherit")}
      aria-label={t("alpha.settings.toolsInherit")}
      disabled={readOnly() || isPending(keyOf(clear.selector))}
      onClick={() => {
        setConfirm(null)
        removeRecord(clear.selector)
      }}
    >
      ↺
    </button>
  )

  const RowAlert = (alert: { failureKey: string }) => (
    <Show when={failureFor(alert.failureKey)}>
      {(failure) => (
        <div
          ref={(element) => (alertToFocus = element)}
          class="alpha-tools-alert"
          role="alert"
          tabIndex={-1}
          data-tools-row-alert
        >
          <span class="alpha-tools-dot" aria-hidden="true" />
          <div>
            <b>{t("alpha.settings.toolsSaveFailed")}</b>
            {failureDetail(failure())}
            <div class="alpha-tools-act">
              <Button size="sm" data-tools-retry onClick={() => failure().retry()}>
                {t("alpha.common.retry")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Show>
  )

  const ConfirmBar = (bar: { forKey: string }) => (
    <Show when={confirm()?.key === bar.forKey ? confirm() : null}>
      {(item) => (
        <div
          class="alpha-tools-confirm"
          role="alertdialog"
          aria-label={
            item().level === "class"
              ? t("alpha.settings.toolsConfirmClassTitle")
              : t("alpha.settings.toolsConfirmServiceTitle")
          }
          data-tools-confirm
        >
          <span>
            <b>
              {item().level === "class"
                ? t("alpha.settings.toolsConfirmClassTitle")
                : t("alpha.settings.toolsConfirmServiceTitle")}
            </b>{" "}
            {item().level === "class"
              ? t("alpha.settings.toolsConfirmClassDetail")
              : t("alpha.settings.toolsConfirmServiceDetail")}
          </span>
          <span class="alpha-tools-sp" />
          <Button
            size="sm"
            variant="primary"
            data-tools-confirm-accept
            onClick={() => {
              const record = item().record
              setConfirm(null)
              setRecord(record)
            }}
          >
            {t("alpha.settings.toolsConfirm")}
          </Button>
          <Button size="sm" variant="ghost" data-tools-cancel onClick={() => setConfirm(null)}>
            {t("alpha.settings.toolsCancel")}
          </Button>
        </div>
      )}
    </Show>
  )

  const DevDetails = (dev: { tools: readonly ToolPolicyInventoryToolV1[] }) => (
    <details class="alpha-tools-dev" data-tools-dev>
      <summary>{t("alpha.settings.toolsDevDetails")}</summary>
      <div>
        <For each={dev.tools}>
          {(item) => (
            <div>
              {item.canonical} · {item.technicalId} · {t("alpha.settings.toolsDevBinding", { digest: shortDigest(item.bindingDigest) })}
            </div>
          )}
        </For>
      </div>
    </details>
  )

  const ToolRow = (tr: { tool: ToolPolicyInventoryToolV1; cls: ToolClass }) => {
    const selector = (): ToolPolicySelector => ({ level: "tool", canonical: tr.tool.canonical })
    const key = () => keyOf(selector())
    const reason = () => tr.tool.effective.reason
    const locked = () => lockedBy(reason())
    const rebind = () => reason().kind === "binding-changed"
    // 失效的记录在哪一层:tool 层 ⇒ 本行给「重新启用」;service 层 ⇒ 服务行给,本行只显示原因。
    const rebindLevel = () => {
      const r = reason()
      return r.kind === "binding-changed" ? r.level : undefined
    }
    const billing = () =>
      tr.cls === "alpha-cloud" || tr.cls === "third-party-mcp"
        ? t("alpha.settings.toolsBilling", { value: tr.tool.billing?.class ?? t("alpha.settings.toolsBillingUnknown") })
        : undefined
    // 重新启用:以**当前** digest 重写 enabled 记录,层级 = 失效的那条记录所在层(§3)。
    const reenable = () => {
      const r = reason()
      if (r.kind !== "binding-changed") return
      const digest = tr.tool.bindingDigest
      if (digest === undefined) return
      if (r.level === "tool") setRecord({ selector: selector(), state: "enabled", bindingDigest: digest })
    }
    return (
      <>
        <div class="alpha-tools-row" data-tools-row={tr.tool.canonical}>
          <div class="alpha-tools-meta">
            <div class="alpha-tools-name">
              <b>{tr.tool.identity.name}</b>
              <Show when={tr.tool.newlyDiscovered}>
                <span class="alpha-tools-badge new">{t("alpha.settings.toolsNew")}</span>
              </Show>
              <Show when={billing()}>{(value) => <span class="alpha-tools-badge">{value()}</span>}</Show>
            </div>
            <small>
              {t("alpha.settings.toolsEffective", {
                state: effectiveLabel(tr.tool.effective.state),
                reason: reasonCopy(reason()),
              })}
            </small>
          </div>
          <span class={`alpha-tools-eff ${tr.tool.effective.state}`}>
            <i aria-hidden="true" />
            {effectiveLabel(tr.tool.effective.state)}
          </span>
          <Show when={locked()}>
            <Lock />
          </Show>
          <Show
            when={!rebind()}
            fallback={
              <Show when={rebindLevel() === "tool"}>
                <Button
                  size="sm"
                  data-tools-reenable
                  disabled={readOnly() || isPending(key()) || tr.tool.bindingDigest === undefined}
                  onClick={reenable}
                >
                  {t("alpha.settings.toolsReenable")}
                </Button>
              </Show>
            }
          >
            <Tri
              label={tr.tool.identity.name}
              value={tr.tool.record?.state}
              disabled={locked() || readOnly()}
              enableBlocked={tr.tool.bindingDigest === undefined}
              busy={isPending(key())}
              attr="data-tools-radio"
              onPick={(state) => pick(selector(), state, tr.tool.bindingDigest, tr.tool.record?.state)}
            />
          </Show>
          <Show when={tr.tool.record && !locked()}>
            <Clear selector={selector()} />
          </Show>
        </div>
        <RowAlert failureKey={key()} />
      </>
    )
  }

  const ServiceRow = (sr: { service: ToolPolicyInventoryServiceV1; index: number; group: Group }) => {
    const selector = () => serviceSelector(sr.service)
    const key = () => keyOf(selector())
    const open = () => expanded(sr.service, sr.index)
    const rebind = () =>
      sr.service.tools.some(
        (item) => item.effective.reason.kind === "binding-changed" && item.effective.reason.level === "service",
      )
    const newCount = () => sr.service.tools.filter((item) => item.newlyDiscovered).length
    const inherited = () => {
      if (sr.service.record) return t("alpha.settings.toolsInheritedUser")
      if (sr.group.record) return t("alpha.settings.toolsInheritedUser")
      return sr.group.cls === "builtin"
        ? t("alpha.settings.toolsInheritedDefaultEnabled")
        : t("alpha.settings.toolsInheritedDefaultAsk")
    }
    const summary = () => {
      const parts = [t("alpha.settings.toolsServiceSummary", { count: sr.service.tools.length })]
      if (sr.group.cls === "alpha-cloud" || sr.group.cls === "third-party-mcp") {
        const billed = sr.service.tools.find((item) => item.billing)?.billing?.class
        parts.push(t("alpha.settings.toolsBilling", { value: billed ?? t("alpha.settings.toolsBillingUnknown") }))
      }
      parts.push(t("alpha.settings.toolsInherited", { value: inherited() }))
      return parts.join(" · ")
    }
    // 服务层「重新启用」:失效的是 service 层记录 ⇒ 以服务当前 digest 重写。
    const reenable = () => {
      const digest = sr.service.bindingDigest
      if (digest === undefined) return
      setRecord({ selector: selector(), state: "enabled", bindingDigest: digest })
    }
    return (
      <>
        <div class="alpha-tools-row alpha-tools-service" data-tools-service={`${sr.service.source}:${sr.service.origin}`}>
          <button
            type="button"
            class="alpha-tools-exp"
            data-tools-expand
            aria-expanded={open() ? "true" : "false"}
            aria-label={
              open()
                ? t("alpha.settings.toolsCollapse", { name: sr.service.origin })
                : t("alpha.settings.toolsExpand", { name: sr.service.origin })
            }
            onClick={() => toggleService(key())}
          >
            {open() ? "▾" : "▸"}
          </button>
          <div class="alpha-tools-meta">
            <div class="alpha-tools-name">
              <b>{sr.service.origin}</b>
              <Show when={sr.service.authority.kind === "alpha-cloud"}>
                <span class="alpha-tools-badge cloud">{t("alpha.settings.toolsVerified")}</span>
              </Show>
              <Show when={rebind()}>
                <span class="alpha-tools-badge warn">{t("alpha.settings.toolsChanged")}</span>
              </Show>
              <Show when={newCount() > 0}>
                <span class="alpha-tools-badge new">{t("alpha.settings.toolsNewCount", { count: newCount() })}</span>
              </Show>
            </div>
            <small>{rebind() ? t("alpha.settings.toolsChangedDetail") : summary()}</small>
          </div>
          <Show
            when={!rebind()}
            fallback={
              <Button
                size="sm"
                data-tools-reenable
                disabled={readOnly() || isPending(key()) || sr.service.bindingDigest === undefined}
                onClick={reenable}
              >
                {t("alpha.settings.toolsReenable")}
              </Button>
            }
          >
            <Tri
              label={t("alpha.settings.toolsServiceLabel", { name: sr.service.origin })}
              value={sr.service.record?.state}
              disabled={readOnly()}
              enableBlocked={sr.service.bindingDigest === undefined}
              busy={isPending(key())}
              attr="data-tools-radio"
              onPick={(state) => pick(selector(), state, sr.service.bindingDigest, sr.service.record?.state)}
            />
          </Show>
          <Show when={sr.service.record}>
            <Clear selector={selector()} />
          </Show>
        </div>
        <ConfirmBar forKey={key()} />
        <RowAlert failureKey={key()} />
        <Show when={open()}>
          <div class="alpha-tools-svc-tools">
            <For each={sr.service.tools}>{(item) => <ToolRow tool={item} cls={sr.group.cls} />}</For>
            <DevDetails tools={sr.service.tools} />
          </div>
        </Show>
      </>
    )
  }

  return (
    <>
      <div class="alpha-settings-section-head">
        <div>
          <h2>{t("alpha.settings.tools")}</h2>
          <p>{load().state === "loading" ? t("alpha.settings.toolsLoading") : t("alpha.settings.toolsDetail")}</p>
        </div>
      </div>
      <div class="alpha-tools-live" data-tools-live role="status" aria-live="polite">
        {live()}
      </div>

      <Show when={!props.directory}>
        <div class="alpha-tools-banner" role="status" data-tools-state="no-project">
          <span class="alpha-tools-dot" aria-hidden="true" />
          <div>
            <b>{t("alpha.settings.toolsNoProject")}</b>
            <p>{t("alpha.settings.toolsNoProjectDetail")}</p>
          </div>
        </div>
      </Show>

      <Show when={props.directory && load().state === "loading"}>
        <div class="alpha-tools-group" data-tools-state="loading" aria-busy="true">
          <div class="alpha-tools-group-head">
            <div class="alpha-tools-skel" style={{ width: "90px" }} />
          </div>
          <div class="alpha-tools-card">
            <div class="alpha-tools-row">
              <div class="alpha-tools-meta">
                <div class="alpha-tools-skel" style={{ width: "140px" }} />
                <div class="alpha-tools-skel" style={{ width: "220px", "margin-top": "7px", height: "9px" }} />
              </div>
              <div class="alpha-tools-skel" style={{ width: "130px", height: "24px" }} />
            </div>
            <div class="alpha-tools-row">
              <div class="alpha-tools-meta">
                <div class="alpha-tools-skel" style={{ width: "110px" }} />
                <div class="alpha-tools-skel" style={{ width: "180px", "margin-top": "7px", height: "9px" }} />
              </div>
              <div class="alpha-tools-skel" style={{ width: "130px", height: "24px" }} />
            </div>
          </div>
        </div>
      </Show>

      <Show when={load().state === "failed" ? load() : null}>
        {(failed) => (
          <div class="alpha-tools-banner err" role="alert" tabIndex={-1} data-tools-state="failed">
            <span class="alpha-tools-dot" aria-hidden="true" />
            <div>
              <b>{loadTitle((failed() as { code: ToolPolicyReadFailureCode }).code)}</b>
              <p>{t("alpha.settings.toolsLoadFailedDetail")}</p>
              <div class="alpha-tools-act">
                <Button size="sm" data-tools-retry onClick={() => reload(false)}>
                  {t("alpha.common.retry")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={load().state === "ready" && inventory()}>
        {(inv) => (
          <div data-tools-state="ready">
            <Show when={quarantined()}>
              <div
                ref={(element) => (banner = element)}
                class="alpha-tools-banner err"
                role="alert"
                tabIndex={-1}
                data-tools-banner="quarantine"
              >
                <span class="alpha-tools-dot" aria-hidden="true" />
                <div>
                  <b>{t("alpha.settings.toolsQuarantineTitle")}</b>
                  <p>{t("alpha.settings.toolsQuarantineDetail")}</p>
                  <div class="alpha-tools-act">
                    <Button size="sm" variant="primary" data-tools-reset loading={resetting()} onClick={reset}>
                      {t("alpha.settings.toolsReset")}
                    </Button>
                    <small>{t("alpha.settings.toolsResetNote")}</small>
                  </div>
                  <Show when={failureFor("reset")}>
                    {(failure) => (
                      <div ref={(element) => (alertToFocus = element)} class="alpha-tools-act" role="alert" tabIndex={-1} data-tools-row-alert>
                        <span>{t("alpha.settings.toolsSaveFailed")}</span>
                        <Button size="sm" data-tools-retry onClick={() => failure().retry()}>
                          {t("alpha.common.retry")}
                        </Button>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={!quarantined() && managedUnreadable()}>
              <div
                ref={(element) => (banner = element)}
                class="alpha-tools-banner"
                role="alert"
                tabIndex={-1}
                data-tools-banner="managed-unreadable"
              >
                <span class="alpha-tools-dot" aria-hidden="true" />
                <div>
                  <b>{t("alpha.settings.toolsManagedUnreadableTitle")}</b>
                  <p>{t("alpha.settings.toolsManagedUnreadableDetail")}</p>
                </div>
              </div>
            </Show>

            {/* 整节只读时用 inert(而不是 aria-hidden):展开钮与 <details> summary 本身不是 disabled,
                aria-hidden 只把它们从无障碍树里藏起来却仍可 Tab 到 —— 读屏用户会落在一个不宣告的控件上。 */}
            <div class={readOnly() ? "alpha-tools-dim" : undefined} inert={readOnly() ? true : undefined}>
              <For each={groups()}>
                {(group) => (
                  <div class="alpha-tools-group" data-tools-class={group.cls}>
                    <div class="alpha-tools-group-head">
                      <h3>{classLabel(group.cls)}</h3>
                      <span class="alpha-tools-n">
                        {group.cls === "builtin"
                          ? t("alpha.settings.toolsCountItems", { count: group.toolCount })
                          : group.cls === "plugin"
                            ? t("alpha.settings.toolsCountSources", { services: group.services.length, count: group.toolCount })
                            : t("alpha.settings.toolsCountServices", { services: group.services.length, count: group.toolCount })}
                      </span>
                      <Show when={group.verified}>
                        <span class="alpha-tools-badge cloud">{t("alpha.settings.toolsVerified")}</span>
                      </Show>
                      <span class="alpha-tools-sp" />
                      <Tri
                        label={t("alpha.settings.toolsGroupLabel", { name: classLabel(group.cls) })}
                        value={group.record?.state}
                        disabled={readOnly()}
                        enableBlocked={false}
                        busy={isPending(`class:${group.cls}`)}
                        attr="data-tools-class-radio"
                        onPick={(state) =>
                          pick({ level: "class", class: group.cls }, state, undefined, group.record?.state)
                        }
                      />
                      <Show when={group.record}>
                        <Clear selector={{ level: "class", class: group.cls }} />
                      </Show>
                    </div>
                    <ConfirmBar forKey={`class:${group.cls}`} />
                    <RowAlert failureKey={`class:${group.cls}`} />
                    <p class="alpha-tools-group-cap">{classCaption(group.cls)}</p>
                    <Show when={group.services.length > 0}>
                      <div class="alpha-tools-card">
                        <Show
                          when={group.cls !== "builtin"}
                          fallback={
                            <>
                              <For each={group.services.flatMap((service) => service.tools)}>
                                {(item) => <ToolRow tool={item} cls={group.cls} />}
                              </For>
                              <DevDetails tools={group.services.flatMap((service) => service.tools)} />
                            </>
                          }
                        >
                          <For each={group.services}>
                            {(service, index) => <ServiceRow service={service} index={index()} group={group} />}
                          </For>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )}
              </For>

              <Show when={inv().invalid.count > 0}>
                <div class="alpha-tools-degraded" data-tools-invalid>
                  <span aria-hidden="true">◌</span>
                  <span>{t("alpha.settings.toolsInvalidCount", { count: inv().invalid.count })}</span>
                  <details class="alpha-tools-dev" data-tools-dev>
                    <summary>{t("alpha.settings.toolsDevDetails")}</summary>
                    <div>
                      <For each={inv().invalid.entries}>
                        {(entry) => (
                          <div>
                            {entry.technicalId} · {entry.detail}
                          </div>
                        )}
                      </For>
                    </div>
                  </details>
                </div>
              </Show>
            </div>

            <p class="alpha-tools-foot">{t("alpha.settings.toolsFooter")}</p>
          </div>
        )}
      </Show>
    </>
  )
}
