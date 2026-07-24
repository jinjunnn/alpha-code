// ModelPickPop — canonical Alpha composer model picker. It owns the visible IA and talks only to the
// generated SDK v2 model contract; no upstream picker DOM is mounted, hidden, observed, or clicked.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
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
import { accountResultState } from "./model-recovery"
import { t } from "../i18n"
import { markStartupTimeline } from "../startup-timeline"
import { subscribeRuntimeRecovery, subscribeSseReconnected } from "../runtime-recovery"

const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`
type LoadState<T> =
  | { status: "loading" }
  | { status: "recovering" }
  | { status: "ready"; data: T }
  | { status: "failed" }

const suspendText = (reason: SuspendReason) =>
  reason === "needs-login"
    ? t("alpha.model.suspendedLogin")
    : reason === "needs-credit"
      ? t("alpha.model.suspendedCredit")
      : t("alpha.model.suspendedUnavailable")

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
  let accountRetryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let accountRetryAttempt = 0
  let loadSeq = 0
  let listSeq = 0
  let summarySeq = 0
  let disposed = false
  let loadedEpoch: string | undefined
  let lastAuthSignature: string | undefined
  let immediateRetryQueued = false
  let retryImmediately = (_reason: string) => {}

  const epochKey = () => `${props.directory() ?? ""}\u0000${composerModelProjection().sessionID ?? ""}`
  const isCurrent = (seq: number, epoch: string) => !disposed && seq === loadSeq && epoch === epochKey()
  const authSignature = (state: AuthState) =>
    `${state.status}\u0000${state.mode}\u0000${state.platformStatus ?? "ready"}\u0000${state.account?.email ?? ""}`

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
    const request = ++summarySeq
    clearTimeout(accountRetryTimer)
    if (state.status !== "logged-in") {
      if (!isCurrent(seq, epoch)) return
      setSummary({ status: "ready", data: null })
      return
    }
    if (state.platformStatus === "recovering") {
      if (isCurrent(seq, epoch)) setSummary({ status: "recovering" })
      return
    }
    void window.api.account
      .summary()
      .then((result) => {
        if (!isCurrent(seq, epoch) || request !== summarySeq) return
        const resultState = accountResultState(result)
        if (resultState !== "ready") {
          setSummary({ status: resultState })
          if (resultState === "recovering")
            accountRetryTimer = setTimeout(
              () => loadSummary(state, seq, epoch),
              nextEngineRetryDelay(accountRetryAttempt++),
            )
          return
        }
        const recovered = summary().status === "recovering"
        accountRetryAttempt = 0
        setSummary({ status: "ready", data: result as AccountSummary })
        if (recovered) retryImmediately("account-recovered")
      })
      .catch(() => {
        if (!isCurrent(seq, epoch) || request !== summarySeq) return
        setSummary({ status: "recovering" })
        accountRetryTimer = setTimeout(
          () => loadSummary(state, seq, epoch),
          nextEngineRetryDelay(accountRetryAttempt++),
        )
      })
  }

  const scheduleRetry = (seq: number, epoch: string) => {
    if (!isCurrent(seq, epoch)) return
    clearTimeout(retryTimer)
    setListState("recovering")
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
    setListState(models().length > 0 ? "recovering" : "loading")
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
        setListState("recovering")
        scheduleRetry(seq, epoch)
      })
  }

  retryImmediately = (reason) => {
    if (immediateRetryQueued || disposed) return
    immediateRetryQueued = true
    queueMicrotask(() => {
      immediateRetryQueued = false
      if (disposed) return
      clearTimeout(retryTimer)
      clearTimeout(accountRetryTimer)
      retryAttempt = 0
      accountRetryAttempt = 0
      markStartupTimeline("renderer.retry_backoff.cancel", {
        reason,
        surface: "picker",
      })
      loadModels(loadSeq, epochKey())
      const currentAuth = auth()
      if (summary().status === "recovering" && currentAuth.status === "ready")
        loadSummary(currentAuth.data, loadSeq, epochKey())
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
        setKeyStatus({ status: "failed" })
      })
  }

  const loadAuth = (seq: number, epoch: string, known?: AuthState) => {
    if (known) {
      lastAuthSignature = authSignature(known)
      setAuth({ status: "ready", data: known })
      loadSummary(known, seq, epoch)
      return
    }
    void window.api.auth
      .getState()
      .then((state) => {
        if (!isCurrent(seq, epoch)) return
        lastAuthSignature = authSignature(state)
        setAuth({ status: "ready", data: state })
        loadSummary(state, seq, epoch)
      })
      .catch(() => {
        if (!isCurrent(seq, epoch)) return
        setAuth({ status: "recovering" })
        setSummary({ status: "recovering" })
      })
  }

  const loadAll = (knownAuth?: AuthState) => {
    const seq = ++loadSeq
    const epoch = epochKey()
    const preserveRows = loadedEpoch === epoch
    loadedEpoch = epoch
    clearTimeout(retryTimer)
    clearTimeout(accountRetryTimer)
    retryAttempt = 0
    accountRetryAttempt = 0
    setCatalog(null)
    setCatalogError(false)
    setAuth(knownAuth ? { status: "ready", data: knownAuth } : { status: "loading" })
    setSummary({ status: "loading" })
    setKeyStatus({ status: "loading" })
    if (!preserveRows) setModels([])
    setListState(preserveRows && models().length > 0 ? "recovering" : "loading")
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
    untrack(() => loadAll())
  })

  onMount(() => {
    const unsubscribe = window.api.auth.subscribe((state) => {
      if (authSignature(state) === lastAuthSignature) return
      lastAuthSignature = authSignature(state)
      loadAll(state)
    })
    let receivedRuntimeState = false
    const unsubscribeRuntime = subscribeRuntimeRecovery((state) => {
      if (!receivedRuntimeState) {
        receivedRuntimeState = true
        if (state.status === "ready") return
      }
      if (state.status === "recovering") {
        if (models().length > 0) setListState("recovering")
        return
      }
      retryImmediately("generation-ready")
    })
    const unsubscribeSse = subscribeSseReconnected(() => retryImmediately("sse-reconnected"))
    queueMicrotask(() => search?.focus())
    onCleanup(() => {
      unsubscribe?.()
      unsubscribeRuntime()
      unsubscribeSse()
    })
  })

  onCleanup(() => {
    disposed = true
    clearTimeout(retryTimer)
    clearTimeout(accountRetryTimer)
  })

  const accountState = createMemo<AccountState>(() => {
    const authValue = auth()
    if (authValue.status === "loading") return "loading"
    if (authValue.status === "recovering") return "recovering"
    if (authValue.status === "failed") return "failed"
    if (authValue.data.status !== "logged-in") return "out"
    const summaryValue = summary()
    if (summaryValue.status === "loading") return "loading"
    if (summaryValue.status === "recovering") return "recovering"
    if (summaryValue.status === "failed" || !summaryValue.data) return "failed"
    const current = summaryValue.data
    if (current.plan.status === "active") return "member"
    return current.balanceFen > 0 ? "balance" : "empty"
  })
  const readyKeyStatus = () => {
    const current = keyStatus()
    return current.status === "ready" ? current.data : {}
  }
  const pickerKeyStatus = () => {
    const status = keyStatus().status
    return status === "recovering" ? ("loading" as const) : status
  }

  const rows = createMemo(() => {
    const current = catalog()
    if (!current) return []
    return buildModelPickerRows({
      catalog: current,
      models: models(),
      listState: listState(),
      keyStatusState: pickerKeyStatus(),
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
    <div class="a-mpp" data-alpha-picker-owner="alpha.composer-model" role="dialog" aria-label={t("alpha.model.choose")}>
      <div class="a-mpp-search">
        <input
          ref={search}
          type="search"
          aria-label={t("alpha.model.searchLabel")}
          placeholder={t("alpha.model.searchPlaceholder")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      <Show when={accountState() === "member"}>
        <div class="a-acct-banner member">
          <span class="bt">{t("alpha.model.memberCredit", { plan: memberPlanName() })}</span>
        </div>
      </Show>
      <Show when={accountState() === "balance"}>
        <div class="a-acct-banner balance">
          <span class="bt">{t("alpha.model.walletBalance", { balance: fmtYuan(balance()) })}</span>
        </div>
      </Show>
      <Show when={accountState() === "empty"}>
        <div class="a-acct-banner empty">
          <span class="bt">{t("alpha.model.creditEmpty")}</span>
        </div>
      </Show>
      <Show when={accountState() === "out"}>
        <div class="a-acct-banner out">
          <span class="bt">{t("alpha.model.loginUnlock")}</span>
          <button type="button" onClick={() => void window.api.auth.start()}>
            {t("alpha.auth.signIn")}
          </button>
        </div>
      </Show>
      <Show when={accountState() === "loading" || accountState() === "recovering"}>
        <div class="a-acct-banner balance" role="status">
          <span class="bt">{accountState() === "recovering" ? t("alpha.model.syncing") : t("alpha.model.accountReading")}</span>
        </div>
      </Show>
      <Show when={accountState() === "failed"}>
        <div class="a-acct-banner error" role="alert">
          <span class="bt">{t("alpha.model.accountFailed")}</span>
          <button type="button" onClick={retryAll}>
            {t("alpha.common.retry")}
          </button>
        </div>
      </Show>

      <Show when={keyStatus().status === "loading"}>
        <div class="a-mpp-alert" role="status">
          <strong>{t("alpha.model.keyReading")}</strong>
          <span>{t("alpha.model.keyReadingDetail")}</span>
        </div>
      </Show>
      <Show when={keyStatus().status === "failed"}>
        <div class="a-mpp-alert" role="alert">
          <strong>{t("alpha.model.keyReadFailed")}</strong>
          <span>{t("alpha.model.keyReadFailedDetail")}</span>
          <button type="button" onClick={retryAll}>
            {t("alpha.common.retry")}
          </button>
        </div>
      </Show>

      <Show when={composerModelProjection().status === "loading"}>
        <div class="a-mpp-alert" role="status">
          <strong>{t("alpha.model.currentReading")}</strong>
          <span>{t("alpha.model.currentReadingDetail")}</span>
        </div>
      </Show>
      <Show when={composerModelProjection().status === "error"}>
        <div class="a-mpp-alert" role="alert">
          <strong>{t("alpha.model.currentFailed")}</strong>
          <span>{t("alpha.model.currentFailedDetail")}</span>
          <button type="button" onClick={retryAll} disabled={!props.onRetryCurrent}>
            {t("alpha.common.retry")}
          </button>
        </div>
      </Show>

      <Show when={composerModelSuspended()}>
        {(suspended) => (
          <div class="a-pop-note">
            {t("alpha.model.suspended", { model: suspended().model.name, reason: suspendText(suspended().reason) })}
          </div>
        )}
      </Show>
      <Show when={catalogError()}>
        <div class="a-mpp-alert" role="alert">
          <strong>{t("alpha.model.catalogFailed")}</strong>
          <span>{t("alpha.model.catalogFailedDetail")}</span>
          <button type="button" onClick={retryAll}>
            {t("alpha.common.retry")}
          </button>
        </div>
      </Show>
      <Show when={!catalogError() && listState() === "recovering"}>
        <div class="a-mpp-alert" role="status">
          <strong>{t("alpha.model.engineConnecting")}</strong>
          <span>{t("alpha.model.engineConnectingDetail")}</span>
          <button type="button" onClick={retryAll}>
            {t("alpha.model.retryNow")}
          </button>
        </div>
      </Show>
      <Show when={!catalogError() && listState() === "failed"}>
        <div class="a-mpp-alert" role="alert">
          <strong>{t("alpha.model.catalogFailed")}</strong>
          <button type="button" onClick={retryAll}>
            {t("alpha.common.retry")}
          </button>
        </div>
      </Show>
      <Show when={switchError()}>
        <div class="a-mpp-alert" role="alert">
          <strong>{t("alpha.model.switchFailed")}</strong>
          <span>{t("alpha.model.switchFailedDetail")}</span>
        </div>
      </Show>

      <div class="a-mpp-scroll">
        <Show when={platformRows().length}>
          <div class="a-pop-label">{t("alpha.model.platformGroup")}</div>
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
          <div class="a-pop-label">{t("alpha.model.byokGroup")}</div>
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
            <strong>{t("alpha.model.catalogLoading")}</strong>
          </div>
        </Show>
        <Show when={!!catalog() && rows().length === 0}>
          <div class="a-mpp-empty">
            <strong>{t("alpha.model.noMatches")}</strong>
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
        {t("alpha.model.addProvider")}
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
      aria-label={
        status()
          ? t("alpha.model.rowLabel", { model: props.row.model.name, provider: props.row.providerName, status: status() })
          : t("alpha.model.rowLabelNoStatus", { model: props.row.model.name, provider: props.row.providerName })
      }
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
