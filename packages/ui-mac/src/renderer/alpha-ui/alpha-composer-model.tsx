// ModelPickPop — canonical Alpha composer model picker. It owns the visible IA and talks only to the
// generated SDK v2 model contract; no upstream picker DOM is mounted, hidden, observed, or clicked.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { AccountSummary, AuthState } from "../../preload/types"
import type { EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import { ALPHA_PATHS } from "../../shared/alpha-config"
import { useAlphaEndpoints } from "../use-alpha-endpoints"
import { composerModelSuspended, type ComposerModel, type SuspendReason } from "./composer-state"
import { ENGINE_FETCH_TIMEOUT_MS, nextEngineRetryDelay } from "./model-picker-logic"
import type { ModelContract } from "./model-contract"
import { buildModelPickerRows, type AccountState, type ModelListState, type ModelPickerRow } from "./model-picker-core"
import { AddProvider } from "./model-picker-add"

const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`

const suspendText = (reason: SuspendReason) =>
  reason === "needs-login"
    ? "需登录后使用，已暂停"
    : reason === "needs-credit"
      ? "需会员或钱包余额，已暂停"
      : "对应节点或模型已不可用，已暂停"

export function ModelPickPop(props: {
  contract: ModelContract
  directory: () => string | undefined
  selected: () => ComposerModel | null
  onSelect: (model: ComposerModel) => Promise<void>
  onPicked: () => void
}) {
  const [catalog, setCatalog] = createSignal<EffectiveCatalog | null>(null)
  const [catalogError, setCatalogError] = createSignal(false)
  const [auth, setAuth] = createSignal<AuthState | null>(null)
  const [authError, setAuthError] = createSignal(false)
  const [summary, setSummary] = createSignal<AccountSummary | null>(null)
  const [summaryError, setSummaryError] = createSignal(false)
  const [summaryLoading, setSummaryLoading] = createSignal(false)
  const [keyStatus, setKeyStatus] = createSignal<ProviderKeyStatus>({})
  const [models, setModels] = createSignal<Awaited<ReturnType<ModelContract["list"]>>>([])
  const [listState, setListState] = createSignal<ModelListState>("loading")
  const [query, setQuery] = createSignal("")
  const [addOpen, setAddOpen] = createSignal(false)
  const [configureId, setConfigureId] = createSignal<string | null>(null)
  const [switching, setSwitching] = createSignal<string | null>(null)
  const [switchError, setSwitchError] = createSignal(false)
  const endpoints = useAlphaEndpoints()

  let search: HTMLInputElement | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let disposed = false

  const loadCatalog = () => {
    setCatalogError(false)
    void window.api.models
      .catalog()
      .then(setCatalog)
      .catch(() => {
        setCatalog(null)
        setCatalogError(true)
      })
  }

  const loadSummary = () => {
    if (auth()?.status !== "logged-in") {
      setSummary(null)
      setSummaryError(false)
      setSummaryLoading(false)
      return
    }
    setSummaryLoading(true)
    void window.api.account
      .summary()
      .then((result) => {
        if (result && typeof result === "object" && "error" in result) {
          setSummary(null)
          setSummaryError(true)
          return
        }
        setSummary(result as AccountSummary)
        setSummaryError(false)
      })
      .catch(() => {
        setSummary(null)
        setSummaryError(true)
      })
      .finally(() => setSummaryLoading(false))
  }

  const scheduleRetry = () => {
    if (disposed) return
    clearTimeout(retryTimer)
    retryTimer = setTimeout(loadModels, nextEngineRetryDelay(retryAttempt++))
  }

  const loadModels = () => {
    const directory = props.directory()
    if (!directory || disposed) {
      setListState("failed")
      return
    }
    clearTimeout(retryTimer)
    setListState("loading")
    void props.contract
      .list(directory, AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS))
      .then((next) => {
        if (disposed) return
        setModels(next)
        setListState("ready")
        retryAttempt = 0
      })
      .catch(() => {
        if (disposed) return
        setListState("failed")
        scheduleRetry()
      })
  }

  const refreshKeys = () => {
    void window.api.providers
      .keyStatus()
      .then(setKeyStatus)
      .catch(() => {})
    loadModels()
  }

  const loadAuth = () => {
    setAuth(null)
    setAuthError(false)
    void window.api.auth
      .getState()
      .then((state) => {
        setAuth(state)
        loadSummary()
      })
      .catch(() => setAuthError(true))
  }

  onMount(() => {
    loadCatalog()
    loadModels()
    void window.api.providers
      .keyStatus()
      .then(setKeyStatus)
      .catch(() => {})
    loadAuth()
    const unsubscribe = window.api.auth.subscribe((state) => {
      setAuth(state)
      setAuthError(false)
      loadSummary()
    })
    queueMicrotask(() => search?.focus())
    onCleanup(() => unsubscribe?.())
  })

  onCleanup(() => {
    disposed = true
    clearTimeout(retryTimer)
  })

  const accountState = createMemo<AccountState>(() => {
    if (authError()) return "error"
    if (!auth()) return "loading"
    if (auth()?.status !== "logged-in") return "out"
    if (summaryLoading()) return "loading"
    if (summaryError()) return "error"
    const current = summary()
    if (!current) return "error"
    if (current.plan.status === "active") return "member"
    return current.balanceFen > 0 ? "balance" : "empty"
  })

  const rows = createMemo(() => {
    const current = catalog()
    if (!current) return []
    return buildModelPickerRows({
      catalog: current,
      models: models(),
      listState: listState(),
      keyStatus: keyStatus(),
      accountState: accountState(),
      query: query(),
    })
  })
  const platformRows = createMemo(() => rows().filter((row) => row.group === "platform"))
  const byokRows = createMemo(() => rows().filter((row) => row.group === "byok"))
  const memberPlanName = createMemo(() => {
    const plan = summary()?.plan
    return plan?.status === "active" ? plan.name : "Pro"
  })

  const pick = async (row: ModelPickerRow) => {
    if (row.availability === "needs-key") {
      setConfigureId(row.model.providerID)
      setAddOpen(true)
      return
    }
    if (row.availability === "needs-login") {
      void window.api.auth.start()
      return
    }
    if (row.availability === "needs-credit") {
      window.api.openLink(`${endpoints().web}${ALPHA_PATHS.wallet}?tab=recharge`)
      return
    }
    if (row.availability !== "available" || switching()) return
    setSwitchError(false)
    setSwitching(row.key)
    try {
      await props.onSelect(row.model)
      props.onPicked()
    } catch {
      setSwitchError(true)
    } finally {
      setSwitching(null)
    }
  }

  return (
    <div class="a-mpp" role="dialog" aria-label="选择模型">
      <div class="a-mpp-search">
        <input
          ref={search}
          type="search"
          aria-label="搜索模型或供应商"
          placeholder="搜索模型 / 供应商"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      <Show when={accountState() === "member"}>
        <div class="a-acct-banner member">
          <span class="bt">{memberPlanName()} 会员 · 本周期额度充足</span>
        </div>
      </Show>
      <Show when={accountState() === "balance"}>
        <div class="a-acct-banner balance">
          <span class="bt">钱包余额 {fmtYuan(summary()?.balanceFen ?? 0)} · 按量扣费</span>
        </div>
      </Show>
      <Show when={accountState() === "empty"}>
        <div class="a-acct-banner empty">
          <span class="bt">余额不足 · 充值后解锁代理</span>
        </div>
      </Show>
      <Show when={accountState() === "out"}>
        <div class="a-acct-banner out">
          <span class="bt">登录解锁代理节点</span>
        </div>
      </Show>
      <Show when={accountState() === "loading"}>
        <div class="a-acct-banner balance" role="status">
          <span class="bt">正在读取账户状态…</span>
        </div>
      </Show>
      <Show when={accountState() === "error"}>
        <div class="a-acct-banner error" role="alert">
          <span class="bt">账户信息读取失败</span>
          <button type="button" onClick={() => (authError() ? loadAuth() : loadSummary())}>
            重试
          </button>
        </div>
      </Show>

      <Show when={composerModelSuspended()}>
        {(suspended) => (
          <div class="a-pop-note">
            上次使用的「{suspended().model.name}」{suspendText(suspended().reason)}；恢复后可重新选择。
          </div>
        )}
      </Show>
      <Show when={catalogError()}>
        <div class="a-mpp-alert" role="alert">
          <strong>模型目录加载失败</strong>
          <span>当前不提供推测列表。</span>
          <button type="button" onClick={loadCatalog}>
            重试
          </button>
        </div>
      </Show>
      <Show when={!catalogError() && listState() === "failed"}>
        <div class="a-mpp-alert" role="alert">
          <strong>正在连接引擎（可能正在重启）…</strong>
          <span>当前选择保持不变，模型列表稍后自动恢复。</span>
          <button type="button" onClick={loadModels}>
            立即重试
          </button>
        </div>
      </Show>
      <Show when={switchError()}>
        <div class="a-mpp-alert" role="alert">
          <strong>切换模型失败</strong>
          <span>当前选择没有改变，请重试。</span>
        </div>
      </Show>

      <div class="a-mpp-scroll">
        <Show when={platformRows().length}>
          <div class="a-pop-label">代理节点 · 经 ALPHA 代理</div>
          <For each={platformRows()}>
            {(row) => (
              <ModelRow
                row={row}
                selected={props.selected}
                switching={switching}
                onPick={pick}
                tierLabel={tierLabel(catalog())}
              />
            )}
          </For>
        </Show>
        <Show when={byokRows().length}>
          <div class="a-pop-label">国内直连 · 自带 KEY (BYOK)</div>
          <For each={byokRows()}>
            {(row) => (
              <ModelRow
                row={row}
                selected={props.selected}
                switching={switching}
                onPick={pick}
                tierLabel={tierLabel(catalog())}
              />
            )}
          </For>
        </Show>
        <Show when={!catalog() && !catalogError()}>
          <div class="a-mpp-empty" role="status">
            <strong>正在加载模型目录…</strong>
          </div>
        </Show>
        <Show when={!!catalog() && rows().length === 0}>
          <div class="a-mpp-empty">
            <strong>无匹配模型</strong>
          </div>
        </Show>
      </div>

      <button
        type="button"
        class="a-pop-item a-mpp-addrow"
        disabled={!catalog()}
        onClick={() => {
          setConfigureId(null)
          setAddOpen(true)
        }}
      >
        ＋ 添加自定义节点 / 供应商
      </button>
      <Show when={addOpen()}>
        <AddProvider
          catalog={catalog()}
          initialId={configureId() ?? undefined}
          keyStatus={keyStatus()}
          onClose={() => {
            setAddOpen(false)
            setConfigureId(null)
          }}
          onSaved={refreshKeys}
        />
      </Show>
    </div>
  )
}

function ModelRow(props: {
  row: ModelPickerRow
  selected: () => ComposerModel | null
  switching: () => string | null
  onPick: (row: ModelPickerRow) => Promise<void>
  tierLabel: (tier?: Tier) => string
}) {
  const selected = () => {
    const current = props.selected()
    return current?.providerID === props.row.model.providerID && current.id === props.row.model.id
  }
  const disabled = () => ["loading", "unavailable"].includes(props.row.availability) || !!props.switching()
  const status = () =>
    props.row.reason ?? (props.row.tier ? `${props.tierLabel(props.row.tier)} ${props.row.mult ?? ""}`.trim() : "")
  return (
    <button
      type="button"
      class="a-pop-item a-mpp-row"
      classList={{
        selected: selected(),
        locked: props.row.availability !== "available",
        "is-switching": props.switching() === props.row.key,
      }}
      aria-current={selected() ? "true" : undefined}
      aria-label={`${props.row.model.name}，${props.row.providerName}${status() ? `，${status()}` : ""}`}
      disabled={disabled()}
      onClick={() => void props.onPick(props.row)}
    >
      <span class="a-pico" style={{ background: props.row.pico.color }}>
        {props.row.pico.letter}
      </span>
      <span class="a-mpp-name">
        {props.row.model.name}
        <small>
          {props.row.model.id}
          {props.row.group === "byok" ? ` · ${props.row.providerName}` : ""}
        </small>
      </span>
      <Show when={props.row.reasoning}>
        <span class="a-mpp-dot" />
      </Show>
      <Show when={status()}>{(label) => <span class="a-pop-desc">{label()}</span>}</Show>
    </button>
  )
}

function tierLabel(catalog: EffectiveCatalog | null) {
  return (tier?: Tier) => (tier ? (catalog?.tiers[tier]?.label ?? tier) : "")
}
