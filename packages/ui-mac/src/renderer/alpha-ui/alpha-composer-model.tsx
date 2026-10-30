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
import { catalogFailureReason, catalogSyncedAt, createCatalogRefreshHealth, retryCatalogRefresh } from "./catalog-refresh-health"

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
  let addRow: HTMLButtonElement | undefined
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
  // #1022 成功腿:静默换血成功后必然跟一次 SSE 重连(sidecar 换了),它是同一事件的回声 ——
  // 消费一次并忽略,窗口外的 sse-reconnected 行为不变。
  let sseQuietAfterSilentRotation = false
  let retryImmediately = (_reason: string) => {}

  const epochKey = () => `${props.directory() ?? ""}\u0000${composerModelProjection().sessionID ?? ""}`
  const isCurrent = (seq: number, epoch: string) => !disposed && seq === loadSeq && epoch === epochKey()
  const authSignature = (state: AuthState) =>
    `${state.status}\u0000${state.mode}\u0000${state.platformStatus ?? "ready"}\u0000${state.account?.email ?? ""}\u0000${state.refreshUnreachable ? "unreachable" : ""}`
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
    // 全量重载开启新的呈现周期:上一个静默换血窗口(及其 SSE 回声抑制)不得跨周期存活。
    silentTokenOnlyGeneration = null
    sseQuietAfterSilentRotation = false
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
      // #1022:token-only 换血 = 同一身份下「recovering → ready」的一对 auth 事件,凭据换了、
      // 目录没变 —— 两次都不重载,已渲染的账户/模型不得闪断(platformStatus 只有这两个值,
      // 判据落在身份 + token 新鲜度上)。skip 的前提是 fail-closed 的:
      //   · token 必须未过期 —— deriveState 对已过期 token 同样给 recovering 且不 respawn,
      //     那种 recovering 没有 rotation 事件会来,skip 它就是把行留成可点的谎(B2)。
      //     缺席 / 非有限 / 已到期一律视为过期,走 loadAll 如实呈现恢复中。正当的预换血路径
      //     在发布 recovering 之前已写入新 token 的未来 expiresAt,不会被这道闸拦下。
      //   · 当前视图必须已是同身份的 ready —— 视图还在 recovering 时收到 ready,必须重载恢复。
      if (
        state.status === "logged-in" &&
        typeof state.expiresAt === "number" &&
        Number.isFinite(state.expiresAt) &&
        state.expiresAt > Date.now() &&
        current.status === "ready" &&
        current.data.status === "logged-in" &&
        (current.data.platformStatus ?? "ready") === "ready" &&
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
        sseQuietAfterSilentRotation = false
        if (models().length > 0) setListState("recovering")
        return
      }
      if (state.status === "failed") {
        sseQuietAfterSilentRotation = false
        if (silentTokenOnlyGeneration === state.generation) {
          silentTokenOnlyGeneration = null
          if (models().length > 0) setListState("recovering")
          retryImmediately("generation-failed")
        }
        // #577 终态:引擎未通过健康线,不得当成 ready 触发立即重试;
        // 弹窗自身的封顶退避(REQ-083 scheduleRetry)继续自证。
        return
      }
      // #1022 成功腿:静默窗口内的同代 token-only ready 不唤醒任何重载 —— 凭据换了、目录没变,
      // retryImmediately 会把已 ready 的 listState 打回 recovering(「正在同步…」),正是本票
      // 要消灭的闪断。只留一次 SSE 回声抑制,其余终态照旧唤醒。
      if (state.status === "ready" && state.reason === "token-only" && silentTokenOnlyGeneration === state.generation) {
        silentTokenOnlyGeneration = null
        sseQuietAfterSilentRotation = true
        return
      }
      silentTokenOnlyGeneration = null
      sseQuietAfterSilentRotation = false
      // ready 与 injection-failed(#613)都证明引擎可达:唤醒停跑的链。注入失败下 list
      // 会成功返回引擎的真实清单,行按事实置灰,横幅解释真因 —— 不再是「正在同步」的谎。
      retryImmediately(state.status === "ready" ? "generation-ready" : "engine-config-lost")
    })
    const unsubscribeSse = subscribeSseReconnected(() => {
      // #1022:token-only 换血必然带来一次 SSE 重连。静默窗口内(rotation 还在跑)或刚静默
      // 成功结束的那一次,都不得借 retryImmediately 把已渲染列表降成 recovering;窗口外照旧。
      if (silentTokenOnlyGeneration !== null) return
      if (sseQuietAfterSilentRotation) {
        sseQuietAfterSilentRotation = false
        return
      }
      retryImmediately("sse-reconnected")
    })
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
    // #1543:续期因网络失败而停在恢复中 —— 说「连不上、自动重试」,不说「正在同步」。
    if (summaryValue.status === "recovering") return authValue.data.refreshUnreachable ? "unreachable" : "recovering"
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
  /* #1557 AC5(批准稿 2026-10-30-req236-model-status §二):两份目录各按自己的结局呈现(`#1556` 的 `{ platform, byok }`)。
     平台那份最近一次刷新失败:从未获取成功(已应用版本为空)⇒ 平台分组头「暂时取不到 · 重试」;有已应用旧版本 ⇒
     只在弹层底部一行。自带 Key 那份失败 ⇒ 只在自带 Key 分组头(随包清单本身可用)。 */
  const catalogFailure = createCatalogRefreshHealth()
  const platformNeverFetched = createMemo(() => {
    const failure = catalogFailure().platform
    const current = catalog()
    return failure && current && current.applied.platformFetchedAt === null ? failure : null
  })
  const staleCatalog = createMemo(() => {
    const failure = catalogFailure().platform
    const at = failure ? catalog()?.applied.platformFetchedAt : null
    return failure && at ? { failure, at } : null
  })
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
  // `#1556` AC1:没有已应用的平台快照 ⇒ 平台段为空,如实说「尚未获取」(不回退任何随包清单,也就没有价格可说)。
  // 未登录时沿用既有 IA(统一登录入口),不铺这条空态。
  const platformNotLoaded = createMemo(() => catalog()?.liveSync.status === "static" && accountState() !== "out")
  // `#1556` AC9:「已下载」与「已应用」不同 ⇒ 新清单要等引擎下次启动才生效;选择器继续显示正在用的那份。
  const catalogPending = createMemo(() => {
    const current = catalog()
    return (
      !!current &&
      (current.applied.platformFetchedAt !== current.downloaded.platformFetchedAt ||
        current.applied.byokVersion !== current.downloaded.byokVersion)
    )
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
     无 row 的调用方(底部「添加供应商 / 接入其它服务」入口)沿用最严格的门。 */
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
      <Show when={accountState() === "loading" || accountState() === "recovering" || accountState() === "unreachable"}>
        <div class="a-acct-banner balance" role="status">
          <span class="bt">
            {accountState() === "unreachable"
              ? t("alpha.model.serverUnreachable")
              : accountState() === "recovering"
                ? t("alpha.model.syncing")
                : t("alpha.model.accountReading")}
          </span>
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
        {/* `#1556` 的平台空态与 `#1557` 的分组头提示共用这一个分组头:没有已应用平台快照 ⇒ 空态(未登录沿用登录 IA,不铺);
            最近一次平台刷新失败且从未获取成功 ⇒ 组头右侧「暂时取不到 · 重试」。 */}
        <Show when={platformRows().length || platformNotLoaded() || platformNeverFetched()}>
          <div class="a-pop-label a-mpp-ghead">
            {t("alpha.model.platformGroup")}
            <Show when={platformNeverFetched()}>
              {(failure) => <CatalogGroupNote code={failure().code} />}
            </Show>
          </div>
          <Show when={platformRows().length === 0 && platformNotLoaded()}>
            <div class="a-mpp-platform-empty" role="status">
              <strong>{t("alpha.model.platformNotLoaded")}</strong>
              <span>{t("alpha.model.platformNotLoadedDetail")}</span>
            </div>
          </Show>
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
        <Show when={byokRows().length || catalogFailure().byok}>
          <div class="a-pop-label a-mpp-ghead">
            {t("alpha.model.byokGroup")}
            <Show when={catalogFailure().byok}>{(failure) => <CatalogGroupNote code={failure().code} />}</Show>
          </div>
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
        ref={addRow}
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
            // #1476:退回一级后焦点回到「添加供应商」,不掉到 body(否则下一次 Esc 会直接关掉整个菜单)。
            queueMicrotask(() => addRow?.isConnected && !addRow.disabled && addRow.focus())
          }}
          onSaved={retryAll}
        />
      </Show>
      {/* 弹层底部状态槽(批准稿 §二 B:与「已下载、待生效」同槽,一行一件事)。 */}
      <Show when={catalogPending() || staleCatalog()}>
        <div class="a-mpp-foot" role="status">
          <Show when={catalogPending()}>
            <div class="a-mpp-fl">{t("alpha.model.catalogPending")}</div>
          </Show>
          <Show when={staleCatalog()}>
            {(stale) => (
              <div class="a-mpp-fl" data-alpha-catalog-stale={stale().failure.code}>
                <span>
                  {t("alpha.model.catalogStale", { time: catalogSyncedAt(stale().at) })} ·{" "}
                  {catalogFailureReason(stale().failure.code)}
                </span>
                <button type="button" onClick={retryCatalogRefresh}>
                  {t("alpha.common.retry")}
                </button>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

/** #1557:分组头右侧「暂时取不到 · 重试」(批准稿 §五「分组头」)。 */
function CatalogGroupNote(props: { code: string }) {
  return (
    <span class="a-mpp-gh-note" data-alpha-catalog-unavailable={props.code}>
      {t("alpha.model.catalogGroupUnavailable")}
      <button type="button" onClick={retryCatalogRefresh}>
        {t("alpha.common.retry")}
      </button>
    </span>
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
