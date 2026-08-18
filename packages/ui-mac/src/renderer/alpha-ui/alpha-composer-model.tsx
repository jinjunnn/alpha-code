// ModelPickPop — canonical Alpha composer model picker. It owns the visible IA and talks only to the
// generated SDK v2 model contract; no upstream picker DOM is mounted, hidden, observed, or clicked.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import type { AccountSummary, AuthState } from "../../preload/types"
import type { EffectiveCatalog, ProviderKeyStatus } from "../../shared/alpha-model-types"
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
import {
  buildModelPickerRows,
  pricingStatusText,
  type AccountState,
  type ModelListState,
  type ModelPickerRow,
} from "./model-picker-core"
import { AddProvider } from "./model-picker-add"
import { accountResultState } from "./model-recovery"
import { t } from "../i18n"
import { markStartupTimeline } from "../startup-timeline"
import { replayRuntimeRecoveryState, subscribeRuntimeRecovery, subscribeSseReconnected } from "../runtime-recovery"
import { reconcileAuthSnapshot, subscribeAuthState } from "../auth-recovery"

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
  // #613:引擎就绪但 alpha 配置注入失败(sidecar generation 终态 "injection-failed")。
  // 与「引擎未就绪」是两回事:引擎可达、列表能拉,但平台/BYOK 配置整份丢失 —— 横幅解释真因。
  const [injectionFailed, setInjectionFailed] = createSignal(false)
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
  let silentTokenOnlyGeneration: number | null = null
  let retryImmediately = (_reason: string) => {}

  const epochKey = () => `${props.directory() ?? ""}\u0000${composerModelProjection().sessionID ?? ""}`
  const isCurrent = (seq: number, epoch: string) => !disposed && seq === loadSeq && epoch === epochKey()
  const authSignature = (state: AuthState) =>
    `${state.status}\u0000${state.mode}\u0000${state.platformStatus ?? "ready"}\u0000${state.account?.email ?? ""}`
  const authIdentitySignature = (state: AuthState) =>
    JSON.stringify({
      status: state.status,
      mode: state.mode,
      email: state.account?.email ?? "",
      plan: state.account?.plan ?? null,
    })

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
      .then((raw) => {
        if (!isCurrent(seq, epoch)) return
        // #604:弹窗这次读取同样只是一份快照,过 owner 的 freshness 判据后再用它的现值。
        const state = reconcileAuthSnapshot(raw)
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
    // #594 闩死点三:重试必须覆盖 client 构造层 —— 重读 generation 现值并广播,让
    // use-projects 在 client 被拆毁而现值已 ready 时重建 client;只重跑 fetch
    //(onRetryCurrent/loadAll)治不了 sdk() === undefined 的同步失败。
    void replayRuntimeRecoveryState()
    props.onRetryCurrent?.()
    loadAll()
  }

  createEffect(() => {
    props.directory()
    composerModelProjection().sessionID
    untrack(() => loadAll())
  })

  onMount(() => {
    const unsubscribe = subscribeAuthState((state) => {
      if (authSignature(state) === lastAuthSignature) return
      lastAuthSignature = authSignature(state)
      const current = auth()
      if (
        state.status === "logged-in" &&
        state.platformStatus === "recovering" &&
        current.status === "ready" &&
        current.data.status === "logged-in" &&
        authIdentitySignature(state) === authIdentitySignature(current.data)
      )
        return
      loadAll(state)
    })
    let receivedRuntimeState = false
    const unsubscribeRuntime = subscribeRuntimeRecovery((state) => {
      // #613:横幅事实先落、再走唤醒判定 —— 它不依赖首值门,回放/迟到订阅同样呈现;
      // 新 generation 的 recovering/ready 自然清横幅。
      setInjectionFailed(state.status === "injection-failed")
      if (!receivedRuntimeState) {
        receivedRuntimeState = true
        // 首值为终态(ready/failed/injection-failed)时初始 loadAll 已在跑,无需额外唤醒。
        if (state.status !== "recovering") return
      }
      if (state.status === "recovering") {
        if (state.reason === "token-only" && models().length > 0) {
          silentTokenOnlyGeneration = state.generation
          return
        }
        silentTokenOnlyGeneration = null
        if (models().length > 0) setListState("recovering")
        return
      }
      if (state.status === "failed") {
        if (silentTokenOnlyGeneration === state.generation) {
          silentTokenOnlyGeneration = null
          if (models().length > 0) setListState("recovering")
          retryImmediately("generation-failed")
        }
        // #577 终态:引擎未通过健康线,不得当成 ready 触发立即重试;
        // 弹窗自身的封顶退避(REQ-083 scheduleRetry)继续自证。
        return
      }
      silentTokenOnlyGeneration = null
      // ready 与 injection-failed(#613)都证明引擎可达:唤醒停跑的链。注入失败下 list
      // 会成功返回引擎的真实清单,行按事实置灰,横幅解释真因 —— 不再是「正在同步」的谎。
      retryImmediately(state.status === "ready" ? "generation-ready" : "engine-config-lost")
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
      sessionScoped: composerModelProjection().sessionID !== null,
      query: query(),
    })
  })
  const platformRows = createMemo(() => rows().filter((row) => row.group === "platform"))
  const byokRows = createMemo(() => rows().filter((row) => row.group === "byok"))
  // #679:倍数是**相对量**,不说清相对谁就是半句话。基准由平台下发(pricingBasisModelId),
  // 客户端不硬编码 —— 平台换基准,这行字跟着变才是诚实的。基准模型可能被 edition 白名单筛掉
  // (平台明说它是「单位定义,不是目录成员」),那时退回展示裸 id。
  // basis 缺席 ⇒ **整条不渲染**:没有「基准未知」这种半真陈述。
  const pricingBasisName = createMemo(() => {
    const current = catalog()
    const basis = current?.pricingBasisModelId
    if (!current || !basis) return null
    return current.platformModels.find((model) => model.id === basis)?.name ?? basis
  })
  const memberPlanName = createMemo(() => {
    const current = summary()
    const plan = current.status === "ready" ? current.data?.plan : undefined
    return plan?.status === "active" ? plan.name : "Pro"
  })
  const balance = () => {
    const current = summary()
    return current.status === "ready" ? (current.data?.balanceFen ?? 0) : 0
  }
  /* REQ-109 #595:选择门 row-aware。
     - home(无 session 投影)的本地 BYOK 行:可选择性只由本地目录 + 本地 KEY 决定,
       `modelChainReady` / `listState` / `readyListEpoch` 一律不得阻断,选中只是内存写
       (alpha-composer.selectComposerModel),发送仍由 canSend 等引擎;
     - 平台代理行、自定义节点行,以及 session 模式的一切行:继续受全链 + 引擎清单 epoch 管辖
       —— session 换模型必须落到服务端 `switchModel`,引擎不在就不能伪装成已切换。
     无 row 的调用方(「添加自定义节点」入口)沿用最严格的门。 */
  const homeLocalByok = (row?: ModelPickerRow) =>
    !!row?.engineIndependent && composerModelProjection().sessionID === null
  const selectionBlocked = (row?: ModelPickerRow) =>
    composerModelProjection().status !== "ready" ||
    (!homeLocalByok(row) &&
      (props.modelChainReady?.() === false || listState() !== "ready" || readyListEpoch() !== epochKey()))

  const pick = async (row: ModelPickerRow) => {
    if (selectionBlocked(row)) return
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
    // #595:engineIndependent 行不做引擎清单 membership 检查 —— 引擎回报不是它的可选择性证明。
    if (
      !row.engineIndependent &&
      !models().some((model) => model.providerID === row.model.providerID && model.id === row.model.id)
    )
      return
    const epoch = readyListEpoch()
    const clickedEpoch = epochKey()
    // 陈旧判据同样 row-aware:home 的本地 BYOK 行不依赖引擎清单 epoch(恢复中它本就是 null),
    // 只有 directory / session 换了才算陈旧;否则会漏掉 onPicked 与 switching 复位。
    const stale = () =>
      homeLocalByok(row) ? epochKey() !== clickedEpoch : epoch !== readyListEpoch() || epoch !== epochKey()
    setSwitchError(false)
    setSwitching(row.key)
    try {
      await props.onSelect(row.model)
      if (stale()) return
      props.onPicked()
    } catch {
      if (stale()) return
      setSwitchError(true)
    } finally {
      if (!stale()) setSwitching(null)
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
      <Show when={injectionFailed()}>
        {/* #613:与下面「正在连接引擎」(引擎未就绪)相区分 —— 引擎已就绪,但配置没跟上。 */}
        <div class="a-mpp-alert" role="alert">
          <strong>{t("alpha.model.engineConfigFailed")}</strong>
          <span>{t("alpha.model.engineConfigFailedDetail")}</span>
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
          <Show when={pricingBasisName()}>
            {(basis) => <div class="a-mpp-basis">{t("alpha.model.pricingBasisNote", { model: basis() })}</div>}
          </Show>
          <For each={platformRows()}>
            {(row) => (
              <ModelRow
                row={row}
                selected={props.selected}
                switching={switching}
                selectionBlocked={selectionBlocked}
                onPick={pick}
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
  /** row-aware(#595):本行是否被选择门阻断 —— 传本行,不要传空。 */
  selectionBlocked: (row: ModelPickerRow) => boolean
  onPick: (row: ModelPickerRow) => Promise<void>
}) {
  const selected = () => {
    const current = props.selected()
    return current?.providerID === props.row.model.providerID && current.id === props.row.model.id
  }
  const disabled = () =>
    props.selectionBlocked(props.row) || ["loading", "unavailable"].includes(props.row.availability) || !!props.switching()
  // #595 Minor:视觉必须跟着可点性走。availability "available" 但被选择门阻断(如 session 恢复中的
  // BYOK 行、epoch 陈旧的平台行)时,行同样置灰 —— 否则用户看到一条正常亮行却点不动。
  const dimmed = () => props.row.availability !== "available" || props.selectionBlocked(props.row)
  // #679:一行的行尾状态是**两件独立的事**,不是二选一。
  //   · `reason` = 运行态(需登录 / 余额不足 / 引擎重启中 / 正在同步 …),平台行在这些状态下**有值**;
  //   · 计价二态 = 这一行要花多少钱,平台行**任何状态下都必须看得到**其中一态。
  // 此前这里写的是 `reason ?? 档位`,于是 needs-credit / loading 的平台行两态都不显示。
  // 现在两者按顺序拼成**同一个来源** `statusParts()`:可见 DOM 与 aria-label 都从它派生,
  // 不存在「看得到但读屏读不到」的缝(构造级保证,不是两处各写一遍)。
  const statusParts = (): string[] =>
    [props.row.reason, pricingStatusText(props.row)].filter((part): part is string => !!part)
  const statusLabel = () => statusParts().join(" · ")
  return (
    <button
      type="button"
      class="a-pop-item a-mpp-row"
      data-group={props.row.group}
      classList={{
        selected: selected(),
        locked: dimmed(),
        "is-switching": props.switching() === props.row.key,
      }}
      aria-current={selected() ? "true" : undefined}
      aria-label={
        statusLabel()
          ? t("alpha.model.rowLabel", {
              model: props.row.model.name,
              provider: props.row.providerName,
              status: statusLabel(),
            })
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
      <For each={statusParts()}>{(part) => <span class="a-pop-desc">{part}</span>}</For>
    </button>
  )
}
