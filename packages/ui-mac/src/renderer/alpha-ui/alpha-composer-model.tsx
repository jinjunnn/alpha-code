// ModelPickPop — canonical Alpha composer model picker. It owns the visible IA and talks only to the
// generated SDK v2 model contract; no upstream picker DOM is mounted, hidden, observed, or clicked.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { AccountSummary, AuthState } from "../../preload/types"
import type { EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import { ALPHA_PATHS } from "../../shared/alpha-config"
import { useAlphaEndpoints } from "../use-alpha-endpoints"
import {
  composerModelProjection,
  composerModelSuspended,
  type ComposerModel,
  type SuspendReason,
} from "./composer-state"
import { ENGINE_FETCH_TIMEOUT_MS, nextEngineRetryDelay } from "./model-picker-logic"
import type { ModelContract } from "./model-contract"
import { buildModelPickerRows, type AccountState, type ModelListState, type ModelPickerRow } from "./model-picker-core"
import { AddProvider } from "./model-picker-add"

const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`
type LoadState<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error" }

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
  onRetryCurrent?: () => void
  modelChainReady?: () => boolean
}) {
  const [catalog, setCatalog] = createSignal<EffectiveCatalog | null>(null)
  const [catalogError, setCatalogError] = createSignal(false)
  const [auth, setAuth] = createSignal<LoadState<AuthState>>({ status: "loading" })
  const [summary, setSummary] = createSignal<LoadState<AccountSummary | null>>({ status: "loading" })
  const [keyStatus, setKeyStatus] = createSignal<LoadState<ProviderKeyStatus>>({ status: "loading" })
  const [models, setModels] = createSignal<Awaited<ReturnType<ModelContract["list"]>>>([])
  const [listState, setListState] = createSignal<ModelListState>("loading")
  const [readyListEpoch, setReadyListEpoch] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")
  const [addOpen, setAddOpen] = createSignal(false)
  const [configureId, setConfigureId] = createSignal<string | null>(null)
  const [switching, setSwitching] = createSignal<string | null>(null)
  const [switchError, setSwitchError] = createSignal(false)
  const endpoints = useAlphaEndpoints()

  let search: HTMLInputElement | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let loadSeq = 0
  let listSeq = 0
  let disposed = false

  const epochKey = () => `${props.directory() ?? ""}\u0000${composerModelProjection().sessionID ?? ""}`
  const isCurrent = (seq: number, epoch: string) => !disposed && seq === loadSeq && epoch === epochKey()

  const loadCatalog = (seq: number, epoch: string) => {
    void window.api.models
      .catalog()
      .then((next) => {
        if (!isCurrent(seq, epoch)) return
        setCatalog(next)
      })
      .catch(() => {
        if (!isCurrent(seq, epoch)) return
        setCatalog(null)
        setCatalogError(true)
      })
  }

  const loadSummary = (state: AuthState, seq: number, epoch: string) => {
    if (state.status !== "logged-in") {
      if (!isCurrent(seq, epoch)) return
      setSummary({ status: "ready", data: null })
      return
    }
    void window.api.account
      .summary()
      .then((result) => {
        if (!isCurrent(seq, epoch)) return
        if (result && typeof result === "object" && "error" in result) {
          setSummary({ status: "error" })
          return
        }
        setSummary({ status: "ready", data: result as AccountSummary })
      })
      .catch(() => {
        if (!isCurrent(seq, epoch)) return
        setSummary({ status: "error" })
      })
  }

  const scheduleRetry = (seq: number, epoch: string) => {
    if (!isCurrent(seq, epoch)) return
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => loadModels(seq, epoch), nextEngineRetryDelay(retryAttempt++))
  }

  const loadModels = (seq: number, epoch: string) => {
    const directory = props.directory()
    const request = ++listSeq
    if (!directory || !isCurrent(seq, epoch)) {
      setListState("failed")
      return
    }
    clearTimeout(retryTimer)
    setModels([])
    setListState("loading")
    setReadyListEpoch(null)
    setSwitching(null)
    setSwitchError(false)
    void props.contract
      .list(directory, AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS))
      .then((next) => {
        if (!isCurrent(seq, epoch) || request !== listSeq) return
        setModels(next)
        setListState("ready")
        setReadyListEpoch(epoch)
        retryAttempt = 0
      })
      .catch(() => {
        if (!isCurrent(seq, epoch) || request !== listSeq) return
        setListState("failed")
        scheduleRetry(seq, epoch)
      })
  }

  const loadKeys = (seq: number, epoch: string) => {
    void window.api.providers
      .keyStatus()
      .then((data) => {
        if (!isCurrent(seq, epoch)) return
        setKeyStatus({ status: "ready", data })
      })
      .catch(() => {
        if (!isCurrent(seq, epoch)) return
        setKeyStatus({ status: "error" })
      })
  }

  const loadAuth = (seq: number, epoch: string, known?: AuthState) => {
    if (known) {
      setAuth({ status: "ready", data: known })
      loadSummary(known, seq, epoch)
      return
    }
    void window.api.auth
      .getState()
      .then((state) => {
        if (!isCurrent(seq, epoch)) return
        setAuth({ status: "ready", data: state })
        loadSummary(state, seq, epoch)
      })
      .catch(() => {
        if (!isCurrent(seq, epoch)) return
        setAuth({ status: "error" })
        setSummary({ status: "error" })
      })
  }

  const loadAll = (knownAuth?: AuthState) => {
    const seq = ++loadSeq
    const epoch = epochKey()
    clearTimeout(retryTimer)
    retryAttempt = 0
    setCatalog(null)
    setCatalogError(false)
    setAuth(knownAuth ? { status: "ready", data: knownAuth } : { status: "loading" })
    setSummary({ status: "loading" })
    setKeyStatus({ status: "loading" })
    setModels([])
    setListState("loading")
    setReadyListEpoch(null)
    loadCatalog(seq, epoch)
    loadModels(seq, epoch)
    loadKeys(seq, epoch)
    loadAuth(seq, epoch, knownAuth)
  }

  const retryAll = () => {
    props.onRetryCurrent?.()
    loadAll()
  }

  createEffect(() => {
    props.directory()
    composerModelProjection().sessionID
    loadAll()
  })

  onMount(() => {
    const unsubscribe = window.api.auth.subscribe((state) => loadAll(state))
    queueMicrotask(() => search?.focus())
    onCleanup(() => unsubscribe?.())
  })

  onCleanup(() => {
    disposed = true
    clearTimeout(retryTimer)
  })

  const accountState = createMemo<AccountState>(() => {
    const authValue = auth()
    if (authValue.status === "loading") return "loading"
    if (authValue.status === "error") return "error"
    if (authValue.data.status !== "logged-in") return "out"
    const summaryValue = summary()
    if (summaryValue.status === "loading") return "loading"
    if (summaryValue.status === "error" || !summaryValue.data) return "error"
    const current = summaryValue.data
    if (current.plan.status === "active") return "member"
    return current.balanceFen > 0 ? "balance" : "empty"
  })
  const readyKeyStatus = () => {
    const current = keyStatus()
    return current.status === "ready" ? current.data : {}
  }

  const rows = createMemo(() => {
    const current = catalog()
    if (!current) return []
    return buildModelPickerRows({
      catalog: current,
      models: models(),
      listState: listState(),
      keyStatusState: keyStatus().status,
      keyStatus: readyKeyStatus(),
      accountState: accountState(),
      query: query(),
    })
  })
  const platformRows = createMemo(() => rows().filter((row) => row.group === "platform"))
  const byokRows = createMemo(() => rows().filter((row) => row.group === "byok"))
  const memberPlanName = createMemo(() => {
    const current = summary()
    const plan = current.status === "ready" ? current.data?.plan : undefined
    return plan?.status === "active" ? plan.name : "Pro"
  })
  const balance = () => {
    const current = summary()
    return current.status === "ready" ? (current.data?.balanceFen ?? 0) : 0
  }
  const selectionBlocked = () =>
    composerModelProjection().status !== "ready" ||
    props.modelChainReady?.() === false ||
    listState() !== "ready" ||
    readyListEpoch() !== epochKey()

  const pick = async (row: ModelPickerRow) => {
    if (selectionBlocked()) return
    if (!rows().includes(row)) return
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
    if (!models().some((model) => model.providerID === row.model.providerID && model.id === row.model.id)) return
    const epoch = readyListEpoch()
    setSwitchError(false)
    setSwitching(row.key)
    try {
      await props.onSelect(row.model)
      if (epoch !== readyListEpoch() || epoch !== epochKey()) return
      props.onPicked()
    } catch {
      if (epoch !== readyListEpoch() || epoch !== epochKey()) return
      setSwitchError(true)
    } finally {
      if (epoch === readyListEpoch() && epoch === epochKey()) setSwitching(null)
    }
  }

  return (
    <div class="a-mpp" data-alpha-picker-owner="alpha.composer-model" role="dialog" aria-label="选择模型">
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
          <span class="bt">钱包余额 {fmtYuan(balance())} · 按量扣费</span>
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
          <button type="button" onClick={() => void window.api.auth.start()}>
            登录
          </button>
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
          <button type="button" onClick={retryAll}>
            重试
          </button>
        </div>
      </Show>

      <Show when={keyStatus().status === "loading"}>
        <div class="a-mpp-alert" role="status">
          <strong>正在读取 KEY 状态…</strong>
          <span>确认前不会把供应商标成未配置。</span>
        </div>
      </Show>
      <Show when={keyStatus().status === "error"}>
        <div class="a-mpp-alert" role="alert">
          <strong>KEY 状态读取失败</strong>
          <span>当前不提供配置结论。</span>
          <button type="button" onClick={retryAll}>
            重试
          </button>
        </div>
      </Show>

      <Show when={composerModelProjection().status === "loading"}>
        <div class="a-mpp-alert" role="status">
          <strong>正在读取当前会话模型…</strong>
          <span>读取完成前不会沿用其他会话的选择。</span>
        </div>
      </Show>
      <Show when={composerModelProjection().status === "error"}>
        <div class="a-mpp-alert" role="alert">
          <strong>当前会话模型读取失败</strong>
          <span>没有沿用其他会话的选择。</span>
          <button type="button" onClick={retryAll} disabled={!props.onRetryCurrent}>
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
          <button type="button" onClick={retryAll}>
            重试
          </button>
        </div>
      </Show>
      <Show when={!catalogError() && listState() === "failed"}>
        <div class="a-mpp-alert" role="alert">
          <strong>正在连接引擎（可能正在重启）…</strong>
          <span>当前选择保持不变，模型列表稍后自动恢复。</span>
          <button type="button" onClick={retryAll}>
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
                selectionBlocked={selectionBlocked}
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
                selectionBlocked={selectionBlocked}
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
        disabled={!catalog() || selectionBlocked()}
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
          keyStatus={keyStatus().status === "ready" ? readyKeyStatus() : undefined}
          onClose={() => {
            setAddOpen(false)
            setConfigureId(null)
          }}
          onSaved={retryAll}
        />
      </Show>
    </div>
  )
}

function ModelRow(props: {
  row: ModelPickerRow
  selected: () => ComposerModel | null
  switching: () => string | null
  selectionBlocked: () => boolean
  onPick: (row: ModelPickerRow) => Promise<void>
  tierLabel: (tier?: Tier) => string
}) {
  const selected = () => {
    const current = props.selected()
    return current?.providerID === props.row.model.providerID && current.id === props.row.model.id
  }
  const disabled = () =>
    props.selectionBlocked() || ["loading", "unavailable"].includes(props.row.availability) || !!props.switching()
  const status = () =>
    props.row.reason ?? (props.row.tier ? `${props.tierLabel(props.row.tier)} ${props.row.mult ?? ""}`.trim() : "")
  return (
    <button
      type="button"
      class="a-pop-item a-mpp-row"
      data-group={props.row.group}
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
